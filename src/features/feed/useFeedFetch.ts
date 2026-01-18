import { useCallback } from 'react';
import { Post, UserProfile, UserState } from '../../types';
import { fetchPostLocal, fetchUserStateChunk, fetchCidsBatched } from '../../api/ipfsIpns';
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess, markRequestPending } from '../../lib/fetchBackoff';

interface UseFeedFetchArgs {
    allPostsMap: Map<string, Post>;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    fetchMissingParentPost: (parentCID: string) => Promise<void>;
    allUserStatesMap?: Map<string, UserState>;
}

export const useFeedFetch = ({
    allPostsMap,
    setAllPostsMap,
    setUserProfilesMap,
    fetchMissingParentPost,
    allUserStatesMap
}: UseFeedFetchArgs) => {

    // Helper to parse cursor
    const parseCursor = (val: string | null) => {
        if (!val) return { cid: null, index: 0 };
        const parts = val.split('|');
        if (parts.length === 2) {
            return { cid: parts[0], index: parseInt(parts[1], 10) };
        }
        return { cid: val, index: 0 };
    };

    // Helper: Fetches a chunk of posts from a specific state CID
    const fetchStateAndPosts = useCallback(async (
        cursorValue: string, 
        authorIpns: string,
        isBackgroundRefresh: boolean = false
    ) => {
        try {
            const { cid: stateCid, index: startIndex } = parseCursor(cursorValue);
            if (!stateCid) return null;

            // Check backoff first
            if (shouldSkipRequest(stateCid)) {
                return null;
            }

            markRequestPending(stateCid);

            // OPTIMIZATION: Check allUserStatesMap first - use cached state if available
            let stateChunk: Partial<UserState> | null = null;
            if (allUserStatesMap?.has(authorIpns)) {
                const cachedState = allUserStatesMap.get(authorIpns)!;
                // If this CID matches the head of the cached state, use it
                // For now, we'll use cached state's postCIDs if available
                if (cachedState.postCIDs && cachedState.postCIDs.length > 0) {
                    stateChunk = {
                        profile: cachedState.profile,
                        postCIDs: cachedState.postCIDs,
                        extendedUserState: cachedState.extendedUserState,
                        updatedAt: cachedState.updatedAt
                    };
                    reportFetchSuccess(stateCid);
                }
            }

            // If not in cache, fetch from network
            if (!stateChunk) {
                try {
                    stateChunk = await fetchUserStateChunk(stateCid);
                    if (stateChunk) {
                        reportFetchSuccess(stateCid);
                    } else {
                        reportFetchFailure(stateCid);
                        return null;
                    }
                } catch (e: any) {
                    reportFetchFailure(stateCid);
                    // Check if it's a 504 or timeout error
                    if (e?.message?.includes('504') || e?.message?.includes('Gateway Timeout') || e?.message?.includes('timeout')) {
                        console.warn(`[Feed] Gateway timeout for ${stateCid}, will retry later via backoff`);
                    }
                    throw e;
                }
            }

            if (!stateChunk) return null;

            // 1. Update Profile (if found)
            if (stateChunk.profile) {
                setUserProfilesMap(prev => {
                    const existing = prev.get(authorIpns);
                    if (!existing || existing.name !== stateChunk.profile?.name) {
                        return new Map(prev).set(authorIpns, stateChunk.profile!);
                    }
                    return prev;
                });
            }

            // 2. Intra-Bucket Pagination
            // OPTIMIZATION: Larger PAGE_SIZE for initial loads to reduce recalculations
            const PAGE_SIZE = isBackgroundRefresh ? 1 : 3; // 3 for initial, 1 for background refresh 
            const allCids = stateChunk.postCIDs || [];
            
            const nextIndex = startIndex + PAGE_SIZE;
            const hasMoreInBucket = nextIndex < allCids.length;
            
            const postsToFetchCids = allCids.slice(startIndex, nextIndex);

            // Filter: Which posts do we actually need to fetch?
            const postsToFetch = postsToFetchCids.filter(pid => 
                isBackgroundRefresh || !allPostsMap.has(pid)
            );

            // BATCH FETCHING
            const results = await fetchCidsBatched(
                postsToFetch, 
                (cid) => fetchPostLocal(cid, authorIpns) as Promise<Post>,
                4 
            );

            // Process results
            const newPosts = new Map<string, Post>();
            results.forEach((p) => {
                if (p && p.id) {
                    if (!p.authorKey) p.authorKey = authorIpns;
                    newPosts.set(p.id, p);
                    if (p.referenceCID) fetchMissingParentPost(p.referenceCID);
                }
            });

            if (newPosts.size > 0) {
                setAllPostsMap(prev => new Map([...prev, ...newPosts]));
            }

            // Determine NEXT Cursor
            let nextCursor: string | null;
            
            if (hasMoreInBucket) {
                // Stay in same bucket, advance index
                nextCursor = `${stateCid}|${nextIndex}`;
            } else {
                // Move to next bucket (linked list)
                nextCursor = stateChunk.extendedUserState ? `${stateChunk.extendedUserState}|0` : null;
            }

            return { nextCursor, stateChunk };
        } catch (e) {
            console.warn(`[Feed] Failed to fetch state ${cursorValue}`, e);
            return null;
        }
    }, [allPostsMap, setAllPostsMap, setUserProfilesMap, fetchMissingParentPost, allUserStatesMap]);

    // Ensure Specific Posts (Updated with Batching)
    const ensurePostsAreFetched = useCallback(async (postCids: string[], authorHint?: string): Promise<string[]> => {
        const missing = postCids.filter(cid => !allPostsMap.has(cid));
        if (missing.length === 0) return [];

        const newPosts = new Map<string, Post>();
        
        // BATCH FETCHING: Prevent thread view crash
        const results = await fetchCidsBatched(
            missing,
            (cid) => fetchPostLocal(cid, authorHint || "Unknown") as Promise<Post>,
            4
        );

        const foundIds: string[] = [];
        results.forEach((post) => {
            if (post && post.id) {
                newPosts.set(post.id, post);
                foundIds.push(post.id);
            }
        });

        if (newPosts.size > 0) {
            setAllPostsMap(prev => new Map([...prev, ...newPosts]));
        }
        return foundIds;
    }, [allPostsMap, setAllPostsMap]);

    return {
        fetchStateAndPosts,
        ensurePostsAreFetched
    };
};
