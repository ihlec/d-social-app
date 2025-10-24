// src/hooks/useActions.ts
import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { NewPostData, Post, UserState, Follow, UserProfile } from '../types';
import {
    uploadPost,
    _uploadStateAndPublishToIpns,
    _uploadStateOnly,
    fetchUserStateByIpns
} from './stateActions';

const ARRAY_CHUNK_LIMIT = 5;

interface UseAppActionsArgs {
	userState: UserState | null;
	setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
	myIpnsKey: string;
    // --- FIX: Pass latestStateCID ---
    latestStateCID: string;
    // --- END FIX ---
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	refreshFeed: (force?: boolean) => Promise<void>;
}

/**
 * Manages all user actions that mutate state (post, like, follow, etc.).
 * Also manages the `isProcessing` state.
 */
export const useAppActions = ({
	userState, setUserState,
    myIpnsKey,
    // --- FIX: Destructure latestStateCID ---
    latestStateCID, // CID *before* the action
    // --- END FIX ---
	setAllPostsMap,
	setLatestStateCID: setLatestHeadCID, // Rename for clarity within hook
	setUserProfilesMap,
	refreshFeed,
}: UseAppActionsArgs) => {

	const [isProcessing, setIsProcessing] = useState<boolean>(false);

	const addPost = useCallback(async (postData: NewPostData) => {
		if (!userState) { toast.error("User state not loaded."); return; }
		if (isProcessing) { toast.error("Please wait."); return; }

        const currentHeadCID = latestStateCID; // Capture CID before action
		const { content, referenceCID, file } = postData;
		const timestamp = Date.now();
		const tempId = `temp-${timestamp}`;
		const optimisticPost: Post = { id: tempId, timestamp, content, authorKey: myIpnsKey, referenceCID, replies: [] };
        if (file) {
			optimisticPost.mediaType = file.type.startsWith("image/") ? 'image' : file.type.startsWith("video/") ? 'video' : 'file';
			if (optimisticPost.mediaType !== 'file') optimisticPost.thumbnailCid = URL.createObjectURL(file);
			else optimisticPost.fileName = file.name;
		}
        setAllPostsMap((prev: Map<string, Post>) => new Map(prev).set(tempId, optimisticPost));

		try {
			setIsProcessing(true);
			toast.loading("Uploading post data...", { id: "post-upload" });

			const { finalPost, finalPostCID } = await uploadPost(postData, myIpnsKey);
			toast.dismiss("post-upload");
            if (optimisticPost.thumbnailCid?.startsWith("blob:")) URL.revokeObjectURL(optimisticPost.thumbnailCid);

			setAllPostsMap((prev: Map<string, Post>) => {
				const map = new Map(prev);
				map.delete(tempId);
				map.set(finalPostCID, { ...optimisticPost, ...finalPost, id: finalPostCID });
				return map;
			});

            const newUserState: UserState = {
                ...userState,
                postCIDs: [finalPostCID, ...(userState.postCIDs || [])],
                updatedAt: timestamp,
                // Ensure extendedUserState is carried over *initially* if present in loaded state
                extendedUserState: userState.extendedUserState || null
            };
            setUserState(newUserState);

            let stateToPublish: UserState | Partial<UserState> = newUserState;
            let previousStateChunkCID: string | undefined = undefined; // Renamed for clarity

            // Chunking Logic ONLY for postCIDs
            if ((newUserState.postCIDs ?? []).length > ARRAY_CHUNK_LIMIT) {
                console.log("[addPost] PostCIDs limit exceeded, creating chunk.");
                toast.loading("Chunking state...", { id: "chunking" });
                // We need the state *before* this post was added.
                // The correct reference is the `currentHeadCID` captured at the start.
                previousStateChunkCID = currentHeadCID;
                console.log("[addPost] Previous state chunk CID (current head):", previousStateChunkCID);

                // Create the new chunk containing profile, timestamp, link, and *only the new post CID*
                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    // Link to the head state *before* this post was added
                    extendedUserState: previousStateChunkCID,
                    postCIDs: [finalPostCID], // Only the new post
                    // Ensure other arrays exist but are empty in the chunk
                    follows: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking");
            }

            // --- FIX: Pass currentHeadCID only if NOT chunking ---
            // If we chunked, stateToPublish already contains the correct extendedUserState link.
            // If we didn't chunk, _uploadStateAndPublishToIpns needs currentHeadCID to set the link.
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey,
                previousStateChunkCID ? undefined : currentHeadCID // Pass currentHeadCID only if not chunking
            );
            // --- END FIX ---
			setLatestHeadCID(headCID);
			toast.success("Post published!");

		} catch (error) {
			toast.dismiss("post-upload");
            toast.dismiss("chunking");
			toast.error(`Publish failed: ${error instanceof Error ? error.message : "Unknown"}`);
			if (optimisticPost.thumbnailCid?.startsWith("blob:")) URL.revokeObjectURL(optimisticPost.thumbnailCid);
			setUserState(userState); // Revert optimistic UI
			setAllPostsMap((prev: Map<string, Post>) => {
				const map = new Map(prev);
				map.delete(tempId);
				return map;
			});
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, setUserState, setAllPostsMap, setLatestHeadCID]);


	const likePost = useCallback(async (postId: string) => {
        if (!userState || isProcessing) return; if (postId.startsWith("temp-")) { toast.error("Wait publish."); return; }

        const currentHeadCID = latestStateCID; // Capture CID before action
        const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isLiked = liked.has(postId);
        isLiked ? liked.delete(postId) : liked.add(postId);
		disliked.delete(postId); // Liking removes dislike

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null // Preserve link initially
        };
		setUserState(newUserState); // Update UI optimistically

		try {
			setIsProcessing(true);

            let stateToPublish: UserState | Partial<UserState> = newUserState;
            let previousStateChunkCID: string | undefined = undefined;

            // Only chunk if we *added* a like AND the array is over the limit
            if (!isLiked && (newUserState.likedPostCIDs ?? []).length > ARRAY_CHUNK_LIMIT) {
                console.log("[likePost] likedPostCIDs limit exceeded, creating chunk.");
                toast.loading("Chunking state...", { id: "chunking-like" });

                previousStateChunkCID = currentHeadCID; // Link to state before this action

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: previousStateChunkCID,
                    likedPostCIDs: [postId], // Only the new like
                    dislikedPostCIDs: [], // Action clears dislikes
                    postCIDs: [],
                    follows: [],
                };
                toast.dismiss("chunking-like");
            }

            // --- FIX: Pass currentHeadCID if not chunking ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey,
                previousStateChunkCID ? undefined : currentHeadCID
            );
            // --- END FIX ---
			setLatestHeadCID(headCID);
			toast.success(isLiked ? "Unliked" : "Liked");

		} catch (e) {
            toast.dismiss("chunking-like");
			setUserState(userState); // Revert UI
			toast.error(`Action failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, setUserState, setLatestHeadCID]);

	const dislikePost = useCallback(async (postId: string) => {
        if (!userState || isProcessing) return; if (postId.startsWith("temp-")) { toast.error("Wait publish."); return; }

        const currentHeadCID = latestStateCID; // Capture CID before action
		const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isDisliked = disliked.has(postId);
		isDisliked ? disliked.delete(postId) : disliked.add(postId);
		liked.delete(postId); // Disliking removes like

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null // Preserve link initially
        };
		setUserState(newUserState); // Update UI optimistically

		try {
			setIsProcessing(true);

            let stateToPublish: UserState | Partial<UserState> = newUserState;
            let previousStateChunkCID: string | undefined = undefined;

            // Only chunk if we *added* a dislike AND the array is over the limit
            if (!isDisliked && (newUserState.dislikedPostCIDs ?? []).length > ARRAY_CHUNK_LIMIT) {
                console.log("[dislikePost] dislikedPostCIDs limit exceeded, creating chunk.");
                toast.loading("Chunking state...", { id: "chunking-dislike" });

                previousStateChunkCID = currentHeadCID; // Link to state before this action

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: previousStateChunkCID,
                    dislikedPostCIDs: [postId], // Only the new dislike
                    likedPostCIDs: [], // Action clears likes
                    postCIDs: [],
                    follows: [],
                };
                toast.dismiss("chunking-dislike");
            }

            // --- FIX: Pass currentHeadCID if not chunking ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey,
                previousStateChunkCID ? undefined : currentHeadCID
            );
            // --- END FIX ---
			setLatestHeadCID(headCID);
			toast.success(isDisliked ? "Removed dislike" : "Disliked");

		} catch (e) {
            toast.dismiss("chunking-dislike");
			setUserState(userState); // Revert UI
			toast.error(`Action failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, setUserState, setLatestHeadCID]);

	const followUser = useCallback(async (ipnsKeyToFollow: string) => {
		if (!userState || isProcessing || ipnsKeyToFollow === myIpnsKey) return;
		if (userState.follows?.some(f => f.ipnsKey === ipnsKeyToFollow)) { toast.error("Already following."); return; }

        const currentHeadCID = latestStateCID; // Capture CID before action
        const optimisticTimestamp = Date.now();
		const optimisticFollow: Follow = { ipnsKey: ipnsKeyToFollow, name: 'Loading...', lastSeenCid: '' };
		const optimisticUserState: UserState = {
            ...userState,
            follows: [...(userState.follows || []), optimisticFollow],
            updatedAt: optimisticTimestamp,
            extendedUserState: userState.extendedUserState || null // Preserve link initially
        };
		setUserState(optimisticUserState);
		setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(ipnsKeyToFollow, { name: 'Loading...' }));

		try {
			setIsProcessing(true);
            let finalFollow: Follow;
            let finalUserState: UserState;

			await toast.promise((async () => {
				const { state, cid } = await fetchUserStateByIpns(ipnsKeyToFollow);
				const name = state?.profile?.name || "Unknown";
				finalFollow = { ipnsKey: ipnsKeyToFollow, name, lastSeenCid: cid };
                // Create the state *after* resolving the user, inheriting the link
				finalUserState = {
                    ...optimisticUserState, // Includes potentially existing link
                    follows: optimisticUserState.follows.map(f => f.ipnsKey === ipnsKeyToFollow ? finalFollow : f),
                };
                setUserState(finalUserState); // Update UI with resolved name
                setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(ipnsKeyToFollow, { name }));
			})(), { loading: "Resolving user...", success: "User found!", error: e => `Failed: ${e instanceof Error ? e.message : "Unknown"}` });

            let stateToPublish: UserState | Partial<UserState> = finalUserState!;
            let previousStateChunkCID: string | undefined = undefined;

            if ((finalUserState!.follows ?? []).length > ARRAY_CHUNK_LIMIT) {
                console.log("[followUser] follows limit exceeded, creating chunk.");
                toast.loading("Chunking state...", { id: "chunking-follow" });

                previousStateChunkCID = currentHeadCID; // Link to state before this action

                stateToPublish = {
                    profile: finalUserState!.profile,
                    updatedAt: finalUserState!.updatedAt,
                    extendedUserState: previousStateChunkCID,
                    follows: [finalFollow!], // Only the new follow
                    postCIDs: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking-follow");
            }

            // --- FIX: Pass currentHeadCID if not chunking ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey,
                previousStateChunkCID ? undefined : currentHeadCID
            );
            // --- END FIX ---
			setLatestHeadCID(headCID);
			toast.success(`Followed ${finalFollow!.name}!`);
			await refreshFeed(); // Refresh feed might be needed to show their posts

		} catch (e) {
            toast.dismiss("chunking-follow");
			setUserState(userState); // Revert to original state
			setUserProfilesMap((prev: Map<string, UserProfile>) => { const map = new Map(prev); map.delete(ipnsKeyToFollow); return map; });
			console.error("Follow failed:", e);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, refreshFeed, setUserState, setUserProfilesMap, setLatestHeadCID]);


	const unfollowUser = useCallback(async (ipnsKeyToUnfollow: string) => {
		if (!userState || isProcessing) return;
		const toRemove = userState.follows?.find(f => f.ipnsKey === ipnsKeyToUnfollow);
		if (!toRemove) return;

        const currentHeadCID = latestStateCID; // Capture CID before action
		const newUserState: UserState = {
            ...userState,
            follows: (userState.follows || []).filter(f => f.ipnsKey !== ipnsKeyToUnfollow),
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null // Preserve link initially
        };
		setUserState(newUserState); // Optimistic UI

		try {
			setIsProcessing(true);
            // No chunking needed for *removing* an item.
            // --- FIX: Pass currentHeadCID ---
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey, currentHeadCID);
            // --- END FIX ---
			setLatestHeadCID(headCID);
			toast.success(`Unfollowed ${toRemove.name || "user"}.`);
			refreshFeed(true); // Force refresh to remove posts from feed view immediately
		} catch (e) {
			setUserState(userState); // Revert UI
            toast.error(`Unfollow failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, refreshFeed, setUserState, setLatestHeadCID]);


	const updateProfile = useCallback(async (profileData: Partial<UserProfile>) => {
		if (!userState || isProcessing) return;

        const currentHeadCID = latestStateCID; // Capture CID before action
		const label = sessionStorage.getItem("currentUserLabel") || "";
		const newName = profileData.name || userState.profile.name || label;
		if (profileData.name && profileData.name !== label) sessionStorage.setItem("currentUserLabel", profileData.name);

		const newUserState: UserState = {
            ...userState,
            profile: { ...userState.profile, name: newName, ...profileData },
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null // Preserve link initially
        };
		setUserState(newUserState); // Optimistic UI
		setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(myIpnsKey, newUserState.profile));
		try {
			setIsProcessing(true);
            // No chunking needed for profile update
            // --- FIX: Pass currentHeadCID ---
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey, currentHeadCID);
            // --- END FIX ---
			setLatestHeadCID(headCID);
			toast.success("Profile updated!");
		} catch (e) {
			setUserState(userState); // Revert UI
			setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(myIpnsKey, userState.profile));
			sessionStorage.setItem("currentUserLabel", label); // Revert label too
            toast.error(`Profile update failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, setUserState, setUserProfilesMap, setLatestHeadCID]);

	return {
		isProcessing,
		addPost,
		likePost,
		dislikePost,
		followUser,
		unfollowUser,
		updateProfile,
	};
};