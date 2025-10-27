// src/hooks/useAppFeed.ts
import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Post, UserProfile, Follow, UserState } from '../../types';
import { fetchPost, fetchUserState, fetchPostLocal } from '../../api/ipfsIpns';
import { fetchUserStateByIpns } from './../../state/stateActions';

const MAX_FOLLOWS_PER_STATE = 10;
const IPNS_FETCH_TIMEOUT_MS = 5000; // 5 seconds

interface UseAppFeedArgs {
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	setUnresolvedFollows: React.Dispatch<React.SetStateAction<string[]>>;
	fetchMissingParentPost: (parentCID: string) => Promise<void>;
}

export interface UseAppFeedReturn {
    isLoadingFeed: boolean;
    processMainFeed: (currentState: UserState, myIpnsKey: string) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
}

export const useAppFeed = ({
	allPostsMap,
	userProfilesMap,
	setAllPostsMap,
	setUserProfilesMap,
	setUnresolvedFollows,
	fetchMissingParentPost,
}: UseAppFeedArgs): UseAppFeedReturn => {

	const [isLoadingFeed, setIsLoadingFeed] = useState<boolean>(false);

	const processFollowBatch = useCallback(async (
        batch: Follow[],
        onPostsReceived: (posts: Map<string, Post>) => void,
        onProfilesReceived: (profiles: Map<string, UserProfile>) => void,
        onUnresolvedReceived: (keys: string[]) => void
	): Promise<void> => {
        const profiles = new Map<string, UserProfile>(); const unresolved: string[] = []; const postFetchPromises: Promise<void>[] = []; const parentCIDsToFetch = new Set<string>();
        const localPostsForBatch = new Map<string, Post>();

		await Promise.all(batch.map(async (f) => {
			try {
                let state: UserState;
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('IPNS_TIMEOUT')), IPNS_FETCH_TIMEOUT_MS));
                const freshFetchPromise = fetchUserStateByIpns(f.ipnsKey);
                try {
                    const { state: freshState } = await Promise.race([ freshFetchPromise, timeoutPromise as Promise<{ state: UserState, cid: string }> ]);
                    state = freshState;
                } catch (e) {
                    if (e instanceof Error && e.message === 'IPNS_TIMEOUT') {
                        console.warn(`[processFollowBatch] IPNS resolve for ${f.ipnsKey} timed out. Falling back to lastSeenCid: ${f.lastSeenCid}`);
                        if (f.lastSeenCid) { state = await fetchUserState(f.lastSeenCid, f.name); }
                        else { throw new Error(`IPNS timeout for ${f.ipnsKey} with no fallback CID.`); }
                    } else { throw e; }
                }
                if (state.profile) profiles.set(f.ipnsKey, state.profile);
				(state.postCIDs || []).filter(pc => pc && !pc.startsWith('temp-')).forEach((pc: string) => {
                    postFetchPromises.push( (async () => { 
                        try {
                            const existingPost = allPostsMap.get(pc);
                            if (existingPost) {
                                if (existingPost.timestamp !== 0) {
                                    if (!localPostsForBatch.has(pc)) localPostsForBatch.set(pc, existingPost);
                                }
                                return; 
                            }
                
                            if (localPostsForBatch.has(pc)) {
                                return;
                            }
                
                            const postResult = await fetchPostLocal(pc, f.ipnsKey);
                
                            if (postResult.timestamp !== 0) {
                                const finalPost = { ...postResult, authorKey: f.ipnsKey, id: pc };
                                localPostsForBatch.set(pc, finalPost);
                                
                                if (finalPost.referenceCID) {
                                    if (!allPostsMap.has(finalPost.referenceCID) && !localPostsForBatch.has(finalPost.referenceCID)) {
                                       parentCIDsToFetch.add(finalPost.referenceCID);
                                    }
                                }
                            } else {
                                 console.log(`[processFollowBatch] fetchPostLocal returned placeholder for ${pc.substring(0, 10)}... (author ${f.ipnsKey.substring(0,6)}...), skipping.`);
                            }
                        
                        } catch (e) { 
                            console.warn(`[processFollowBatch] Error processing post ${pc} for ${f.ipnsKey}:`, e); 
                        }
                    })() );
				});
			} catch (e) { console.warn(`Failed process follow ${f.name || f.ipnsKey}`, e); unresolved.push(f.ipnsKey); }
		}));
		if (profiles.size > 0) onProfilesReceived(profiles); if (unresolved.length > 0) onUnresolvedReceived(unresolved);
        
        await Promise.allSettled(postFetchPromises);
        
        if (parentCIDsToFetch.size > 0) { console.log(`[processFollowBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`); const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) ); await Promise.allSettled(parentFetchPromises); }

        if (localPostsForBatch.size > 0) {
            onPostsReceived(localPostsForBatch);
        }
	}, [fetchUserStateByIpns, allPostsMap, fetchMissingParentPost]);

    // --- START MODIFICATION: Revert to parallel promise-pushing pattern ---
    const lazyLoadFeed = useCallback(async (
        myIpnsKey: string,
        ownCidsToLazyFetch: string[], 
        follows: Follow[]
    ) => {
        const processId = Date.now();
        console.log(`[lazyLoadFeed ${processId}] STAGE 2 (Lazy) Start. Fetching ${ownCidsToLazyFetch.length} own posts and ${follows.length} follows.`);
        
        const allLazyPromises: Promise<any>[] = [];
        let collectedUnresolved: string[] = [];

        // --- 1. Create promises for Missing Own Posts (Lazy) ---
        for (const cid of ownCidsToLazyFetch) {
            allLazyPromises.push(
                (async () => {
                    console.log(`[lazyLoadFeed ${processId}] Fetching lazy own post ${cid.substring(0, 10)}...`);
                    const postResult = await fetchPostLocal(cid, myIpnsKey); // This will time out on its own
                    let finalPost: Post | null = null;

                    if (postResult.timestamp !== 0) {
                        finalPost = { ...postResult, authorKey: myIpnsKey, id: cid };
                        // Update state immediately as it resolves
                        setAllPostsMap(prev => new Map(prev).set(cid, finalPost!)); 
                    } else {
                        console.log(`[lazyLoadFeed ${processId}] fetchPostLocal returned placeholder for ${cid.substring(0, 10)}..., skipping add.`);
                        // --- Also add the placeholder to the map so we don't try to fetch it again ---
                        setAllPostsMap(prev => new Map(prev).set(cid, postResult));
                    }

                    // If it was a real post and has a missing parent, fetch it (this can block this single promise, which is fine)
                    if (finalPost && finalPost.referenceCID && !allPostsMap.has(finalPost.referenceCID)) {
                        await fetchMissingParentPost(finalPost.referenceCID);
                    }
                })()
            );
        }
        console.log(`[lazyLoadFeed ${processId}] Created ${ownCidsToLazyFetch.length} promises for own posts.`);

        // --- 2. Create promises for Followed Posts (Lazy) ---
        if (follows.length > 0) {
            console.log(`[lazyLoadFeed ${processId}] Creating promises for ${follows.length} follows in batches...`);
            
            for (let i = 0; i < follows.length; i += MAX_FOLLOWS_PER_STATE) {
                allLazyPromises.push(processFollowBatch(
                    follows.slice(i, i + MAX_FOLLOWS_PER_STATE),
                    (posts: Map<string, Post>) => {
                        console.log(`[lazyLoadFeed ${processId}] Applying ${posts.size} posts from follow batch.`);
                        setAllPostsMap(prev => new Map([...prev, ...posts]));
                    },
                    (pr: Map<string, UserProfile>) => {
                        console.log(`[lazyLoadFeed ${processId}] Applying ${pr.size} profiles from follow batch.`);
                        setUserProfilesMap(prev => new Map([...prev, ...pr]));
                    },
                    (un: string[]) => {
                        collectedUnresolved = [...new Set([...collectedUnresolved, ...un])];
                    }
                ));
            }
        }
        // --- END MODIFICATION ---

        try {
            // --- Await all parallel promises ---
            console.log(`[lazyLoadFeed ${processId}] Awaiting ${allLazyPromises.length} total lazy promises...`);
            await Promise.allSettled(allLazyPromises);
            
            console.log(`[lazyLoadFeed ${processId}] All lazy promises settled.`);
            setUnresolvedFollows(collectedUnresolved); // Final update for unresolved
        } catch (e) {
            console.error(`[lazyLoadFeed ${processId}] Unexpected error in lazy follow processing:`, e);
        } finally {
            console.log(`[lazyLoadFeed ${processId}] Finished Stage 2 (lazy).`);
        }
    }, [allPostsMap, processFollowBatch, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost]);

	const processMainFeed = useCallback(async (currentState: UserState, myIpnsKey: string) => {
        const processId = Date.now();
        console.log(`[processMainFeed ${processId}] Start processing.`);

        if (!currentState?.profile || !myIpnsKey) { console.warn(`[processMainFeed ${processId}] Invalid state or missing key, skipping.`); return; }
        if (isLoadingFeed) {
             console.warn(`[processMainFeed ${processId}] Already loading feed, skipping.`);
             return;
        }

        // --- START STAGE 1: Immediate Render (Synchronous-like) ---
        setIsLoadingFeed(true);
        console.log(`[processMainFeed ${processId}] Set isLoadingFeed = true.`);

        const postsForImmediateRender = new Map<string, Post>();
        const profilesForImmediateRender = new Map<string, UserProfile>([[myIpnsKey, currentState.profile!]]);
        const ownCidsToLazyFetch: string[] = [];
        
        const follows = currentState.follows || [];
        const dislikedSet = new Set(currentState.dislikedPostCIDs || []);
        const allOwnCIDs = (currentState.postCIDs || []).filter(c => c && !c.startsWith('temp-'));
        const ownCIDsToFetch = allOwnCIDs.filter(cid => !dislikedSet.has(cid));
        
        console.log(`[processMainFeed ${processId}] STAGE 1: Sorting ${ownCIDsToFetch.length} own posts.`);

        // Sort CIDs into "immediate" and "lazy"
        for (const cid of ownCIDsToFetch) {
            const existingPost = allPostsMap.get(cid);
            if (existingPost && existingPost.timestamp !== 0) {
                // It's in the cache and not a placeholder, render it now
                postsForImmediateRender.set(cid, existingPost);
            } else if (!existingPost) {
                // Not in cache, fetch it lazily
                ownCidsToLazyFetch.push(cid);
            } else if (existingPost && existingPost.timestamp === 0) {
                // It's in the cache *as a placeholder*, render it now
                postsForImmediateRender.set(cid, existingPost);
            }
        }
        
        console.log(`[processMainFeed ${processId}] STAGE 1: Immediate render: ${postsForImmediateRender.size} posts. Lazy fetch: ${ownCidsToLazyFetch.length} posts.`);

        // --- FIRST STATE UPDATE (Immediate) ---
        setAllPostsMap(prev => new Map([...prev, ...postsForImmediateRender]));
        setUserProfilesMap(prev => new Map([...prev, ...profilesForImmediateRender]));
        
        setIsLoadingFeed(false);
        console.log(`[processMainFeed ${processId}] Finished Stage 1. Set isLoadingFeed = false.`);
        toast.success("Feed refreshed!");
        // --- END STAGE 1 ---


        // --- START STAGE 2: Kick off lazy loading (Non-blocking) ---
        // This runs in the background *after* the UI has updated
        lazyLoadFeed(myIpnsKey, ownCidsToLazyFetch, follows);
        // --- END STAGE 2 ---

	}, [ isLoadingFeed, lazyLoadFeed, allPostsMap ]); // Updated dependencies


	const ensurePostsAreFetched = useCallback(async (cidsToFetch: string[], authorHint?: string) => {
        if (isLoadingFeed) { console.warn("[ensurePostsAreFetched] Feed is loading, skipping."); return; }
        
        const missingCids = cidsToFetch.filter(cid => cid && !cid.startsWith('temp-') && !allPostsMap.has(cid));
        if (missingCids.length === 0) return;

        console.log(`[ensurePostsAreFetched] Found ${missingCids.length} missing posts. Fetching with hint: '${authorHint}'...`, missingCids);
        
        const fetchedPosts = new Map<string, Post>();
        const fetchedProfiles = new Map<string, UserProfile>();

        const fetchPromises = missingCids.map(async (cid: string) => {
             try {
                const post = await fetchPostLocal(cid, authorHint || 'unknown');

                if (!post) { 
                    console.warn(`[ensurePostsAreFetched] fetchPostLocal returned null/undefined for ${cid}`);
                    return;
                }

                fetchedPosts.set(cid, { ...post, id: cid });

                if (post.authorKey && post.authorKey !== 'unknown' && post.timestamp !== 0) {
                    if (!userProfilesMap.has(post.authorKey) && !fetchedProfiles.has(post.authorKey)) {
                        try {
                            const { state: authorState } = await fetchUserStateByIpns(post.authorKey);
                            if (authorState?.profile) {
                                fetchedProfiles.set(post.authorKey, authorState.profile);
                            } else {
                                fetchedProfiles.set(post.authorKey, { name: `Unknown (${post.authorKey.substring(0, 6)}...)` });
                            }
                        } catch (profileError) {
                            console.warn(`[ensurePostsAreFetched] Failed to fetch profile for ${post.authorKey}:`, profileError);
                             fetchedProfiles.set(post.authorKey, { name: `Unknown (${post.authorKey.substring(0, 6)}...)` });
                        }
                    }
                }
             } catch (error) {
                console.error(`[ensurePostsAreFetched] Failed to process post ${cid}:`, error);
                fetchedPosts.set(cid, { id: cid, authorKey: authorHint || 'unknown', content: '[Error loading content]', timestamp: 0, replies: [] });
             }
        });

        await Promise.allSettled(fetchPromises);

        if (fetchedPosts.size > 0 || fetchedProfiles.size > 0) {
            setAllPostsMap((prev) => {
                const newMap = new Map(prev);
                fetchedPosts.forEach((post, cid) => {
                    if (!prev.has(cid)) { 
                        newMap.set(cid, post);
                    }
                });
                return newMap;
            });
            setUserProfilesMap((prev) => new Map([...prev, ...fetchedProfiles]));
        }
        console.log(`[ensurePostsAreFetched] Finished processing ${fetchedPosts.size} posts (including placeholders).`);
	}, [ allPostsMap, userProfilesMap, setUserProfilesMap, setAllPostsMap, isLoadingFeed ]);


	return {
		isLoadingFeed,
		processMainFeed,
		ensurePostsAreFetched
	};
};