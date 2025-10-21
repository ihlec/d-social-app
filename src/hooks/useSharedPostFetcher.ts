// src/hooks/useParentPostFetcher.ts
import { useCallback, useRef } from 'react';
import { Post, UserProfile } from '../types';
import { fetchPost } from '../api/ipfs';
import { fetchUserProfile } from '../state/stateActions';

interface UseParentPostFetcherArgs {
	allPostsMap: Map<string, Post>;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	exploreAllPostsMap: Map<string, Post>;
	setExploreAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	userProfilesMap: Map<string, UserProfile>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	exploreUserProfilesMap: Map<string, UserProfile>;
	setExploreUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
}

/**
 * Provides a memoized function to fetch a missing parent post.
 * This logic is shared by both the main feed and the explore feed.
 */
export const useParentPostFetcher = ({
	allPostsMap, setAllPostsMap,
	exploreAllPostsMap, setExploreAllPostsMap,
	userProfilesMap, setUserProfilesMap,
	exploreUserProfilesMap, setExploreUserProfilesMap,
}: UseParentPostFetcherArgs) => { // <-- FIX: Corrected type name

	const fetchingParentPosts = useRef<Set<string>>(new Set());

	const fetchMissingParentPost = useCallback(async (parentCID: string) => {
		if (fetchingParentPosts.current.has(parentCID)) return;
		fetchingParentPosts.current.add(parentCID);

		// Check if post exists in *either* map
		let postData: Post | null = allPostsMap.get(parentCID) || exploreAllPostsMap.get(parentCID) || null;
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

			// Update both maps
			setAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, postData!));
			setExploreAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, postData!));

			const authorKey = postData.authorKey;
			if (authorKey !== 'unknown') {
				// Check if profile exists in *either* map
				profileData = userProfilesMap.get(authorKey) || exploreUserProfilesMap.get(authorKey) || null;

				if (!profileData) {
					try {
						profileData = await fetchUserProfile(authorKey);
					} catch (profileFetchError) {
						if (!fetchError) fetchError = profileFetchError;
						console.warn(`fetchMissingParentPost: Failed fetch profile for ${authorKey}:`, profileFetchError);
						profileData = { name: `Unknown (${authorKey.substring(0, 6)}...)` };
					}

					if (profileData) {
						setUserProfilesMap((prevMap: Map<string, UserProfile>) => prevMap.has(authorKey) ? prevMap : new Map(prevMap).set(authorKey, profileData!));
						setExploreUserProfilesMap((prevMap: Map<string, UserProfile>) => prevMap.has(authorKey) ? prevMap : new Map(prevMap).set(authorKey, profileData!));
					}
				}
			}
		} catch (e) {
			console.error(`fetchMissingParentPost: Unexpected error processing ${parentCID}:`, e);
			if (!fetchError) fetchError = e;
			if (!postData) {
				const placeholderPost: Post = { id: parentCID, authorKey: 'unknown', content: '[Processing Error]', timestamp: 0, replies: [] };
				setAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, placeholderPost));
				setExploreAllPostsMap((prevMap: Map<string, Post>) => prevMap.has(parentCID) ? prevMap : new Map(prevMap).set(parentCID, placeholderPost));
			}
		} finally {
			fetchingParentPosts.current.delete(parentCID);
		}
	}, [
		allPostsMap, setAllPostsMap,
		exploreAllPostsMap, setExploreAllPostsMap,
		userProfilesMap, setUserProfilesMap,
		exploreUserProfilesMap, setExploreUserProfilesMap
	]);

	return fetchMissingParentPost;
};