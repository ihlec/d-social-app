// src/hooks/useSharedPostFetcher.ts
import { useCallback, useRef } from 'react';
import { Post, UserProfile } from '../types';
import { fetchPost } from '../api/ipfsIpns';
import { fetchUserProfile } from '../state/stateActions';

interface UseParentPostFetcherArgs {
	allPostsMap: Map<string, Post>;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    // --- FIX: Removed explore maps ---
	// exploreAllPostsMap: Map<string, Post>;
	// setExploreAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    // --- END FIX ---
	userProfilesMap: Map<string, UserProfile>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    // --- FIX: Removed explore maps ---
	// exploreUserProfilesMap: Map<string, UserProfile>;
	// setExploreUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    // --- END FIX ---
}

/**
 * Provides a memoized function to fetch a missing parent post.
 * This logic is shared by both the main feed and the explore feed.
 */
export const useParentPostFetcher = ({
	allPostsMap, setAllPostsMap,
	userProfilesMap, setUserProfilesMap,
}: UseParentPostFetcherArgs) => {

	const fetchingParentPosts = useRef<Set<string>>(new Set());

	const fetchMissingParentPost = useCallback(async (parentCID: string) => {
		if (fetchingParentPosts.current.has(parentCID)) return;
		fetchingParentPosts.current.add(parentCID);

		// --- FIX: Check only single allPostsMap ---
		let postData: Post | null = allPostsMap.get(parentCID) || null;
        // --- END FIX ---
		let profileData: UserProfile | null = null;
		let fetchError = null;

		try {
			if (!postData) {
				try {
					postData = await fetchPost(parentCID);
					if (!postData?.authorKey) throw new Error("Invalid parent post data fetched.");
				} catch (postFetchError) {
					fetchError = postFetchError;
					console.error(`fetchMissingParentPost: Failed to fetch post ${parentCID}:`, postFetchError);
					postData = { id: parentCID, authorKey: 'unknown', content: '[Parent not loaded]', timestamp: 0, replies: [] };
				}
			}

			if (!postData) throw new Error("Critical error: Post data is null after fetch/check.");

			// --- FIX: Update only single allPostsMap ---
			setAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, postData!));
			// setExploreAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, postData!));
            // --- END FIX ---

			const authorKey = postData.authorKey;
			if (authorKey !== 'unknown') {
				// --- FIX: Check only single userProfilesMap ---
				profileData = userProfilesMap.get(authorKey) || null;
                // --- END FIX ---

				if (!profileData) {
					try {
						profileData = await fetchUserProfile(authorKey);
					} catch (profileFetchError) {
						if (!fetchError) fetchError = profileFetchError;
						console.warn(`fetchMissingParentPost: Failed fetch profile for ${authorKey}:`, profileFetchError);
						profileData = { name: `Unknown (${authorKey.substring(0, 6)}...)` };
					}

					if (profileData) {
						// --- FIX: Update only single userProfilesMap ---
						setUserProfilesMap((prevMap: Map<string, UserProfile>) => prevMap.has(authorKey) ? prevMap : new Map(prevMap).set(authorKey, profileData!));
						// setExploreUserProfilesMap((prevMap: Map<string, UserProfile>) => prevMap.has(authorKey) ? prevMap : new Map(prevMap).set(authorKey, profileData!));
                        // --- END FIX ---
					}
				}
			}
		} catch (e) {
			console.error(`fetchMissingParentPost: Unexpected error processing ${parentCID}:`, e);
			if (!fetchError) fetchError = e;
			if (!postData) {
				const placeholderPost: Post = { id: parentCID, authorKey: 'unknown', content: '[Processing Error]', timestamp: 0, replies: [] };
				// --- FIX: Update only single allPostsMap ---
				setAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, placeholderPost));
				// setExploreAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, placeholderPost));
                // --- END FIX ---
			}
		} finally {
			fetchingParentPosts.current.delete(parentCID);
		}
	}, [
        // --- FIX: Updated dependencies ---
		allPostsMap, setAllPostsMap,
		userProfilesMap, setUserProfilesMap
        // --- END FIX ---
	]);

	return fetchMissingParentPost;
};