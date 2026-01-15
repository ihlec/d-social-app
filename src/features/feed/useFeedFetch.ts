import { useCallback } from 'react';
import { Post, UserProfile } from '../../types';
import { fetchPostLocal, fetchUserStateChunk, fetchCidsBatched } from '../../api/ipfsIpns';

interface UseFeedFetchArgs {
    allPostsMap: Map<string, Post>;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    fetchMissingParentPost: (parentCID: string) => Promise<void>;
}

export const useFeedFetch = ({
    allPostsMap,
    setAllPostsMap,
    setUserProfilesMap,
    fetchMissingParentPost
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

            const stateChunk = await fetchUserStateChunk(stateCid);
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
            const PAGE_SIZE = 1; 
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
    }, [allPostsMap, setAllPostsMap, setUserProfilesMap, fetchMissingParentPost]);

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
