// fileName: src/hooks/useSharedPostFetcher.ts
import { useCallback, useRef } from 'react';
import { Post, UserProfile } from '../types';
// UPDATED IMPORTS: Removed ensureBlockLocal
import { fetchPost, resolveIpns, fetchUserState } from '../api/ipfsIpns'; 
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess } from '../lib/fetchBackoff';

interface SharedFetcherArgs {
    allPostsMap: Map<string, Post>;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    userProfilesMap?: Map<string, UserProfile>;
    setUserProfilesMap?: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
}

export const useSharedPostFetcher = ({
    allPostsMap,
    setAllPostsMap,
}: SharedFetcherArgs) => {
    
    // --- CHANGED: Aggressive Pre-Fetch Removed ---
    // We strictly follow the "Explicit Archival" model. 
    // Media is only downloaded to the local node when the user explicitly "Likes" the post.
    // Display is handled via Public Gateways.

    const fetchMissingParentPost = useCallback(async (parentCID: string) => {
        if (!parentCID || allPostsMap.has(parentCID)) return;
        if (shouldSkipRequest(parentCID)) return;

        try {
            const postData = await fetchPost(parentCID);
            if (postData && postData.id) {
                setAllPostsMap(prev => new Map(prev).set(postData.id, postData as Post));
                reportFetchSuccess(parentCID);
            } else {
                reportFetchFailure(parentCID);
            }
        } catch (e) {
            reportFetchFailure(parentCID);
        }
    }, [allPostsMap, setAllPostsMap]);

    const ensurePostsAreFetched = useCallback(async (postCids: string[], authorHint?: string) => {
        const missingCids = postCids.filter(cid => !allPostsMap.has(cid) && !shouldSkipRequest(cid));
        if (missingCids.length === 0) return;

        // Fetch concurrently
        const promises = missingCids.map(async (cid) => {
            try {
                const post = await fetchPost(cid);
                if (post) {
                    if (authorHint && !post.authorKey) {
                        post.authorKey = authorHint;
                    }
                    reportFetchSuccess(cid);
                    return post;
                }
            } catch (e) {
                reportFetchFailure(cid);
            }
            return null;
        });

        const results = await Promise.all(promises);
        const newPosts: Post[] = results.filter((p): p is Post => !!p);

        if (newPosts.length > 0) {
            setAllPostsMap(prev => {
                const next = new Map(prev);
                newPosts.forEach(p => next.set(p.id, p));
                return next;
            });
            
            newPosts.forEach(p => {
                if (p.referenceCID) fetchMissingParentPost(p.referenceCID);
            });
        }
    }, [allPostsMap, setAllPostsMap, fetchMissingParentPost]);

    return { fetchMissingParentPost, ensurePostsAreFetched };
};

// ... (useParentPostFetcher cleaned up)
export const useParentPostFetcher = ({
    allPostsMap,
    setAllPostsMap,
    userProfilesMap,
    setUserProfilesMap
}: SharedFetcherArgs & { userProfilesMap: Map<string, UserProfile>; setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>> }) => {

    const pendingRequests = useRef<Set<string>>(new Set());

    const fetchMissingParentPost = useCallback(async (parentCID: string) => {
        if (!parentCID || allPostsMap.has(parentCID)) return;
        if (pendingRequests.current.has(parentCID)) return;
        if (shouldSkipRequest(parentCID)) return;

        pendingRequests.current.add(parentCID);

        try {
            const postData = await fetchPost(parentCID);
            if (postData && postData.id) {
                setAllPostsMap(prev => new Map(prev).set(postData.id, postData as Post));
                reportFetchSuccess(parentCID);

                // Fetch Author Profile if unknown
                const authorKey = postData.authorKey;
                if (authorKey && !userProfilesMap.has(authorKey)) {
                     try {
                        const profileCid = await resolveIpns(authorKey);
                        if (profileCid) {
                            const state = await fetchUserState(profileCid, authorKey);
                            if (state.profile) {
                                setUserProfilesMap(prev => new Map(prev).set(authorKey, state.profile));
                            }
                        }
                     } catch {}
                }
            } else {
                reportFetchFailure(parentCID);
            }
        } catch (e) {
            reportFetchFailure(parentCID);
        } finally {
            pendingRequests.current.delete(parentCID);
        }
    }, [allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap]);

    return { fetchMissingParentPost };
};