import { useCallback } from 'react';
import { Post, UserProfile, UserState } from '../../types';
import { fetchPostLocal, fetchUserStateChunk, fetchCidsBatched } from '../../api/ipfsIpns';
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess, markRequestPending } from '../../lib/fetchBackoff';
import * as contentCache from '../../lib/contentCache';

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

    const parseCursor = (val: string | null) => {
        if (!val) return { cid: null, index: 0 };
        const parts = val.split('|');
        if (parts.length === 2) {
            return { cid: parts[0], index: parseInt(parts[1], 10) };
        }
        return { cid: val, index: 0 };
    };

    const fetchStateAndPosts = useCallback(async (
        cursorValue: string, 
        authorIpns: string,
        isBackgroundRefresh: boolean = false
    ) => {
        try {
            const { cid: stateCid, index: startIndex } = parseCursor(cursorValue);
            if (!stateCid) return null;

            if (shouldSkipRequest(stateCid)) {
                return null;
            }

            markRequestPending(stateCid);

            let stateChunk: Partial<UserState> | null = null;
            if (allUserStatesMap?.has(authorIpns)) {
                const cachedState = allUserStatesMap.get(authorIpns)!;
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

            // IndexedDB user-state fallback before network
            if (!stateChunk) {
                const idbState = await contentCache.getUserState(authorIpns);
                if (idbState?.state?.postCIDs?.length) {
                    stateChunk = {
                        profile: idbState.state.profile,
                        postCIDs: idbState.state.postCIDs,
                        extendedUserState: idbState.state.extendedUserState,
                        updatedAt: idbState.state.updatedAt
                    };
                    reportFetchSuccess(stateCid);
                }
            }

            if (!stateChunk) {
                try {
                    stateChunk = await fetchUserStateChunk(stateCid, authorIpns);
                    if (stateChunk) {
                        reportFetchSuccess(stateCid);
                        // Persist a partial state for hydrate
                        contentCache.putUserState(authorIpns, {
                            profile: stateChunk.profile || { name: authorIpns },
                            postCIDs: stateChunk.postCIDs || [],
                            follows: stateChunk.follows || [],
                            likedPostCIDs: stateChunk.likedPostCIDs || [],
                            dislikedPostCIDs: stateChunk.dislikedPostCIDs || [],
                            savedPostCIDs: stateChunk.savedPostCIDs || [],
                            blockedUsers: stateChunk.blockedUsers || [],
                            updatedAt: stateChunk.updatedAt || 0,
                            extendedUserState: stateChunk.extendedUserState || null,
                        }, stateCid).catch(() => {});
                    } else {
                        reportFetchFailure(stateCid);
                        return null;
                    }
                } catch (e: any) {
                    reportFetchFailure(stateCid);
                    if (e?.message?.includes('504') || e?.message?.includes('Gateway Timeout') || e?.message?.includes('timeout')) {
                        console.warn(`[Feed] Gateway timeout for ${stateCid}, will retry later via backoff`);
                    }
                    throw e;
                }
            }

            if (!stateChunk) return null;

            if (stateChunk.profile) {
                setUserProfilesMap(prev => {
                    const existing = prev.get(authorIpns);
                    if (!existing || existing.name !== stateChunk.profile?.name) {
                        return new Map(prev).set(authorIpns, stateChunk.profile!);
                    }
                    return prev;
                });
            }

            const PAGE_SIZE = isBackgroundRefresh ? 1 : 3;
            const allCids = stateChunk.postCIDs || [];
            
            const nextIndex = startIndex + PAGE_SIZE;
            const hasMoreInBucket = nextIndex < allCids.length;
            
            const postsToFetchCids = allCids.slice(startIndex, nextIndex);

            const postsToFetch = postsToFetchCids.filter(pid => 
                isBackgroundRefresh || !allPostsMap.has(pid)
            );

            // Prefer IndexedDB for missing posts before network
            const fromIdb = await contentCache.getPosts(postsToFetch);
            const stillMissing = postsToFetch.filter(cid => !fromIdb.has(cid));

            const results = await fetchCidsBatched(
                stillMissing, 
                (cid) => fetchPostLocal(cid, authorIpns),
                4 
            );

            const newPosts = new Map<string, Post>(fromIdb);
            results.forEach((p) => {
                if (p && p.id && p.timestamp !== 0) {
                    if (!p.authorKey) p.authorKey = authorIpns;
                    newPosts.set(p.id, p);
                    if (p.referenceCID) fetchMissingParentPost(p.referenceCID);
                }
            });

            if (newPosts.size > 0) {
                setAllPostsMap(prev => new Map([...prev, ...newPosts]));
                contentCache.putPosts(Array.from(newPosts.values())).catch(() => {});
            }

            let nextCursor: string | null;
            
            if (hasMoreInBucket) {
                nextCursor = `${stateCid}|${nextIndex}`;
            } else {
                nextCursor = stateChunk.extendedUserState ? `${stateChunk.extendedUserState}|0` : null;
            }

            return { nextCursor, stateChunk };
        } catch (e) {
            console.warn(`[Feed] Failed to fetch state ${cursorValue}`, e);
            return null;
        }
    }, [allPostsMap, setAllPostsMap, setUserProfilesMap, fetchMissingParentPost, allUserStatesMap]);

    const ensurePostsAreFetched = useCallback(async (postCids: string[], authorHint?: string): Promise<string[]> => {
        const missing = postCids.filter(cid => !allPostsMap.has(cid));
        if (missing.length === 0) return [];

        const fromIdb = await contentCache.getPosts(missing);
        const stillMissing = missing.filter(cid => !fromIdb.has(cid));

        const newPosts = new Map<string, Post>(fromIdb);
        
        const results = await fetchCidsBatched(
            stillMissing,
            (cid) => fetchPostLocal(cid, authorHint || ''),
            4
        );

        const foundIds: string[] = [];
        fromIdb.forEach((post, id) => {
            foundIds.push(id);
            if (post.referenceCID) fetchMissingParentPost(post.referenceCID);
        });
        results.forEach((post) => {
            if (post && post.id && post.timestamp !== 0) {
                newPosts.set(post.id, post);
                foundIds.push(post.id);
                if (post.referenceCID) fetchMissingParentPost(post.referenceCID);
            }
        });

        if (newPosts.size > 0) {
            setAllPostsMap(prev => new Map([...prev, ...newPosts]));
            contentCache.putPosts(Array.from(newPosts.values())).catch(() => {});
        }
        return foundIds;
    }, [allPostsMap, setAllPostsMap, fetchMissingParentPost]);

    return {
        fetchStateAndPosts,
        ensurePostsAreFetched
    };
};
