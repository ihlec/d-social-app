// fileName: src/hooks/useActions.ts
import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { NewPostData, Post, UserState, Follow, UserProfile } from '../types';
import {
    uploadPost,
    _uploadStateAndPublishToIpns,
    _uploadStateOnly,
    fetchUserStateByIpns,
    pruneContentFromKubo, // Correct import
} from './stateActions';

const ARRAY_CHUNK_LIMIT = 5;

interface UseAppActionsArgs {
	userState: UserState | null;
	setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
	myIpnsKey: string;
    latestStateCID: string;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	refreshFeed: (force?: boolean) => Promise<void>;
    allPostsMap: Map<string, Post>;
}

/**
 * Manages all user actions that mutate state (post, like, follow, etc.).
 * Also manages the `isProcessing` state.
 */
export const useAppActions = ({
	userState, setUserState,
    myIpnsKey,
    latestStateCID, // CID *before* the action
	setAllPostsMap,
	setLatestStateCID: setLatestHeadCID, // Rename for clarity within hook
	setUserProfilesMap,
	refreshFeed,
    allPostsMap,
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
			if (optimisticPost.mediaType !== 'file') {
                 // Create a blob URL for immediate preview
                 optimisticPost.thumbnailCid = URL.createObjectURL(file); 
            } else {
                 optimisticPost.fileName = file.name; // Use original name for 'file' type display
            }
		}
        setAllPostsMap((prev: Map<string, Post>) => new Map(prev).set(tempId, optimisticPost));

		try {
			setIsProcessing(true);
			toast.loading("Uploading post data...", { id: "post-upload" });

			const { finalPost, finalPostCID } = await uploadPost(postData, myIpnsKey);
			toast.dismiss("post-upload");
            // Clean up the temporary blob URL used for preview
            if (optimisticPost.thumbnailCid?.startsWith("blob:")) {
                URL.revokeObjectURL(optimisticPost.thumbnailCid);
            }

			setAllPostsMap((prev: Map<string, Post>) => {
				const map = new Map(prev);
				map.delete(tempId);
                // Merge optimisticPost data (like temp thumbnail) with finalPost data
				map.set(finalPostCID, { ...optimisticPost, ...finalPost, id: finalPostCID }); 
				return map;
			});

            const newPostCIDs = [finalPostCID, ...(userState.postCIDs || [])];

            const newUserState: UserState = {
                ...userState,
                postCIDs: [...new Set(newPostCIDs)],
                updatedAt: timestamp,
                extendedUserState: userState.extendedUserState || null
            };
            setUserState(newUserState);

            let stateToPublish: UserState | Partial<UserState>;
            
            if ((userState.postCIDs ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[addPost] PostCIDs limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking" });

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: currentHeadCID,
                    postCIDs: [finalPostCID], // Only the new post
                    follows: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking");
            } else {
                console.log("[addPost] Accumulating post on current head.");
                stateToPublish = newUserState; 
            }

            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
            );
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

        const currentHeadCID = latestStateCID; 
        const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isLiked = liked.has(postId);
        isLiked ? liked.delete(postId) : liked.add(postId);
		disliked.delete(postId); 

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); 

		try {
			setIsProcessing(true);

            let stateToPublish: UserState | Partial<UserState>;

            if (!isLiked && (userState.likedPostCIDs ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[likePost] likedPostCIDs limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking-like" });

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: currentHeadCID, 
                    likedPostCIDs: [postId], 
                    dislikedPostCIDs: [], 
                    postCIDs: [],
                    follows: [],
                };
                toast.dismiss("chunking-like");
            } else {
                console.log("[likePost] Accumulating like on current head.");
                stateToPublish = newUserState;
            }

            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
            );
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

        const currentHeadCID = latestStateCID; 
        const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isDisliked = disliked.has(postId);
		isDisliked ? disliked.delete(postId) : disliked.add(postId);
		liked.delete(postId); 

        const isDislikingNow = !isDisliked; 
        if (isDislikingNow) {
            const postToPrune = allPostsMap.get(postId);
            if (postToPrune) {
                // --- START MODIFICATION: Pass post object ---
                pruneContentFromKubo(postToPrune)
                    .then(() => toast.success("Post pruned from node.", { icon: "🧹" }))
                    .catch(e => toast.error(`Pruning failed: ${e instanceof Error ? e.message : "Unknown"}`));
                // --- END MODIFICATION ---
            }
        }

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); 

		try {
			setIsProcessing(true);

            let stateToPublish: UserState | Partial<UserState>;

            if (!isDisliked && (userState.dislikedPostCIDs ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[dislikePost] dislikedPostCIDs limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking-dislike" });

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: currentHeadCID, 
                    dislikedPostCIDs: [postId], 
                    likedPostCIDs: [], 
                    postCIDs: [],
                    follows: [],
                };
                toast.dismiss("chunking-dislike");
            } else {
                console.log("[dislikePost] Accumulating dislike on current head.");
                stateToPublish = newUserState;
            }

            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
            );
			setLatestHeadCID(headCID);
			toast.success(isDisliked ? "Removed dislike" : "Disliked");

		} catch (e) {
            toast.dismiss("chunking-dislike");
			setUserState(userState); // Revert UI
			toast.error(`Action failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, latestStateCID, setUserState, setLatestHeadCID, allPostsMap]);


	const followUser = useCallback(async (ipnsKeyToFollow: string) => {
		if (!userState || isProcessing || ipnsKeyToFollow === myIpnsKey) return;
		if (userState.follows?.some(f => f.ipnsKey === ipnsKeyToFollow)) { toast.error("Already following."); return; }

        const currentHeadCID = latestStateCID; 
        const optimisticTimestamp = Date.now();
		const optimisticFollow: Follow = { ipnsKey: ipnsKeyToFollow, name: 'Loading...', lastSeenCid: '' };
		
        const optimisticUserState: UserState = {
            ...userState,
            follows: [...(userState.follows || []), optimisticFollow],
            updatedAt: optimisticTimestamp,
            extendedUserState: userState.extendedUserState || null
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
				finalUserState = {
                    ...optimisticUserState, 
                    follows: optimisticUserState.follows.map(f => f.ipnsKey === ipnsKeyToFollow ? finalFollow : f),
                };
                setUserState(finalUserState); 
                setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(ipnsKeyToFollow, { name }));
			})(), { loading: "Resolving user...", success: "User found!", error: e => `Failed: ${e instanceof Error ? e.message : "Unknown"}` });

            let stateToPublish: UserState | Partial<UserState>;

            if ((userState.follows ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[followUser] follows limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking-follow" });

                stateToPublish = {
                    profile: finalUserState!.profile,
                    updatedAt: finalUserState!.updatedAt,
                    extendedUserState: currentHeadCID, 
                    follows: [finalFollow!], 
                    postCIDs: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking-follow");
            } else {
                console.log("[followUser] Accumulating follow on current head.");
                stateToPublish = finalUserState!;
            }

            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
            );
			setLatestHeadCID(headCID);
			toast.success(`Followed ${finalFollow!.name}!`);
			await refreshFeed(); 

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

		const newUserState: UserState = {
            ...userState,
            follows: (userState.follows || []).filter(f => f.ipnsKey !== ipnsKeyToUnfollow),
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); // Optimistic UI

		try {
			setIsProcessing(true);
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey);
			setLatestHeadCID(headCID);
			toast.success(`Unfollowed ${toRemove.name || "user"}.`);
			refreshFeed(true); // Force refresh 
		} catch (e) {
			setUserState(userState); // Revert UI
            toast.error(`Unfollow failed: ${e instanceof Error ? e.message : "Unknown"}`);
		} finally {
			setIsProcessing(false);
		}
	}, [userState, isProcessing, myIpnsKey, refreshFeed, setUserState, setLatestHeadCID]);


	const updateProfile = useCallback(async (profileData: Partial<UserProfile>) => {
		if (!userState || isProcessing) return;

		const label = sessionStorage.getItem("currentUserLabel") || "";
		const newName = profileData.name || userState.profile.name || label;
		if (profileData.name && profileData.name !== label) sessionStorage.setItem("currentUserLabel", profileData.name);

		const newUserState: UserState = {
            ...userState,
            profile: { ...userState.profile, name: newName, ...profileData },
            updatedAt: Date.now(),
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); // Optimistic UI
		setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(myIpnsKey, newUserState.profile));
		try {
			setIsProcessing(true);
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey);
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
	}, [userState, isProcessing, myIpnsKey, setUserState, setUserProfilesMap, setLatestHeadCID]);

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