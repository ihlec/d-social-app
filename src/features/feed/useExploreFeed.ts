// src/features/feed/useExploreFeed.ts
import { useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Post, UserProfile, UserState, Follow } from '../../types';
import { fetchPost, invalidateIpnsCache } from '../../api/ipfsIpns';
// --- FIX: Import the correct (aggregating) fetcher ---
import { fetchUserStateByIpns, fetchUserStateChunkByIpns } from '../../state/stateActions';
// --- End Fix ---


const EXPLORE_BATCH_SIZE = 3;

interface UseAppExploreArgs {
	myIpnsKey: string;
	userState: UserState | null;
	allPostsMap: Map<string, Post>;
	setExploreAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setExploreUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	fetchMissingParentPost: (parentCID: string) => Promise<void>;
}

/**
 * Manages all state and logic for the "Explore" feed.
 */
export const useAppExplore = ({
	myIpnsKey, userState, allPostsMap,
	setExploreAllPostsMap,
	setExploreUserProfilesMap,
	fetchMissingParentPost,
}: UseAppExploreArgs) => {

	const [isLoadingExplore, setIsLoadingExplore] = useState<boolean>(false);
    const processedDiscoveryKeys = useRef<Set<string>>(new Set());
	const nextDiscoveryLayer = useRef<Set<string>>(new Set());
	const isExploreInitialized = useRef<boolean>(false);

	const fetchFollowsOfFollows = useCallback(async (myFollows: string[]): Promise<Set<string>> => {
		const followsOfFollows = new Set<string>();
        const currentlyProcessing = new Set<string>();
        const myFollowsSet = new Set(myFollows);

        console.log(`[fetchFollowsOfFollows] Seeding. My Key: ${myIpnsKey}, My Follows Count: ${myFollowsSet.size}`);

		await Promise.all(myFollows.map(async (directFollowKey) => {
			if (currentlyProcessing.has(directFollowKey)) return;
            currentlyProcessing.add(directFollowKey);
            processedDiscoveryKeys.current.add(directFollowKey);

			try {
                console.log(`[fetchFollowsOfFollows] Processing direct follow: ${directFollowKey}`);
                // --- FIX: Use the aggregating fetcher to get the *complete* user state ---
				const fullState = await fetchUserStateByIpns(directFollowKey);
                console.log(`[fetchFollowsOfFollows] Fetched full state for ${directFollowKey}:`, fullState);

				(fullState.follows || []).forEach((followEntry: Follow | string) => {
                // --- End Fix ---
                    let keyToCheck: string | undefined;
                    let nameHint: string | undefined;

                    if (typeof followEntry === 'string') {
                        keyToCheck = followEntry;
                        nameHint = undefined;
                    } else if (typeof followEntry === 'object' && followEntry?.ipnsKey) {
                        keyToCheck = followEntry.ipnsKey;
                        nameHint = followEntry.name;
                    } else {
                        keyToCheck = undefined;
                        nameHint = undefined;
                    }

                    console.log(`[fetchFollowsOfFollows]   Checking follow from ${directFollowKey}: ${keyToCheck ?? 'undefined'} (Name Hint: ${nameHint})`);
                    // Check if keyToCheck is a valid (non-empty) string
                    if (keyToCheck) {
                        // --- FIX: Assign to new variable after check ---
                        const validKey = keyToCheck;
                        // --- End Fix ---

                        const isNotSelf = validKey !== myIpnsKey;
                        const isNotDirectFollow = !myFollowsSet.has(validKey); // Use validKey
                        console.log(`[fetchFollowsOfFollows]     isValidKey: true, isNotSelf: ${isNotSelf}, isNotDirectFollow: ${isNotDirectFollow}`);

                        if (isNotSelf && isNotDirectFollow) {
                            console.log(`[fetchFollowsOfFollows]     ADDING ${validKey} to potential list.`); // Use validKey
                            followsOfFollows.add(validKey); // Use validKey
                        } else {
                             console.log(`[fetchFollowsOfFollows]     SKIPPING ${validKey} (Reason: IsSelf=${!isNotSelf}, IsDirectFollow=${!isNotDirectFollow})`); // Use validKey
                        }
                    } else {
                         console.log(`[fetchFollowsOfFollows]     isValidKey: false, Skipping.`);
                         console.log(`[fetchFollowsOfFollows]     SKIPPING undefined (Reason: KeyInvalid=true, IsSelf=n/a, IsDirectFollow=n/a)`);
                    }
				});
			} catch (e) {
				console.warn(`[fetchFollowsOfFollows] Failed to process key ${directFollowKey} for explore seed:`, e);
			}
		}));
        console.log(`[fetchFollowsOfFollows] Finished seeding. Found potential users:`, followsOfFollows);
		return followsOfFollows;
	}, [myIpnsKey]);


	const fetchAndProcessExploreLayer = useCallback(async (keysToProcess: string[]) => {
		// ... (implementation remains the same - already fixed)
        const nextKeys = new Set<string>(); const profiles = new Map<string, UserProfile>(); const postsToFetchMap = new Map<string, string>(); const fetchedPosts = new Map<string, Post>(); const parentCIDsToFetch = new Set<string>(); const myFollowsSet = new Set(userState?.follows?.map(f => f.ipnsKey) ?? []);
        await Promise.allSettled(keysToProcess.map(async (key) => { let processFollows = !processedDiscoveryKeys.current.has(key); try { const stateChunk = await fetchUserStateChunkByIpns(key); profiles.set(key, stateChunk.profile || { name: "Unknown" }); if(processFollows){ (stateChunk.follows || []).forEach((followEntry: Follow | string) => { let keyToCheck: string | undefined; if (typeof followEntry === 'string') { keyToCheck = followEntry; } else if (typeof followEntry === 'object' && followEntry?.ipnsKey) { keyToCheck = followEntry.ipnsKey; } else { keyToCheck = undefined; } if (keyToCheck) { if ( keyToCheck !== myIpnsKey && !myFollowsSet.has(keyToCheck) && !processedDiscoveryKeys.current.has(keyToCheck) ) { nextKeys.add(keyToCheck); } } }); processedDiscoveryKeys.current.add(key); } (stateChunk.postCIDs || []).filter(pc => pc && !pc.startsWith('temp-')).slice(0, EXPLORE_BATCH_SIZE).forEach((pc: string) => { postsToFetchMap.set(pc, key); }); } catch (e) { console.warn(`Process explore key ${key} (chunk fetch) failed`, e); } })); const postCIDsToFetch = Array.from(postsToFetchMap.keys()); if (postCIDsToFetch.length > 0) { console.log(`[Explore] Fetching ${postCIDsToFetch.length} posts concurrently...`); const postFetchResults = await Promise.allSettled( postCIDsToFetch.map(async (cid) => { try { const postData = await fetchPost(cid); if (postData) { const authorKey = postsToFetchMap.get(cid) || 'unknown'; const post: Post = { ...postData, authorKey: authorKey, id: cid }; fetchedPosts.set(cid, post); if (post.referenceCID && !allPostsMap.has(post.referenceCID) && !fetchedPosts.has(post.referenceCID)) { parentCIDsToFetch.add(post.referenceCID); } } } catch (e) { console.warn(`Fetch explore post CID ${cid} failed:`, e); } }) ); postFetchResults.forEach((result, index) => { if (result.status === 'rejected') { console.error(`[Explore] Post fetch failed for CID ${postCIDsToFetch[index]}:`, result.reason); } }); } if (parentCIDsToFetch.size > 0) { console.log(`[Explore] Fetching ${parentCIDsToFetch.size} missing parent posts...`); const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) ); await Promise.allSettled(parentFetchPromises); }
		return { nextDiscoverySet: nextKeys, newlyDiscoveredProfiles: profiles, newlyDiscoveredPosts: fetchedPosts };
	}, [myIpnsKey, userState?.follows, allPostsMap, fetchMissingParentPost]);


	const loadMoreExplore = useCallback(async () => {
		// ... (implementation remains the same)
        if (nextDiscoveryLayer.current.size === 0) { if (!isLoadingExplore && isExploreInitialized.current) { toast("End reached.", { icon: "🤷" }); } return; } if (isLoadingExplore) return; const keys = Array.from(nextDiscoveryLayer.current); nextDiscoveryLayer.current.clear(); setIsLoadingExplore(true); console.log(`[Explore] Loading more: processing ${keys.length} keys.`); try { const { nextDiscoverySet, newlyDiscoveredProfiles, newlyDiscoveredPosts } = await fetchAndProcessExploreLayer(keys); if (newlyDiscoveredProfiles.size > 0 || newlyDiscoveredPosts.size > 0) { setExploreUserProfilesMap((prev) => new Map([...prev, ...newlyDiscoveredProfiles])); setExploreAllPostsMap((prev) => new Map([...prev, ...newlyDiscoveredPosts])); console.log(`[Explore] Added ${newlyDiscoveredProfiles.size} profiles, ${newlyDiscoveredPosts.size} posts.`); } else { console.log("[Explore] No new profiles or posts found in this batch."); } nextDiscoverySet.forEach(k => { if (!processedDiscoveryKeys.current.has(k as string)) nextDiscoveryLayer.current.add(k as string); }); if (nextDiscoveryLayer.current.size === 0 && keys.length > 0) { console.log("[Explore] End of discovery path reached."); toast.success("End of path!"); } isExploreInitialized.current = true; } catch (e) { toast.error("Failed load more explore items."); console.error("Explore failed:", e); } finally { setIsLoadingExplore(false); }
	}, [isLoadingExplore, fetchAndProcessExploreLayer, setExploreAllPostsMap, setExploreUserProfilesMap, isExploreInitialized]);

	const refreshExploreFeed = useCallback(async () => {
		// ... (implementation remains the same)
        if (!userState || !myIpnsKey) return; console.log("[Explore] Refreshing feed..."); invalidateIpnsCache(); setExploreAllPostsMap(new Map()); setExploreUserProfilesMap(new Map()); nextDiscoveryLayer.current.clear(); processedDiscoveryKeys.current.clear(); isExploreInitialized.current = false; processedDiscoveryKeys.current.add(myIpnsKey); const myFollows = (userState.follows || []).map(f => f?.ipnsKey).filter((k): k is string => !!k && k !== myIpnsKey); console.log(`[Explore] Seeding with ${myFollows.length} follows.`); const followsOfFollows = await fetchFollowsOfFollows(myFollows); console.log(`[Explore] Found ${followsOfFollows.size} potential users in next layer (excluding direct follows).`); followsOfFollows.forEach(k => nextDiscoveryLayer.current.add(k)); await loadMoreExplore();
	}, [userState, myIpnsKey, fetchFollowsOfFollows, loadMoreExplore, setExploreAllPostsMap, setExploreUserProfilesMap]);

	return { isLoadingExplore, loadMoreExplore, refreshExploreFeed };
};