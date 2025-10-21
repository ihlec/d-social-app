// src/hooks/useAppActions.ts
import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { NewPostData, Post, UserState, Follow, UserProfile } from '../types';
import {
    uploadPost,
    _uploadStateAndPublishToIpns,
    _uploadStateOnly,
    fetchUserStateByIpns
} from './libHelpers';
// Removed unused createEmptyUserState

const ARRAY_CHUNK_LIMIT = 5;

interface UseAppActionsArgs {
	userState: UserState | null;
	setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
	myIpnsKey: string;
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
	setAllPostsMap,
	setLatestStateCID,
	setUserProfilesMap,
	refreshFeed,
}: UseAppActionsArgs) => {

	const [isProcessing, setIsProcessing] = useState<boolean>(false);

	const addPost = useCallback(async (postData: NewPostData) => {
		if (!userState) { toast.error("User state not loaded."); return; }
		if (isProcessing) { toast.error("Please wait."); return; }

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
                updatedAt: timestamp
            };
            setUserState(newUserState);

            let stateToPublish: UserState | Partial<UserState> = newUserState;
            let previousStateCID: string | undefined = undefined;

            // --- FIX: Chunking Logic ONLY for postCIDs ---
            if ((newUserState.postCIDs ?? []).length > ARRAY_CHUNK_LIMIT) {
                console.log("[addPost] PostCIDs limit exceeded, creating chunk.");
                toast.loading("Chunking state...", { id: "chunking" });
                // Use the state *before* adding the new post CID
                const previousState = { ...userState, updatedAt: userState.updatedAt || timestamp - 1 };
                previousStateCID = await _uploadStateOnly(previousState);
                console.log("[addPost] Previous state CID:", previousStateCID);

                // Create the new chunk containing profile, timestamp, link, and *only the new post CID*
                stateToPublish = {
                    profile: newUserState.profile, // Keep current profile
                    updatedAt: newUserState.updatedAt, // Keep current timestamp
                    extendedUserState: previousStateCID, // Link to previous state
                    postCIDs: [finalPostCID], // Only the new post
                    // Ensure other arrays exist but are empty in the chunk
                    follows: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking");
            }
            // --- End Chunking Logic ---

			const headCID = await _uploadStateAndPublishToIpns(stateToPublish, myIpnsKey);
			setLatestStateCID(headCID);
			toast.success("Post published!");

		} catch (error) {
			toast.dismiss("post-upload");
            toast.dismiss("chunking");
			toast.error(`Publish failed: ${error instanceof Error ? error.message : "Unknown"}`);
			if (optimisticPost.thumbnailCid?.startsWith("blob:")) URL.revokeObjectURL(optimisticPost.thumbnailCid);
			setUserState(userState);
			setAllPostsMap((prev: Map<string, Post>) => {
				const map = new Map(prev);
				map.delete(tempId);
				return map;
			});
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, setUserState, setAllPostsMap, setLatestStateCID]);


	const likePost = useCallback(async (postId: string) => {
        if (!userState || isProcessing) return; if (postId.startsWith("temp-")) { toast.error("Wait publish."); return; }

        const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isLiked = liked.has(postId);
        isLiked ? liked.delete(postId) : liked.add(postId);
		disliked.delete(postId);

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now()
        };
		setUserState(newUserState); // Update UI optimistically

		try {
			setIsProcessing(true);

            // --- FIX: Removed chunking logic ---
            const stateToPublish: UserState | Partial<UserState> = newUserState;
            // --- End Fix ---

			const headCID = await _uploadStateAndPublishToIpns(stateToPublish, myIpnsKey);
			setLatestStateCID(headCID);
			toast.success(isLiked ? "Unliked" : "Liked");

		} catch (e) {
			setUserState(userState); // Revert UI
			toast.error(`Action failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, setUserState, setLatestStateCID]);

	const dislikePost = useCallback(async (postId: string) => {
        if (!userState || isProcessing) return; if (postId.startsWith("temp-")) { toast.error("Wait publish."); return; }

		const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isDisliked = disliked.has(postId);
		isDisliked ? disliked.delete(postId) : disliked.add(postId);
		liked.delete(postId);

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now()
        };
		setUserState(newUserState); // Update UI optimistically

		try {
			setIsProcessing(true);

            // --- FIX: Removed chunking logic ---
            const stateToPublish: UserState | Partial<UserState> = newUserState;
            // --- End Fix ---

			const headCID = await _uploadStateAndPublishToIpns(stateToPublish, myIpnsKey);
			setLatestStateCID(headCID);
			toast.success(isDisliked ? "Removed dislike" : "Disliked");

		} catch (e) {
			setUserState(userState); // Revert UI
			toast.error(`Action failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, setUserState, setLatestStateCID]);

	const followUser = useCallback(async (ipnsKeyToFollow: string) => {
		if (!userState || isProcessing || ipnsKeyToFollow === myIpnsKey) return;
		if (userState.follows?.some(f => f.ipnsKey === ipnsKeyToFollow)) { toast.error("Already following."); return; }

        const optimisticTimestamp = Date.now();
		const optimisticFollow: Follow = { ipnsKey: ipnsKeyToFollow, name: 'Loading...', lastSeenCid: '' };
		const optimisticUserState: UserState = {
            ...userState,
            follows: [...(userState.follows || []), optimisticFollow],
            updatedAt: optimisticTimestamp
        };
		setUserState(optimisticUserState);
		setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(ipnsKeyToFollow, { name: 'Loading...' }));

		try {
			setIsProcessing(true);
            let finalFollow: Follow;
            let finalUserState: UserState;

			await toast.promise((async () => {
				const state = await fetchUserStateByIpns(ipnsKeyToFollow);
				const name = state?.profile?.name || "Unknown";
				const cid = state.extendedUserState || '';
				finalFollow = { ipnsKey: ipnsKeyToFollow, name, lastSeenCid: cid };
				finalUserState = { ...optimisticUserState, follows: optimisticUserState.follows.map(f => f.ipnsKey === ipnsKeyToFollow ? finalFollow : f), };
                setUserState(finalUserState);
                setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(ipnsKeyToFollow, { name }));
			})(), { loading: "Resolving user...", success: "User found!", error: e => `Failed: ${e.message}` });

            // --- FIX: Removed chunking logic ---
            const stateToPublish: UserState | Partial<UserState> = finalUserState!;
            // --- End Fix ---

            const headCID = await _uploadStateAndPublishToIpns(stateToPublish, myIpnsKey);
			setLatestStateCID(headCID);
			toast.success(`Followed ${finalFollow!.name}!`);
			await refreshFeed();

		} catch (e) {
			setUserState(userState);
			setUserProfilesMap((prev: Map<string, UserProfile>) => { const map = new Map(prev); map.delete(ipnsKeyToFollow); return map; });
			console.error("Follow failed:", e);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, refreshFeed, setUserState, setUserProfilesMap, setLatestStateCID]);


	const unfollowUser = useCallback(async (ipnsKeyToUnfollow: string) => {
		if (!userState || isProcessing) return;
		const toRemove = userState.follows?.find(f => f.ipnsKey === ipnsKeyToUnfollow);
		if (!toRemove) return;
		const newUserState: UserState = { ...userState, follows: (userState.follows || []).filter(f => f.ipnsKey !== ipnsKeyToUnfollow), updatedAt: Date.now() };
		setUserState(newUserState); // Optimistic UI

		try {
			setIsProcessing(true);
            // No chunking logic needed/implemented for unfollow
            const stateToPublish: UserState | Partial<UserState> = newUserState;
			const headCID = await _uploadStateAndPublishToIpns(stateToPublish, myIpnsKey);
			setLatestStateCID(headCID);
			toast.success(`Unfollowed ${toRemove.name || "user"}.`);
			refreshFeed();
		} catch (e) {
			setUserState(userState); // Revert UI
            toast.error(`Unfollow failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, refreshFeed, setUserState, setLatestStateCID]);


	const updateProfile = useCallback(async (profileData: Partial<UserProfile>) => {
		if (!userState || isProcessing) return;
		const label = localStorage.getItem("currentUserLabel") || "";
		const newName = profileData.name || userState.profile.name || label;
		if (profileData.name && profileData.name !== label) localStorage.setItem("currentUserLabel", profileData.name);
		const newUserState: UserState = { ...userState, profile: { ...userState.profile, name: newName, ...profileData }, updatedAt: Date.now() };
		setUserState(newUserState); // Optimistic UI
		setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(myIpnsKey, newUserState.profile));
		try {
			setIsProcessing(true);
            // No chunking needed for profile update
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey);
			setLatestStateCID(headCID);
			toast.success("Profile updated!");
		} catch (e) {
			setUserState(userState); // Revert UI
			setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(myIpnsKey, userState.profile));
			localStorage.setItem("currentUserLabel", label);
            toast.error(`Profile update failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, setUserState, setUserProfilesMap, setLatestStateCID]);

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