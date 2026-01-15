// fileName: src/features/feed/useExploreFeed.ts
import { useState, useCallback, useRef } from 'react';
import { Post, UserProfile, UserState, OnlinePeer } from '../../types';
import { fetchPost, resolveIpns, fetchUserStateChunk } from '../../api/ipfsIpns';

const EXPLORE_CONCURRENCY_LIMIT = 3; 
const MAX_CRAWL_DEPTH = 2; // Friends of Friends only

function shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

interface UseAppExploreArgs {
    myIpnsKey: string;
    userState: UserState | null;
    allPostsMap: Map<string, Post>; 
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    fetchMissingParentPost: (parentCID: string) => Promise<void>;
    otherUsers: OnlinePeer[];
    enabled: boolean; // <--- NEW: Gate control
}

export interface UseAppExploreReturn {
    isLoadingExplore: boolean;
    loadMoreExplore: () => Promise<void>;
    refreshExploreFeed: () => Promise<void>;
    canLoadMoreExplore: boolean;
}

export const useAppExplore = ({
    myIpnsKey, 
    userState,
    allPostsMap, 
    setAllPostsMap,
    setUserProfilesMap,
    fetchMissingParentPost,
    otherUsers,
    enabled // <--- NEW
}: UseAppExploreArgs): UseAppExploreReturn => {

    const [isLoadingExplore, setIsLoadingExplore] = useState<boolean>(false);
    const [canLoadMoreExplore, setCanLoadMoreExplore] = useState<boolean>(true); 
    
    // Traversal State
    const processedFollowFetchKeys = useRef<Set<string>>(new Set());
    const currentBatchKeys = useRef<string[]>([]); 
    const nextLayerKeys = useRef<Set<string>>(new Set()); 
    const currentDepth = useRef<number>(0);

    const processKeysBatch = useCallback(async (keys: string[]) => {
        const results = await Promise.allSettled(keys.map(async (key) => {
            const stateCid = await resolveIpns(key);
            if (!stateCid) return null;

            const state = await fetchUserStateChunk(stateCid);
            if (!state) return null;

            if (state.profile) {
                setUserProfilesMap(prev => new Map(prev).set(key, state.profile!));
            }

            // Only queue new users if we haven't hit the depth limit and they are NOT blocked
            if (currentDepth.current < MAX_CRAWL_DEPTH && state.follows) {
                const blockedSet = new Set(userState?.blockedUsers || []);
                state.follows.forEach(f => {
                    if (f.ipnsKey && !processedFollowFetchKeys.current.has(f.ipnsKey) && !blockedSet.has(f.ipnsKey)) {
                        nextLayerKeys.current.add(f.ipnsKey);
                    }
                });
            }

            const newPosts: Post[] = [];
            if (state.postCIDs && state.postCIDs.length > 0) {
                // Fetch up to 5 posts
                const candidateCids = state.postCIDs.slice(0, 5);
                const cidsToFetch = candidateCids.filter(cid => !allPostsMap.has(cid));

                if (cidsToFetch.length > 0) {
                    const postPromises = cidsToFetch.map(async (cid) => {
                        try {
                            const postData = await fetchPost(cid);
                            if (postData && postData.id) {
                                if (!postData.authorKey) postData.authorKey = key;
                                return postData as Post;
                            }
                        } catch (e) { /* ignore */ }
                        return null;
                    });
                    const fetchedPosts = await Promise.all(postPromises);
                    fetchedPosts.forEach(p => { 
                        if(p) {
                            newPosts.push(p);
                            // If this post is a reply, we must fetch the parent(s) to display context
                            if (p.referenceCID) fetchMissingParentPost(p.referenceCID);
                        }
                    });
                }
            }
            return { key, state, newPosts };
        }));

        const fetchedPostsMap = new Map<string, Post>();
        results.forEach(res => {
            if (res.status === 'fulfilled' && res.value) {
                res.value.newPosts.forEach(p => fetchedPostsMap.set(p.id, p));
            }
        });

        if (fetchedPostsMap.size > 0) {
            setAllPostsMap(prev => new Map([...prev, ...fetchedPostsMap]));
            // We already triggered fetchMissingParentPost inside the map loop above for immediate reaction
        }
    }, [setAllPostsMap, setUserProfilesMap, fetchMissingParentPost, allPostsMap]);


    const loadMoreExplore = useCallback(async () => {
        // --- GATING LOGIC ---
        // Do not explore if the feature is disabled (e.g. core feed still loading)
        // or if we are already exploring.
        if (!enabled || isLoadingExplore) return;
        
        setIsLoadingExplore(true);

        try {
            // --- AUTO-SEEDING LOGIC ---
            if (currentBatchKeys.current.length === 0 && nextLayerKeys.current.size === 0) {
                 console.log("[Explore] Queue empty. Auto-seeding from network...");
                 currentDepth.current = 0; // Reset depth for new seed
                 
                 const myFollowKeys = (userState?.follows || []).map(f => f?.ipnsKey).filter(k => !!k);
                 const onlinePeerKeys = otherUsers.map(u => u.ipnsKey).filter(k => !!k);
                 const seedKeys = new Set([...myFollowKeys, ...onlinePeerKeys]);
                 if (myIpnsKey) seedKeys.add(myIpnsKey);
                 
                 // Remove blocked users from seeds
                 const blockedSet = new Set(userState?.blockedUsers || []);
                 const seeds = Array.from(seedKeys).filter(k => !processedFollowFetchKeys.current.has(k) && !blockedSet.has(k));
                 
                 if (seeds.length === 0) {
                     if (seedKeys.size > 0 && processedFollowFetchKeys.current.size > 0) {
                         console.log("[Explore] No new seeds available.");
                         setCanLoadMoreExplore(false);
                         return;
                     }
                     return;
                 }
                 
                 seeds.forEach(k => processedFollowFetchKeys.current.add(k));
                 currentBatchKeys.current = shuffleArray(seeds);
            }

            // If current batch empty, refill from next layer
            if (currentBatchKeys.current.length === 0) {
                if (nextLayerKeys.current.size > 0) {
                    // Moving to next generation
                    currentDepth.current += 1;
                    console.log(`[Explore] Advancing to Depth ${currentDepth.current}`);
                    
                    const nextBatch = Array.from(nextLayerKeys.current);
                    nextBatch.forEach(k => processedFollowFetchKeys.current.add(k));
                    currentBatchKeys.current = shuffleArray(nextBatch);
                    nextLayerKeys.current.clear();
                } else {
                    setCanLoadMoreExplore(false);
                    return;
                }
            }

            const batch = currentBatchKeys.current.splice(0, EXPLORE_CONCURRENCY_LIMIT);
            if (batch.length > 0) {
                 await processKeysBatch(batch);
            }
            
            setCanLoadMoreExplore(currentBatchKeys.current.length > 0 || nextLayerKeys.current.size > 0);

        } finally {
            setIsLoadingExplore(false);
        }

    }, [isLoadingExplore, processKeysBatch, userState, myIpnsKey, otherUsers, enabled]);


    const refreshExploreFeed = useCallback(async () => {
        if (!enabled) return; // Prevent refresh if disabled
        processedFollowFetchKeys.current.clear();
        currentBatchKeys.current = [];
        nextLayerKeys.current.clear();
        currentDepth.current = 0;
        setCanLoadMoreExplore(true);
        await loadMoreExplore(); 
    }, [loadMoreExplore, enabled]);

    return {
        isLoadingExplore,
        loadMoreExplore,
        refreshExploreFeed,
        canLoadMoreExplore
    };
};