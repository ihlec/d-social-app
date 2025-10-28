// src/hooks/useAppFeed.ts
import { useState, useCallback, useMemo } from 'react'; // --- ADDED useMemo ---
import toast from 'react-hot-toast';
import { Post, UserProfile, Follow, UserState } from '../../types';
// --- START MODIFICATION: Import chunk fetcher ---
import { fetchUserState, fetchPostLocal, resolveIpns, fetchUserStateChunk } from '../../api/ipfsIpns';
// --- END MODIFICATION ---
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
    // --- START MODIFICATION: Add cursor state ---
    followCursors: Map<string, string | null>;
    setFollowCursors: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
    // --- END MODIFICATION ---
}

export interface UseAppFeedReturn {
    isLoadingFeed: boolean;
    processMainFeed: (currentState: UserState, myIpnsKey: string) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
    // --- START MODIFICATION: Add new exports ---
    loadMoreMyFeed: () => Promise<void>;
    canLoadMoreMyFeed: boolean;
    // --- END MODIFICATION ---
}

export const useAppFeed = ({
	allPostsMap,
	userProfilesMap,
	setAllPostsMap,
	setUserProfilesMap,
	setUnresolvedFollows,
	fetchMissingParentPost,
    // --- START MODIFICATION: Add cursor state ---
    followCursors,
    setFollowCursors,
    // --- END MODIFICATION ---
}: UseAppFeedArgs): UseAppFeedReturn => {

	const [isLoadingFeed, setIsLoadingFeed] = useState<boolean>(false);

    // --- START MODIFICATION: New: Batch processor for subsequent chunks ---
    const processChunkBatch = useCallback(async (
        chunksToFetch: Map<string, string>, // Map<ipnsKey, chunkCid>
        onPostsReceived: (posts: Map<string, Post>) => void,
        onCursorsReceived: (cursors: Map<string, string | null>) => void
    ): Promise<void> => {
        const newCursors = new Map<string, string | null>();
        const postFetchPromises: Promise<void>[] = [];
        const parentCIDsToFetch = new Set<string>();
        const localPostsForBatch = new Map<string, Post>();

        await Promise.all(Array.from(chunksToFetch.entries()).map(async ([ipnsKey, chunkCid]) => {
            try {
                // 1. Fetch the specific chunk
                const chunk = await fetchUserStateChunk(chunkCid);

                // 2. Save the next cursor
                newCursors.set(ipnsKey, chunk.extendedUserState || null);

                // 3. Create promises to fetch all posts from this chunk
                (chunk.postCIDs || []).filter(pc => pc && !pc.startsWith('temp-')).forEach((pc: string) => {
                    postFetchPromises.push( (async () => {
                        try {
                            if (allPostsMap.has(pc) || localPostsForBatch.has(pc)) return;

                            const postResult = await fetchPostLocal(pc, ipnsKey);

                            if (postResult.timestamp !== 0) {
                                const finalPost = { ...postResult, authorKey: ipnsKey, id: pc };
                                localPostsForBatch.set(pc, finalPost);

                                if (finalPost.referenceCID && !allPostsMap.has(finalPost.referenceCID) && !localPostsForBatch.has(finalPost.referenceCID)) {
                                   parentCIDsToFetch.add(finalPost.referenceCID);
                                }
                            } else {
                                 console.log(`[processChunkBatch] fetchPostLocal returned placeholder for ${pc.substring(0, 10)}... (author ${ipnsKey.substring(0,6)}...), skipping.`);
                            }

                        } catch (e) {
                            console.warn(`[processChunkBatch] Error processing post ${pc} for ${ipnsKey}:`, e);
                        }
                    })() );
                });
            } catch (e) {
                console.warn(`Failed to process chunk ${chunkCid} for follow ${ipnsKey}`, e);
                // If fetching the chunk fails, mark it as 'done' (null) to prevent retries
                newCursors.set(ipnsKey, null);
            }
        }));

        if (newCursors.size > 0) onCursorsReceived(newCursors);

        await Promise.allSettled(postFetchPromises);

        if (parentCIDsToFetch.size > 0) {
            console.log(`[processChunkBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`);
            const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) );
            await Promise.allSettled(parentFetchPromises);
        }

        if (localPostsForBatch.size > 0) {
            onPostsReceived(localPostsForBatch);
        }
    }, [allPostsMap, fetchMissingParentPost]);
    // --- END MODIFICATION ---


	const processFollowBatch = useCallback(async (
        batch: Follow[],
        onPostsReceived: (posts: Map<string, Post>) => void,
        onProfilesReceived: (profiles: Map<string, UserProfile>) => void,
        onUnresolvedReceived: (keys: string[]) => void,
        // --- START MODIFICATION: Add cursor callback ---
        onCursorsReceived: (cursors: Map<string, string | null>) => void
        // --- END MODIFICATION ---
	): Promise<void> => {
        const profiles = new Map<string, UserProfile>();
        const unresolved: string[] = [];
        const postFetchPromises: Promise<void>[] = [];
        const parentCIDsToFetch = new Set<string>();
        const localPostsForBatch = new Map<string, Post>();
        // --- START MODIFICATION: Add cursor collector ---
        const newCursors = new Map<string, string | null>();
        // --- END MODIFICATION ---

		await Promise.all(batch.map(async (f) => {
			try {
                // --- START MODIFICATION: Fetch HEAD CHUNK only ---
                let state: Partial<UserState>; // Use Partial<UserState> as it's just a chunk
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('IPNS_TIMEOUT')), IPNS_FETCH_TIMEOUT_MS));

                // New fetch logic: resolve IPNS, then fetch chunk
                const freshFetchPromise = (async () => {
                    const headCid = await resolveIpns(f.ipnsKey);
                    // Check fallback
                    if (!headCid && f.lastSeenCid) {
                         console.warn(`[processFollowBatch] IPNS resolve for ${f.ipnsKey} failed. Falling back to lastSeenCid: ${f.lastSeenCid}`);
                         return await fetchUserStateChunk(f.lastSeenCid);
                    } else if (!headCid) {
                        throw new Error(`IPNS resolve failed for ${f.ipnsKey} with no fallback CID.`);
                    }
                    return await fetchUserStateChunk(headCid);
                })();

                try {
                    state = await Promise.race([ freshFetchPromise, timeoutPromise as Promise<Partial<UserState>> ]);
                } catch (e) {
                    if (e instanceof Error && e.message === 'IPNS_TIMEOUT') {
                        console.warn(`[processFollowBatch] IPNS resolve/chunk fetch for ${f.ipnsKey} timed out. Falling back to lastSeenCid: ${f.lastSeenCid}`);
                        if (f.lastSeenCid) {
                            state = await fetchUserStateChunk(f.lastSeenCid);
                        }
                        else { throw new Error(`IPNS timeout for ${f.ipnsKey} with no fallback CID.`); }
                    } else { throw e; }
                }
                // --- END MODIFICATION ---

                if (state.profile) profiles.set(f.ipnsKey, state.profile);
                // --- START MODIFICATION: Save the next chunk's CID (cursor) ---
                newCursors.set(f.ipnsKey, state.extendedUserState || null); // null means 'done'
                // --- END MODIFICATION ---

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
		if (profiles.size > 0) onProfilesReceived(profiles);
        if (unresolved.length > 0) onUnresolvedReceived(unresolved);
        // --- START MODIFICATION: Report new cursors ---
        if (newCursors.size > 0) onCursorsReceived(newCursors);
        // --- END MODIFICATION ---

        await Promise.allSettled(postFetchPromises);

        if (parentCIDsToFetch.size > 0) { console.log(`[processFollowBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`); const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) ); await Promise.allSettled(parentFetchPromises); }

        if (localPostsForBatch.size > 0) {
            onPostsReceived(localPostsForBatch);
        }
	}, [allPostsMap, fetchMissingParentPost]); // --- REMOVED: fetchUserStateByIpns ---

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
        // --- START MODIFICATION: Add cursor collector ---
        let collectedCursors = new Map<string, string | null>();
        // --- END MODIFICATION ---

        // --- 1. Create promises for Missing Own Posts (Lazy) ---
        // (This logic remains the same)
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
                    },
                    // --- START MODIFICATION: Collect cursors ---
                    (cu: Map<string, string | null>) => {
                        collectedCursors = new Map([...collectedCursors, ...cu]);
                    }
                    // --- END MODIFICATION ---
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
            // --- START MODIFICATION: Set collected cursors ---
            setFollowCursors(prevCursors => new Map([...prevCursors, ...collectedCursors])); // Merge with existing
            console.log(`[lazyLoadFeed ${processId}] Merged ${collectedCursors.size} follow cursors.`);
            // --- END MODIFICATION ---
        } catch (e) {
            console.error(`[lazyLoadFeed ${processId}] Unexpected error in lazy follow processing:`, e);
        } finally {
            console.log(`[lazyLoadFeed ${processId}] Finished Stage 2 (lazy).`);
        }
    }, [allPostsMap, processFollowBatch, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost, setFollowCursors]); // --- Added setFollowCursors ---

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

        // --- START MODIFICATION: Fetch HEAD CHUNK CIDs only ---
        // We only use the head chunk for the user's own posts for immediate render
        const allOwnCIDs = (currentState.postCIDs || []).filter(c => c && !c.startsWith('temp-'));
        const ownCIDsToFetch = allOwnCIDs.filter(cid => !dislikedSet.has(cid));
        // --- END MODIFICATION ---

        console.log(`[processMainFeed ${processId}] STAGE 1: Sorting ${ownCIDsToFetch.length} own posts (from head chunk).`);

        // Sort CIDs into "immediate" and "lazy"
        for (const cid of ownCIDsToFetch) {
            const existingPost = allPostsMap.get(cid);
            if (existingPost && existingPost.timestamp !== 0) {
                // It's in the cache and not a placeholder, render it now
                postsForImmediateRender.set(cid, existingPost);
            } else if (!existingPost || existingPost.timestamp === 0) { // Also fetch if placeholder
                // Not in cache or is placeholder, fetch it lazily
                ownCidsToLazyFetch.push(cid);
                 // If it's a placeholder, render it immediately too
                 if (existingPost) {
                     postsForImmediateRender.set(cid, existingPost);
                 }
            }
        }

        console.log(`[processMainFeed ${processId}] STAGE 1: Immediate render: ${postsForImmediateRender.size} posts. Lazy fetch: ${ownCidsToLazyFetch.length} posts.`);

        // --- FIRST STATE UPDATE (Immediate) ---
        setAllPostsMap(prev => new Map([...prev, ...postsForImmediateRender]));
        setUserProfilesMap(prev => new Map([...prev, ...profilesForImmediateRender]));

        setIsLoadingFeed(false);
        console.log(`[processMainFeed ${processId}] Finished Stage 1. Set isLoadingFeed = false.`);
        if (!isLoadingFeed) toast.success("Feed refreshed!"); // Avoid double toast if already loading
        // --- END STAGE 1 ---


        // --- START STAGE 2: Kick off lazy loading (Non-blocking) ---
        // This runs in the background *after* the UI has updated
        // --- START MODIFICATION: Pass user's next chunk CID ---
        const ownNextChunkCid = currentState.extendedUserState;
        setFollowCursors(new Map(ownNextChunkCid ? [[myIpnsKey, ownNextChunkCid]] : []));
        lazyLoadFeed(myIpnsKey, ownCidsToLazyFetch, follows);
        // --- END MODIFICATION ---
        // --- END STAGE 2 ---

	}, [ isLoadingFeed, lazyLoadFeed, allPostsMap, setFollowCursors, setAllPostsMap, setUserProfilesMap ]); // Updated dependencies


	const ensurePostsAreFetched = useCallback(async (cidsToFetch: string[], authorHint?: string) => {
        // --- START MODIFICATION: Logic to handle placeholders ---
        if (isLoadingFeed && !cidsToFetch.some(cid => allPostsMap.has(cid) && allPostsMap.get(cid)?.timestamp === 0)) {
            // Skip if loading unless we are specifically trying to update placeholders
            console.warn("[ensurePostsAreFetched] Feed is loading, skipping non-placeholder fetch.");
            return;
        }

        // Filter out temporary IDs and CIDs already present *as actual posts*
        const cidsToCheck = cidsToFetch.filter(cid => {
            if (!cid || cid.startsWith('temp-')) return false;
            const existingPost = allPostsMap.get(cid);
            // Keep the CID if it's missing OR if it exists but is a placeholder (timestamp 0)
            return !existingPost || existingPost.timestamp === 0;
        });

        if (cidsToCheck.length === 0) {
            // console.log("[ensurePostsAreFetched] No missing or placeholder posts found to fetch."); // Reduce noise
            return;
        }

        console.log(`[ensurePostsAreFetched] Found ${cidsToCheck.length} missing/placeholder posts. Fetching with hint: '${authorHint}'...`, cidsToCheck);

        const fetchedPosts = new Map<string, Post>();
        const fetchedProfiles = new Map<string, UserProfile>();
        let updatedPlaceholdersCount = 0;

        const fetchPromises = cidsToCheck.map(async (cid: string) => {
             try {
                // Use the updated fetchPostLocal which includes fallback
                const post = await fetchPostLocal(cid, authorHint || 'unknown');

                if (!post) {
                    console.warn(`[ensurePostsAreFetched] fetchPostLocal returned null/undefined for ${cid}`);
                    return;
                }

                // Determine the correct author key
                const author = post.authorKey || authorHint || 'unknown';
                const finalPostData = { ...post, id: cid, authorKey: author };

                // Add to our temporary map for state update
                fetchedPosts.set(cid, finalPostData);

                // Check if we are updating a placeholder
                const existingPost = allPostsMap.get(cid);
                if (existingPost && existingPost.timestamp === 0 && finalPostData.timestamp !== 0) {
                    updatedPlaceholdersCount++;
                }

                // Fetch profile only if it's a real post and profile is missing
                if (author && author !== 'unknown' && finalPostData.timestamp !== 0) {
                    if (!userProfilesMap.has(author) && !fetchedProfiles.has(author)) {
                        try {
                            const headCid = await resolveIpns(author);
                            const authorStateChunk = await fetchUserStateChunk(headCid);
                            if (authorStateChunk?.profile) {
                                fetchedProfiles.set(author, authorStateChunk.profile);
                            } else {
                                fetchedProfiles.set(author, { name: `Unknown (${author.substring(0, 6)}...)` });
                            }
                        } catch (profileError) {
                            console.warn(`[ensurePostsAreFetched] Failed to fetch profile for ${author}:`, profileError);
                             fetchedProfiles.set(author, { name: `Unknown (${author.substring(0, 6)}...)` });
                        }
                    }
                }
             } catch (error) {
                console.error(`[ensurePostsAreFetched] Failed to process post ${cid}:`, error);
                // If fetching fails, ensure a placeholder is in the fetched map
                if (!fetchedPosts.has(cid)) {
                    fetchedPosts.set(cid, { id: cid, authorKey: authorHint || 'unknown', content: '[Error loading content]', timestamp: 0, replies: [] });
                }
             }
        });

        await Promise.allSettled(fetchPromises);

        if (fetchedPosts.size > 0 || fetchedProfiles.size > 0) {
            setAllPostsMap((prev) => {
                const newMap = new Map(prev);
                fetchedPosts.forEach((post, cid) => {
                    // Update map regardless of whether it was missing or a placeholder before
                    newMap.set(cid, post);
                });
                return newMap;
            });
            setUserProfilesMap((prev) => new Map([...prev, ...fetchedProfiles]));
        }
        console.log(`[ensurePostsAreFetched] Finished processing ${fetchedPosts.size} posts (updated ${updatedPlaceholdersCount} placeholders).`);
        // --- END MODIFICATION ---
	}, [ allPostsMap, userProfilesMap, setUserProfilesMap, setAllPostsMap, isLoadingFeed ]);

    // --- START MODIFICATION: NEW: Load More function ---
    const canLoadMoreMyFeed = useMemo(() => {
        // Check if there's any cursor that is not null
        return Array.from(followCursors.values()).some(cid => cid !== null);
    }, [followCursors]);

    const loadMoreMyFeed = useCallback(async () => {
        if (isLoadingFeed) {
            console.log("[loadMoreMyFeed] Already loading feed, skipping.");
            return;
        }

        const allCursorsToFetch = Array.from(followCursors.entries())
            .filter(([_, cid]) => cid !== null) as [string, string][]; // Filter for non-null CIDs

        if (allCursorsToFetch.length === 0) {
            console.log("[loadMoreMyFeed] No more chunks to load.");
            toast("No more posts to load.", { icon: "🏁" });
            return;
        }

        console.log(`[loadMoreMyFeed] Loading next chunks for ${allCursorsToFetch.length} follows in batches...`);
        setIsLoadingFeed(true);

        const collectedPosts = new Map<string, Post>();
        const collectedNewCursors = new Map<string, string | null>();
        const allBatchPromises: Promise<void>[] = [];

        for (let i = 0; i < allCursorsToFetch.length; i += MAX_FOLLOWS_PER_STATE) {
            const batch = allCursorsToFetch.slice(i, i + MAX_FOLLOWS_PER_STATE);
            const batchMap = new Map(batch);

            allBatchPromises.push(
                processChunkBatch(
                    batchMap,
                    (posts) => {
                        posts.forEach((post, cid) => collectedPosts.set(cid, post));
                    },
                    (cursors) => {
                        cursors.forEach((cid, key) => collectedNewCursors.set(key, cid));
                    }
                )
            );
        }

        try {
            await Promise.allSettled(allBatchPromises);

            if (collectedPosts.size > 0) {
                 setAllPostsMap(prev => new Map([...prev, ...collectedPosts]));
                 toast.success(`Loaded ${collectedPosts.size} new posts.`);
            } else {
                 toast.success("Checked for new posts, feed is up to date.");
            }

            if (collectedNewCursors.size > 0) {
                 // Merge new cursors with potentially existing ones (though unlikely in this flow)
                 setFollowCursors(prev => new Map([...prev, ...collectedNewCursors]));
            }
            console.log(`[loadMoreMyFeed] Finished. Loaded ${collectedPosts.size} posts, updated ${collectedNewCursors.size} cursors.`);

        } catch (e) {
            console.error("[loadMoreMyFeed] Error loading more chunks:", e);
            toast.error("Failed to load more posts.");
        } finally {
            setIsLoadingFeed(false);
        }

    }, [isLoadingFeed, followCursors, setFollowCursors, processChunkBatch, setAllPostsMap]);
    // --- END MODIFICATION ---


	return {
		isLoadingFeed,
		processMainFeed,
		ensurePostsAreFetched,
        // --- START MODIFICATION: Add new exports ---
        loadMoreMyFeed,
        canLoadMoreMyFeed,
        // --- END MODIFICATION ---
	};
};