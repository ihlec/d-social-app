// src/features/feed/useExploreFeed.ts
// --- FIX: Removed unused imports ---
import { useState, useCallback, useRef } from 'react';
// import { useState, useCallback, useRef, useEffect } from 'react'; // Removed useEffect
// --- END FIX ---
import toast from 'react-hot-toast';
import { Post, UserProfile, UserState, Follow } from '../../types';
import { fetchPost, invalidateIpnsCache } from '../../api/ipfsIpns';
// --- FIX: Removed unused import ---
import { fetchUserStateByIpns } from '../../state/stateActions';
// import { fetchUserStateByIpns, fetchUserStateChunkByIpns } from '../../state/stateActions';
// --- END FIX ---

const EXPLORE_POST_PROFILE_BATCH_SIZE = 5;

interface UseAppExploreArgs {
	myIpnsKey: string;
	userState: UserState | null;
	allPostsMap: Map<string, Post>;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	fetchMissingParentPost: (parentCID: string) => Promise<void>;
}

export interface UseAppExploreReturn {
    isLoadingExplore: boolean;
    loadMoreExplore: () => Promise<void>;
    refreshExploreFeed: () => Promise<void>;
    canLoadMoreExplore: boolean;
}


export const useAppExplore = ({
	myIpnsKey, userState, allPostsMap,
	setAllPostsMap,
	setUserProfilesMap,
	fetchMissingParentPost,
}: UseAppExploreArgs): UseAppExploreReturn => {

	const [isLoadingExplore, setIsLoadingExplore] = useState<boolean>(false);
    const [canLoadMoreExplore, setCanLoadMoreExplore] = useState<boolean>(false);
    const processedFollowFetchKeys = useRef<Set<string>>(new Set());
	const currentBatchKeys = useRef<string[]>([]);
	const nextLayerKeys = useRef<Set<string>>(new Set());
	const isExploreInitialized = useRef<boolean>(false);


    // Fetches the full follow list for a batch of keys
	const fetchFollowsForLayer = useCallback(async (keysToExplore: string[]): Promise<Set<string>> => {
		const newlyFoundKeys = new Set<string>();
        const myFollowsSet = new Set(userState?.follows?.map(f => f.ipnsKey) ?? []);

        console.log(`[fetchFollowsForLayer] Exploring follows for ${keysToExplore.length} keys.`);

		await Promise.allSettled(keysToExplore.map(async (keyToExplore) => {
			if (processedFollowFetchKeys.current.has(keyToExplore)) return;
            processedFollowFetchKeys.current.add(keyToExplore);

			try {
                console.log(`[fetchFollowsForLayer] Fetching full state for ${keyToExplore}`);
				const { state: fullState } = await fetchUserStateByIpns(keyToExplore);

				(fullState.follows || []).forEach((followEntry: Follow | string) => {
                    let keyToCheck: string | undefined;
                    if (typeof followEntry === 'string') { keyToCheck = followEntry; }
                    else if (typeof followEntry === 'object' && followEntry?.ipnsKey) { keyToCheck = followEntry.ipnsKey; }

                    if (keyToCheck) {
                        const isValidKey = keyToCheck;
                        const isNotSelf = isValidKey !== myIpnsKey;
                        const isNotDirectFollow = !myFollowsSet.has(isValidKey);
                        const isNotAlreadyProcessed = !processedFollowFetchKeys.current.has(isValidKey);

                        if (isNotSelf && isNotDirectFollow && isNotAlreadyProcessed) {
                            newlyFoundKeys.add(isValidKey);
                        }
                    }
				});
			} catch (e) {
				console.warn(`[fetchFollowsForLayer] Failed to process key ${keyToExplore} for next layer:`, e);
			}
		}));
        console.log(`[fetchFollowsForLayer] Found ${newlyFoundKeys.size} unique keys for the next layer.`);
		return newlyFoundKeys;
	}, [myIpnsKey, userState?.follows]);


    // Fetches profiles AND ALL POSTS for a batch of keys
    const fetchPostsProfilesForBatch = useCallback(async (keysToProcess: string[]) => {
        console.log(`[fetchPostsProfilesForBatch] Processing posts/profiles for ${keysToProcess.length} keys.`);
        const profiles = new Map<string, UserProfile>();
        const postsFromBatchUsers = new Map<string, string>(); // Map<postCID, authorKey>
        const fetchedPosts = new Map<string, Post>(); // Posts *actually* fetched or retrieved in this batch
        const parentCIDsToFetch = new Set<string>();

        // 1. Fetch FULL state for profile and identify ALL post CIDs for users in this batch
        await Promise.allSettled(keysToProcess.map(async (key) => {
            try {
                console.log(`[fetchPostsProfilesForBatch] Fetching FULL state for key ${key}`);
                const { state: fullUserState } = await fetchUserStateByIpns(key);

                profiles.set(key, fullUserState.profile || { name: `Unknown (${key.substring(0,6)}...)` });

                (fullUserState.postCIDs || [])
                    .filter(pc => pc && !pc.startsWith('temp-'))
                    .forEach((pc: string) => {
                        postsFromBatchUsers.set(pc, key);
                    });
            } catch (e) {
                console.warn(`[fetchPostsProfilesForBatch] Failed to fetch full state for key ${key}:`, e);
                if (!profiles.has(key)) {
                    profiles.set(key, { name: `Unknown (${key.substring(0,6)}...)` });
                }
            }
        }));

        // 2. Iterate through posts identified from the batch users
        const postCIDsFromBatch = Array.from(postsFromBatchUsers.keys());
        if (postCIDsFromBatch.length > 0) {
            console.log(`[fetchPostsProfilesForBatch] Identified ${postCIDsFromBatch.length} posts from batch users. Checking against global map and fetching if needed...`);
            await Promise.allSettled(postCIDsFromBatch.map(async (cid) => {
                if (fetchedPosts.has(cid)) return;

                const existingPost = allPostsMap.get(cid);
                const authorKey = postsFromBatchUsers.get(cid)!;

                if (existingPost) {
                    fetchedPosts.set(cid, { ...existingPost, authorKey });
                } else {
                    try {
                        const postData = await fetchPost(cid);
                        if (postData && postData.authorKey) {
                            const post: Post = { ...postData, authorKey: authorKey, id: cid };
                            fetchedPosts.set(cid, post);
                            if (post.referenceCID && !allPostsMap.has(post.referenceCID) && !fetchedPosts.has(post.referenceCID)) {
                                parentCIDsToFetch.add(post.referenceCID);
                            }
                        } else {
                             console.warn(`[fetchPostsProfilesForBatch] Invalid data received for post CID ${cid}`);
                        }
                    } catch (e) {
                        console.warn(`[fetchPostsProfilesForBatch] Fetch explore post CID ${cid} failed:`, e);
                    }
                }
            }));
            console.log(`[fetchPostsProfilesForBatch] Added/Fetched ${fetchedPosts.size} posts for this batch.`);
        } else {
             console.log(`[fetchPostsProfilesForBatch] No post CIDs identified from users in this batch.`);
        }

        // 3. Fetch missing parent posts
        if (parentCIDsToFetch.size > 0) {
            console.log(`[fetchPostsProfilesForBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`);
            await Promise.allSettled(Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid)));
        }

		return { newlyDiscoveredProfiles: profiles, newlyDiscoveredPosts: fetchedPosts };
	}, [allPostsMap, fetchMissingParentPost]);


    // Load More / Process Next Batch
	const loadMoreExplore = useCallback(async () => {
		if (isLoadingExplore) return;
        setIsLoadingExplore(true);
        setCanLoadMoreExplore(false);
        console.log(`[loadMoreExplore] Triggered. Current batch size: ${currentBatchKeys.current.length}, Next layer size: ${nextLayerKeys.current.size}`);

        try {
            let keysForThisRun: string[] = [];

            // 1. Check if keys remaining in the current post/profile batch
            if (currentBatchKeys.current.length > 0) {
                keysForThisRun = currentBatchKeys.current.splice(0, EXPLORE_POST_PROFILE_BATCH_SIZE);
                console.log(`[loadMoreExplore] Processing next ${keysForThisRun.length} keys from current batch.`);
            }
            // 2. If current batch empty, fetch next follow layer
            else {
                console.log(`[loadMoreExplore] Current batch empty. Fetching next follow layer using ${nextLayerKeys.current.size} keys.`);
                const keysToFetchFollowsFrom = Array.from(nextLayerKeys.current);
                nextLayerKeys.current.clear(); // Clear for the next population

                if (keysToFetchFollowsFrom.length === 0) {
                     if (isExploreInitialized.current) {
                        toast("End of explored network reached.", { icon: "🏁" });
                     } else {
                        toast("Nothing to explore yet. Follow some users!", { icon: "🤷" });
                     }
                     setCanLoadMoreExplore(false);
                     setIsLoadingExplore(false);
                     return;
                }

                // Fetch the *next* layer of users
                const newlyFoundKeysForNextLayer = await fetchFollowsForLayer(keysToFetchFollowsFrom);

                // These newly found keys become the *new* batch to process for posts/profiles
                currentBatchKeys.current = Array.from(newlyFoundKeysForNextLayer);
                // And also the basis for the *next* layer's follow fetch
                newlyFoundKeysForNextLayer.forEach(k => nextLayerKeys.current.add(k));

                if (currentBatchKeys.current.length === 0) {
                     toast("Explored all reachable users in this path.", { icon: "🗺️" });
                     setCanLoadMoreExplore(false);
                     setIsLoadingExplore(false);
                     return;
                }

                // Take the first chunk for *this* run
                keysForThisRun = currentBatchKeys.current.splice(0, EXPLORE_POST_PROFILE_BATCH_SIZE);
                console.log(`[loadMoreExplore] Fetched new layer. Next layer potential: ${nextLayerKeys.current.size}. Processing first ${keysForThisRun.length} keys from current batch ${currentBatchKeys.current.length + keysForThisRun.length}.`);

            }

            // 3. Fetch posts and profiles for the determined batch
            if (keysForThisRun.length > 0) {
                const { newlyDiscoveredProfiles, newlyDiscoveredPosts } = await fetchPostsProfilesForBatch(keysForThisRun);

                // 4. Update global state maps
                if (newlyDiscoveredProfiles.size > 0 || newlyDiscoveredPosts.size > 0) {
                    setUserProfilesMap((prev) => new Map([...prev, ...newlyDiscoveredProfiles]));
                    setAllPostsMap((prev) => new Map([...prev, ...newlyDiscoveredPosts]));
                    console.log(`[loadMoreExplore] Merged ${newlyDiscoveredProfiles.size} profiles, ${newlyDiscoveredPosts.size} posts into global state.`);
                } else {
                    console.log("[loadMoreExplore] No new profiles or posts found/added in this batch run.");
                }
            } else {
                 console.log("[loadMoreExplore] No keys determined for this run.");
                  if (isExploreInitialized.current) {
                     toast("End of explored network reached.", { icon: "🏁" });
                  }
            }

            isExploreInitialized.current = true;

        } catch (e) {
            toast.error("Failed load more explore items.");
            console.error("[loadMoreExplore] Error:", e);
        } finally {
            setIsLoadingExplore(false);
            const hasMoreKeys = currentBatchKeys.current.length > 0 || nextLayerKeys.current.size > 0;
            setCanLoadMoreExplore(hasMoreKeys);
            console.log(`[loadMoreExplore] Finished. Remaining in batch: ${currentBatchKeys.current.length}, Next layer size: ${nextLayerKeys.current.size}. Can load more: ${hasMoreKeys}`);
            // Only chain automatically if processing the CURRENT batch
            if (currentBatchKeys.current.length > 0) {
                 console.log(`[loadMoreExplore] Automatically chaining next batch from current layer...`);
                 setTimeout(() => loadMoreExplore(), 100); // Small delay
            }
        }
	}, [isLoadingExplore, fetchFollowsForLayer, fetchPostsProfilesForBatch, setAllPostsMap, setUserProfilesMap, isExploreInitialized]);


    // Refresh Explore Feed
	const refreshExploreFeed = useCallback(async () => {
		if (!userState || !myIpnsKey) return;
        console.log("[refreshExploreFeed] Refreshing explore feed...");
        setIsLoadingExplore(true);
        setCanLoadMoreExplore(false);
        invalidateIpnsCache();

        // Reset state refs
        processedFollowFetchKeys.current.clear();
        currentBatchKeys.current = [];
        nextLayerKeys.current.clear();
        isExploreInitialized.current = false;
        processedFollowFetchKeys.current.add(myIpnsKey); // Don't explore self

        const myFollows = (userState.follows || []).map(f => f?.ipnsKey).filter((k): k is string => !!k);
        console.log(`[refreshExploreFeed] Seeding with ${myFollows.length} direct follows.`);

        // Fetch the first layer (follows of *my* follows)
        const firstLayerKeys = await fetchFollowsForLayer(myFollows);

        if (firstLayerKeys.size === 0) {
            toast("No users found to explore based on your follows.", { icon: "🤷" });
            setCanLoadMoreExplore(false);
            setIsLoadingExplore(false);
            return;
        }

        // Set these keys as the first batch to process for posts/profiles
        currentBatchKeys.current = Array.from(firstLayerKeys);
        // And also set them as the keys for the *next* follow fetch (layer 2)
        firstLayerKeys.forEach(k => nextLayerKeys.current.add(k));

        console.log(`[refreshExploreFeed] Found ${firstLayerKeys.size} keys for the first layer. Triggering initial loadMoreExplore.`);
        // Don't unset loading here, loadMoreExplore handles it
        await loadMoreExplore(); // Trigger the first batch processing

	}, [userState, myIpnsKey, fetchFollowsForLayer, loadMoreExplore]);

	return { isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore };
};
