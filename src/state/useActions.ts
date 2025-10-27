// fileName: src/hooks/useActions.ts
import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { NewPostData, Post, UserState, Follow, UserProfile } from '../types';
import {
    uploadPost,
    _uploadStateAndPublishToIpns,
    _uploadStateOnly,
    fetchUserStateByIpns,
    // --- START MODIFICATION: Import pruneContentFromKubo ---
    pruneContentFromKubo,
    // --- END MODIFICATION ---
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
    // --- START MODIFICATION: Add allPostsMap ---
    allPostsMap: Map<string, Post>;
    // --- END MODIFICATION ---
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
    // --- START MODIFICATION: Destructure allPostsMap ---
    allPostsMap,
    // --- END MODIFICATION ---
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

            // --- FIX: Use Set to guarantee uniqueness on write ---
            const newPostCIDs = [finalPostCID, ...(userState.postCIDs || [])];
            // --- END FIX ---

            const newUserState: UserState = {
                ...userState,
                // --- FIX: Use unique array ---
                postCIDs: [...new Set(newPostCIDs)],
                // --- END FIX ---
                updatedAt: timestamp,
                // --- FIX: Preserve existing link during optimistic update ---
                extendedUserState: userState.extendedUserState || null
            };
            setUserState(newUserState);

            let stateToPublish: UserState | Partial<UserState>;
            
            // --- FIX: Check length of *previous* state. If it was full, commit. ---
            if ((userState.postCIDs ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[addPost] PostCIDs limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking" });

                // Create the new chunk containing profile, timestamp, link, and *only the new post CID*
                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    // Link to the head state *before* this post was added (which is now full)
                    extendedUserState: currentHeadCID,
                    postCIDs: [finalPostCID], // Only the new post
                    // Ensure other arrays exist but are empty in the chunk
                    follows: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking");
            } else {
                // --- FIX: Accumulate. Publish the full state, preserving the *original* extendedUserStae link ---
                console.log("[addPost] Accumulating post on current head.");
                stateToPublish = newUserState; // This object already has the correct preserved link
            }

            // --- FIX: Remove currentHeadCID argument. The link is now set inside stateToPublish. ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
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
        // --- FIX: This logic already correctly uses a Set, ensuring uniqueness ---
        const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isLiked = liked.has(postId);
        isLiked ? liked.delete(postId) : liked.add(postId);
		disliked.delete(postId); // Liking removes dislike
        // --- END FIX ---

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now(),
            // --- FIX: Preserve existing link during optimistic update ---
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); // Update UI optimistically

		try {
			setIsProcessing(true);

            let stateToPublish: UserState | Partial<UserState>;

            // --- FIX: Check length of *previous* state. Commit if adding and full. ---
            if (!isLiked && (userState.likedPostCIDs ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[likePost] likedPostCIDs limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking-like" });

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: currentHeadCID, // Link to full head
                    likedPostCIDs: [postId], // Only the new like
                    dislikedPostCIDs: [], // Action clears dislikes
                    postCIDs: [],
                    follows: [],
                };
                toast.dismiss("chunking-like");
            } else {
                // --- FIX: Accumulate. Publish full state, preserving original link. ---
                console.log("[likePost] Accumulating like on current head.");
                stateToPublish = newUserState;
            }

            // --- FIX: Remove currentHeadCID argument ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
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
		// --- FIX: This logic already correctly uses a Set, ensuring uniqueness ---
        const liked = new Set(userState.likedPostCIDs || []);
		const disliked = new Set(userState.dislikedPostCIDs || []);
		const isDisliked = disliked.has(postId);
		isDisliked ? disliked.delete(postId) : disliked.add(postId);
		liked.delete(postId); // Disliking removes like
        // --- END FIX ---

        // --- START MODIFICATION: Pruning Logic ---
        const isDislikingNow = !isDisliked; // We are *adding* a dislike
        if (isDislikingNow) {
            const postToPrune = allPostsMap.get(postId);
            if (postToPrune) {
                const cidsToPrune: (string | undefined)[] = [];
                const mfsPathsToPrune: (string | undefined)[] = [];

                // 1. Add Post, Media, and Thumbnail CIDs to unpin list
                cidsToPrune.push(postToPrune.id); // The post JSON CID
                cidsToPrune.push(postToPrune.mediaCid);
                cidsToPrune.push(postToPrune.thumbnailCid);

                // 2. If we are the author, also remove files from MFS
                if (postToPrune.authorKey === myIpnsKey) {
                    const userLabel = sessionStorage.getItem("currentUserLabel") || "";
                    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
                    const directoryName = `dSocialApp-${sanitizedLabel}`;

                    // Add thumbnail path (predictable name)
                    if (postToPrune.thumbnailCid) {
                        // Assuming thumbnail is always 'thumbnail.jpg'. 
                        // Note: This is fragile. A better implementation would store the thumbnail *filename*
                        // during upload, just like we do for 'file' types.
                        // For now, we assume 'thumbnail.jpg' from media.ts
                        mfsPathsToPrune.push(`/${directoryName}/thumbnail.jpg`);
                    }
                    // Add 'file' type path (fileName is stored)
                    if (postToPrune.mediaType === 'file' && postToPrune.fileName) {
                        mfsPathsToPrune.push(`/${directoryName}/${postToPrune.fileName}`);
                    }
                    // NOTE: We still can't prune image/video media from MFS reliably
                    // because the original filename isn't stored on the post object in a predictable way.
                    // We *could* try to remove `/${directoryName}/${postToPrune.fileName}`
                    // if fileName exists, but media.ts doesn't set fileName for images/videos.
                }
                
                // 3. Trigger pruning as a background task (fire-and-forget)
                // This unpins, removes from MFS, and runs GC.
                pruneContentFromKubo(cidsToPrune, mfsPathsToPrune)
                    .then(() => toast.success("Post pruned from node.", { icon: "🧹" }))
                    .catch(e => toast.error(`Pruning failed: ${e instanceof Error ? e.message : "Unknown"}`));
            }
        }
        // --- END MODIFICATION ---

		const newUserState: UserState = {
            ...userState,
            likedPostCIDs: Array.from(liked),
            dislikedPostCIDs: Array.from(disliked),
            updatedAt: Date.now(),
            // --- FIX: Preserve existing link during optimistic update ---
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); // Update UI optimistically

		try {
			setIsProcessing(true);

            let stateToPublish: UserState | Partial<UserState>;

            // --- FIX: Check length of *previous* state. Commit if adding and full. ---
            if (!isDisliked && (userState.dislikedPostCIDs ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[dislikePost] dislikedPostCIDs limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking-dislike" });

                stateToPublish = {
                    profile: newUserState.profile,
                    updatedAt: newUserState.updatedAt,
                    extendedUserState: currentHeadCID, // Link to full head
                    dislikedPostCIDs: [postId], // Only the new dislike
                    likedPostCIDs: [], // Action clears likes
                    postCIDs: [],
                    follows: [],
                };
                toast.dismiss("chunking-dislike");
            } else {
                // --- FIX: Accumulate. Publish full state, preserving original link. ---
                console.log("[dislikePost] Accumulating dislike on current head.");
                stateToPublish = newUserState;
            }

            // --- FIX: Remove currentHeadCID argument ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
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
        // --- START MODIFICATION: Add allPostsMap to dependency array ---
	}, [userState, isProcessing, myIpnsKey, latestStateCID, setUserState, setLatestHeadCID, allPostsMap]);
    // --- END MODIFICATION ---

	const followUser = useCallback(async (ipnsKeyToFollow: string) => {
		if (!userState || isProcessing || ipnsKeyToFollow === myIpnsKey) return;
		if (userState.follows?.some(f => f.ipnsKey === ipnsKeyToFollow)) { toast.error("Already following."); return; }

        const currentHeadCID = latestStateCID; // Capture CID before action
        const optimisticTimestamp = Date.now();
		const optimisticFollow: Follow = { ipnsKey: ipnsKeyToFollow, name: 'Loading...', lastSeenCid: '' };
		
        // --- FIX: This check already prevents duplicates on write ---
        const optimisticUserState: UserState = {
            ...userState,
            follows: [...(userState.follows || []), optimisticFollow],
            updatedAt: optimisticTimestamp,
            // --- FIX: Preserve existing link during optimistic update ---
            extendedUserState: userState.extendedUserState || null
        };
        // --- END FIX ---
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
                    ...optimisticUserState, // Includes preserved link
                    follows: optimisticUserState.follows.map(f => f.ipnsKey === ipnsKeyToFollow ? finalFollow : f),
                };
                setUserState(finalUserState); // Update UI with resolved name
                setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(ipnsKeyToFollow, { name }));
			})(), { loading: "Resolving user...", success: "User found!", error: e => `Failed: ${e instanceof Error ? e.message : "Unknown"}` });

            let stateToPublish: UserState | Partial<UserState>;

            // --- FIX: Check length of *previous* state. Commit if adding and full. ---
            if ((userState.follows ?? []).length >= ARRAY_CHUNK_LIMIT) {
                console.log("[followUser] follows limit reached, committing head and creating new chunk.");
                toast.loading("Chunking state...", { id: "chunking-follow" });

                stateToPublish = {
                    profile: finalUserState!.profile,
                    updatedAt: finalUserState!.updatedAt,
                    extendedUserState: currentHeadCID, // Link to full head
                    follows: [finalFollow!], // Only the new follow
                    postCIDs: [],
                    likedPostCIDs: [],
                    dislikedPostCIDs: [],
                };
                toast.dismiss("chunking-follow");
            } else {
                 // --- FIX: Accumulate. Publish full state, preserving original link. ---
                console.log("[followUser] Accumulating follow on current head.");
                stateToPublish = finalUserState!;
            }

            // --- FIX: Remove currentHeadCID argument ---
            const headCID = await _uploadStateAndPublishToIpns(
                stateToPublish,
                myIpnsKey
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

        // --- REMOVED: currentHeadCID no longer needed for remove actions ---
		const newUserState: UserState = {
            ...userState,
            follows: (userState.follows || []).filter(f => f.ipnsKey !== ipnsKeyToUnfollow),
            updatedAt: Date.now(),
            // --- FIX: Preserve existing link. This is an "accumulate" action. ---
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); // Optimistic UI

		try {
			setIsProcessing(true);
            // --- FIX: Remove currentHeadCID argument ---
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey);
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
	}, [userState, isProcessing, myIpnsKey, refreshFeed, setUserState, setLatestHeadCID]);


	const updateProfile = useCallback(async (profileData: Partial<UserProfile>) => {
		if (!userState || isProcessing) return;

        // --- REMOVED: currentHeadCID no longer needed for profile update ---
		const label = sessionStorage.getItem("currentUserLabel") || "";
		const newName = profileData.name || userState.profile.name || label;
		if (profileData.name && profileData.name !== label) sessionStorage.setItem("currentUserLabel", profileData.name);

		const newUserState: UserState = {
            ...userState,
            profile: { ...userState.profile, name: newName, ...profileData },
            updatedAt: Date.now(),
            // --- FIX: Preserve existing link. This is an "accumGulate" action. ---
            extendedUserState: userState.extendedUserState || null
        };
		setUserState(newUserState); // Optimistic UI
		setUserProfilesMap((prev: Map<string, UserProfile>) => new Map(prev).set(myIpnsKey, newUserState.profile));
		try {
			setIsProcessing(true);
            // --- FIX: Remove currentHeadCID argument ---
            const headCID = await _uploadStateAndPublishToIpns(newUserState, myIpnsKey);
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