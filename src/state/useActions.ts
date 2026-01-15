// fileName: src/state/useActions.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { NewPostData, Post, UserState, Follow, UserProfile } from '../types';
import {
    uploadPost,
    uploadStateToIpfs,
    publishStateToIpns, // <--- Crucial Import
} from './stateActions';
import { 
    resolveIpns, 
    mirrorUser, 
    pinCid, 
    unpinCid, 
    getSession, 
    ensureBlockLocal, 
    fetchKubo,
    fetchUserStateChunk 
} from '../api/ipfsIpns'; 
import { MAX_POSTS_PER_STATE } from '../constants';
import { reportFetchSuccess } from '../lib/fetchBackoff';

// Helper
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface UseAppActionsArgs {
    userState: UserState | null;
    setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
    myIpnsKey: string; 
    myPeerId: string;  
    latestStateCID: string;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    allPostsMap: Map<string, Post>; 
}

export const useAppActions = ({
    userState, setUserState,
    myIpnsKey,
    myPeerId,
    latestStateCID,
    setAllPostsMap,
    setLatestStateCID: setLatestHeadCID,
    setUserProfilesMap,
    allPostsMap 
}: UseAppActionsArgs) => {

    const [isProcessing, setIsProcessing] = useState(false);
    const actionQueue = useRef<Promise<any>>(Promise.resolve());
    const persistenceQueue = useRef<Promise<any>>(Promise.resolve());
    const hasRepairedRef = useRef(false);

    // --- Pending Updates Buffer ---
    const pendingFollowUpdatesRef = useRef<Map<string, { cid: string; name?: string }>>(new Map());

    const allPostsMapRef = useRef(allPostsMap);
    const userStateRef = useRef(userState);

    useEffect(() => {
        allPostsMapRef.current = allPostsMap;
    }, [allPostsMap]);

    useEffect(() => {
        userStateRef.current = userState;
    }, [userState]);
    
    const queueAction = useCallback(<T>(name: string, action: (currentState: UserState) => Promise<T>): Promise<T> => {
        const nextAction = actionQueue.current.then(async () => {
             if (!userStateRef.current) throw new Error("No user state");
             
             const result = await action(userStateRef.current);

             // Update local ref immediately for next queued action
             if (result && typeof result === 'object' && 'newState' in result) {
                 userStateRef.current = (result as { newState: UserState }).newState;
             }

             return result;
        });
        actionQueue.current = nextAction.catch(e => console.error(`Action ${name} failed`, e));
        return nextAction;
    }, []);

    // --- PERSISTENCE QUEUE ---
    const queuePersistence = useCallback((state: UserState) => {
        const next = persistenceQueue.current.then(async () => {
             // Upload
             const stateCid = await uploadStateToIpfs(state, myIpnsKey);
             // Update Reference
             setLatestHeadCID(stateCid);
             // Publish
             await publishStateToIpns(stateCid, myIpnsKey);
        });
        persistenceQueue.current = next.catch(e => console.error("Persistence failed", e));
    }, [myIpnsKey, setLatestHeadCID]);

    // --- HELPER: Merge Pending Updates ---
    const mergePendingUpdates = useCallback((state: UserState): UserState => {
        if (pendingFollowUpdatesRef.current.size === 0) return state;

        console.log(`[Actions] Piggybacking ${pendingFollowUpdatesRef.current.size} background updates onto this interaction.`);
        
        let hasChanges = false;
        const newFollows = state.follows.map(f => {
            const pending = pendingFollowUpdatesRef.current.get(f.ipnsKey);
            if (!pending) return f;

            let updatedF = { ...f };
            let changed = false;

            if (pending.cid && pending.cid !== f.lastSeenCid) {
                updatedF.lastSeenCid = pending.cid;
                changed = true;
            }
            
            if (pending.name && pending.name !== f.name && pending.name.length > 0) {
                 updatedF.name = pending.name;
                 changed = true;
            }

            if (changed) {
                hasChanges = true;
                updatedF.updatedAt = Date.now();
                return updatedF;
            }
            return f;
        });

        if (!hasChanges) return state;

        pendingFollowUpdatesRef.current.clear();
        return { ...state, follows: newFollows };
    }, []);

    // --- Queue Function (Exposed to Feed) ---
    const queueFollowUpdates = useCallback((updates: Follow[]) => {
        let count = 0;
        updates.forEach(u => {
            if (u.ipnsKey && u.lastSeenCid) {
                const existing = pendingFollowUpdatesRef.current.get(u.ipnsKey);
                const nameToStore = u.name || existing?.name;

                pendingFollowUpdatesRef.current.set(u.ipnsKey, { 
                    cid: u.lastSeenCid, 
                    name: nameToStore 
                });
                count++;
            }
        });
        if (count > 0) {
            console.log(`[Actions] Queued ${count} follow updates for next interaction.`);
        }
    }, []);

    // --- SELF HEALING: MULTI-USER AWARE GC ---
    const repairPins = useCallback(async () => {
        const currentUserState = userStateRef.current;
        const currentPostsMap = allPostsMapRef.current;

        if (!currentUserState) return;
        
        const session = getSession();
        if (session.sessionType !== 'kubo' || !session.rpcApiUrl) return;
        const auth = { username: session.kuboUsername, password: session.kuboPassword };

        const keepSet = new Set<string>();
        
        const addToKeepSet = (ids: string[] | undefined) => {
            if (!ids) return;
            ids.forEach(cid => keepSet.add(cid));
        };

        addToKeepSet(currentUserState.postCIDs);
        addToKeepSet(currentUserState.likedPostCIDs);
        
        try {
            const keysRes = await fetchKubo(session.rpcApiUrl, '/api/v0/key/list', undefined, undefined, auth);
            if (keysRes && Array.isArray(keysRes.Keys)) {
                const otherLocalKeys = keysRes.Keys.filter((k: { Id: string }) => k.Id !== myPeerId);
                for (const key of otherLocalKeys) {
                    try {
                        const stateCid = await resolveIpns(key.Id);
                        if (stateCid) {
                            const peerState = await fetchUserStateChunk(stateCid);
                            if (peerState) {
                                if (peerState.postCIDs) peerState.postCIDs.forEach(cid => keepSet.add(cid));
                                if (peerState.likedPostCIDs) peerState.likedPostCIDs.forEach(cid => keepSet.add(cid));
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { return; }

        for (const cid of Array.from(keepSet)) {
             const post = currentPostsMap.get(cid);
             if (post) {
                 if (post.mediaCid && !post.mediaCid.startsWith('http')) keepSet.add(post.mediaCid);
                 if (post.thumbnailCid && !post.thumbnailCid.startsWith('http')) keepSet.add(post.thumbnailCid);
             }
        }

        let gcCount = 0;
        let localPinSet: Set<string> | null = null;
        try {
            const pinRes = await fetchKubo(session.rpcApiUrl!, '/api/v0/pin/ls', { type: 'recursive' }, undefined, auth, 20000);
            if (pinRes && pinRes.Keys) localPinSet = new Set(Object.keys(pinRes.Keys));
        } catch (e) { return; }

        // Repair
        for (const cid of keepSet) {
             if (localPinSet && localPinSet.has(cid)) continue;
             try {
                await fetchKubo(session.rpcApiUrl!, '/api/v0/block/stat', { arg: cid }, undefined, auth, 1000);
                pinCid(cid).catch(() => {});
             } catch(e) {
                if (currentUserState.postCIDs.includes(cid) || currentUserState.likedPostCIDs?.includes(cid)) {
                    await ensureBlockLocal(cid);
                    await sleep(2000);
                }
             }
             await sleep(20);
        }

        // GC
        if (localPinSet && localPinSet.size > 0) {
            const safeUnpin = async (cid: string) => {
                if (!cid || cid.startsWith('http')) return;
                if (localPinSet!.has(cid) && !keepSet.has(cid)) {
                    try {
                        await unpinCid(cid);
                        gcCount++;
                        localPinSet!.delete(cid); 
                    } catch(e) { /* ignore */ }
                    await sleep(1000); 
                }
            };
            const postsArray = Array.from(currentPostsMap.entries());
            for (const [id, post] of postsArray) {
                 await safeUnpin(id);
                 if (post.mediaCid) await safeUnpin(post.mediaCid);
                 if (post.thumbnailCid) await safeUnpin(post.thumbnailCid);
                 if (gcCount > 0 && gcCount % 5 === 0) await sleep(500); 
            }
        }
        if (gcCount > 0) toast.success(`Cleaned up ${gcCount} stale files.`);
        
    }, [myPeerId]); 

    useEffect(() => {
        if (userStateRef.current && myPeerId && !hasRepairedRef.current) {
            hasRepairedRef.current = true;
            setTimeout(repairPins, 30000);
        }
    }, [myPeerId, repairPins]);


    const addPost = useCallback(async (postData: NewPostData) => {
        if (!userState) return;
        setIsProcessing(true);
        
        try {
            const { finalPost, finalPostCID } = await uploadPost(postData, myPeerId);

            const newPostObject: Post = {
                ...finalPost,
                id: finalPostCID,
                replies: [] 
            };

            await queueAction('addPost', async (rawState) => {
                const currentState = mergePendingUpdates(rawState);
                const currentPosts = currentState.postCIDs || [];
                
                let newPostCIDs: string[];
                let newExtendedState: string | null | undefined;

                if (currentPosts.length >= MAX_POSTS_PER_STATE) {
                    newPostCIDs = [newPostObject.id];
                    newExtendedState = latestStateCID;
                } else {
                    newPostCIDs = [newPostObject.id, ...currentPosts];
                    newExtendedState = currentState.extendedUserState;
                }

                const newState: UserState = { 
                    ...currentState, 
                    postCIDs: newPostCIDs, 
                    updatedAt: Date.now(),
                    extendedUserState: newExtendedState 
                };
                
                setAllPostsMap(prev => new Map(prev).set(newPostObject.id, newPostObject));
                
                const stateCid = await uploadStateToIpfs(newState, myIpnsKey);
                
                // Publish (Persist)
                publishStateToIpns(stateCid, myIpnsKey).catch(console.error);
                
                setLatestHeadCID(stateCid);
                setUserState(newState);
                return { newState, cid: stateCid };
            });

            toast.success("Post created!");
        } catch (error) {
            console.error(error);
            toast.error("Failed to create post.");
        } finally {
            setIsProcessing(false);
        }
    }, [userState, myPeerId, myIpnsKey, latestStateCID, setAllPostsMap, setLatestHeadCID, setUserState, queueAction, mergePendingUpdates]);


    const deletePost = useCallback(async (postId: string) => {
        setIsProcessing(true);
        try {
             await queueAction('deletePost', async (rawState) => {
                const currentState = mergePendingUpdates(rawState);
                const updatedPosts = currentState.postCIDs.filter(id => id !== postId);
                
                const newState = { 
                    ...currentState, 
                    postCIDs: updatedPosts, 
                    updatedAt: Date.now(),
                    extendedUserState: currentState.extendedUserState 
                };
                
                const stateCid = await uploadStateToIpfs(newState, myIpnsKey);
                // Publish (Persist)
                publishStateToIpns(stateCid, myIpnsKey).catch(console.error);

                setLatestHeadCID(stateCid);
                setUserState(newState);
                return { newState, cid: stateCid };
             });
             toast.success("Post deleted");
        } catch(e) {
            toast.error("Failed to delete");
        } finally {
            setIsProcessing(false);
        }
    }, [userState, myIpnsKey, queueAction, setLatestHeadCID, setUserState, mergePendingUpdates]);


    const likePost = useCallback(async (postId: string) => {
        const loadedPost = allPostsMapRef.current.get(postId);
        if (!loadedPost || loadedPost.timestamp === 0) {
            toast.error("Please wait for post data to load.");
            return;
        }

        queueAction('likePost', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);
            const currentLikes = currentState.likedPostCIDs || [];
            let newLikes: string[];
            const isLiked = currentLikes.includes(postId);
            
            if (isLiked) {
                newLikes = currentLikes.filter(id => id !== postId);
            } else {
                newLikes = [...currentLikes, postId];
                reportFetchSuccess(postId); 
                if (loadedPost) ensureBlockLocal(postId, loadedPost);
                if (loadedPost.mediaCid && !loadedPost.mediaCid.startsWith('http')) ensureBlockLocal(loadedPost.mediaCid);
                if (loadedPost.thumbnailCid && !loadedPost.thumbnailCid.startsWith('http')) ensureBlockLocal(loadedPost.thumbnailCid);
            }

            const newDislikes = (currentState.dislikedPostCIDs || []).filter(id => id !== postId);
            
            const newState = { 
                ...currentState, 
                likedPostCIDs: newLikes, 
                dislikedPostCIDs: newDislikes,
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState 
            };
            
            setUserState(newState);
            queuePersistence(newState);
            
            return { newState };
        });
    }, [myIpnsKey, setUserState, queueAction, mergePendingUpdates, queuePersistence]);


    const dislikePost = useCallback(async (postId: string) => {
        queueAction('dislikePost', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);
            const currentDislikes = currentState.dislikedPostCIDs || [];
            let newDislikes: string[];

            if (currentDislikes.includes(postId)) {
                newDislikes = currentDislikes.filter(id => id !== postId);
            } else {
                newDislikes = [...currentDislikes, postId];
            }

            const newLikes = (currentState.likedPostCIDs || []).filter(id => id !== postId);

            const newState = { 
                ...currentState, 
                likedPostCIDs: newLikes, 
                dislikedPostCIDs: newDislikes,
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState 
            };
            
            setUserState(newState);
            queuePersistence(newState);
            
            return { newState };
        });
    }, [myIpnsKey, setUserState, queueAction, mergePendingUpdates, queuePersistence]);


    const followUser = useCallback(async (ipnsKey: string) => {
        setIsProcessing(true);
        try {
            await queueAction('followUser', async (rawState) => {
                const currentState = mergePendingUpdates(rawState);

                if (currentState.follows.some(f => f.ipnsKey === ipnsKey)) return currentState;

                // Default to a placeholder
                let name = ipnsKey.substring(0,8) + '...';
                let latestCid = '';
                
                try {
                     // OPTIMIZATION: Race network vs 2s timeout. 
                     // If network is slow, don't block the UI. The background healer will fix it later.
                     const resolvePromise = resolveIpns(ipnsKey);
                     const timeoutPromise = new Promise<string>((_, reject) => 
                        setTimeout(() => reject(new Error("Timeout")), 2000)
                     );

                     latestCid = await Promise.race([resolvePromise, timeoutPromise]);
                     
                     if (latestCid) {
                         const state = await fetchUserStateChunk(latestCid);
                         if (state?.profile?.name) name = state.profile.name;
                     }
                } catch(e) { 
                    console.log("[Follow] Network resolve slow/failed, proceeding with optimistic follow.");
                }
                
                const newFollow: Follow = { ipnsKey, name, lastSeenCid: latestCid, updatedAt: Date.now() };
                const newFollows = [...currentState.follows, newFollow];
                
                const newState = { 
                    ...currentState, 
                    follows: newFollows, 
                    updatedAt: Date.now(),
                    extendedUserState: currentState.extendedUserState 
                };
                
                setUserState(newState);
                queuePersistence(newState);

                mirrorUser(ipnsKey, latestCid).catch(e => console.warn(`[Follow] Mirror failed`, e));

                toast.success(`Followed user!`);
                return { newState };
            });
        } catch(e) {
            toast.error("Follow failed");
        } finally {
            setIsProcessing(false);
        }
    }, [myIpnsKey, latestStateCID, queueAction, setUserState, mergePendingUpdates, queuePersistence]);


    const unfollowUser = useCallback(async (ipnsKey: string) => {
        queueAction('unfollowUser', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);

            const newFollows = currentState.follows.filter(f => f.ipnsKey !== ipnsKey);
            
            const newState = { 
                ...currentState, 
                follows: newFollows, 
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState 
            };
            
            setUserState(newState);
            queuePersistence(newState);
            
            toast.success(`Unfollowed user`);
            return { newState };
        });
    }, [myIpnsKey, latestStateCID, queueAction, mergePendingUpdates, queuePersistence]);


    const blockUser = useCallback(async (ipnsKey: string) => {
        queueAction('blockUser', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);
            const currentBlocked = currentState.blockedUsers || [];
            
            if (currentBlocked.includes(ipnsKey)) return currentState;

            // Add to blocked list
            const newBlocked = [...currentBlocked, ipnsKey];

            // Auto-Unfollow if followed
            const newFollows = currentState.follows.filter(f => f.ipnsKey !== ipnsKey);

            const newState = { 
                ...currentState, 
                follows: newFollows,
                blockedUsers: newBlocked,
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState 
            };
            
            setUserState(newState);
            queuePersistence(newState);
            
            toast.success(`Blocked user`);
            return { newState };
        });
    }, [myIpnsKey, queueAction, mergePendingUpdates, queuePersistence, setUserState]);

    const unblockUser = useCallback(async (ipnsKey: string) => {
        queueAction('unblockUser', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);
            const currentBlocked = currentState.blockedUsers || [];
            
            if (!currentBlocked.includes(ipnsKey)) return currentState;

            const newBlocked = currentBlocked.filter(id => id !== ipnsKey);

            const newState = { 
                ...currentState, 
                blockedUsers: newBlocked,
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState 
            };
            
            setUserState(newState);
            queuePersistence(newState);
            
            toast.success(`Unblocked user`);
            return { newState };
        });
    }, [myIpnsKey, queueAction, mergePendingUpdates, queuePersistence, setUserState]);



    const updateProfile = useCallback(async (profileData: Partial<UserProfile>) => {
        queueAction('updateProfile', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);

            const label = sessionStorage.getItem("currentUserLabel") || "";
            const newName = profileData.name || currentState.profile.name || label;
            if (profileData.name && profileData.name !== label) sessionStorage.setItem("currentUserLabel", profileData.name);

            const newUserState: UserState = {
                ...currentState,
                profile: { ...currentState.profile, name: newName, ...profileData },
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState 
            };
            
            setUserProfilesMap(prev => new Map(prev).set(myPeerId, newUserState.profile));
            
            setUserState(newUserState);

            const stateCid = await uploadStateToIpfs(newUserState, myIpnsKey);
            
            setLatestHeadCID(stateCid);

            // --- FIX: ADD PUBLISH ---
            publishStateToIpns(stateCid, myIpnsKey).catch(console.error);
            
            toast.success("Profile updated!");
            return { newState: newUserState, cid: stateCid };
        });
    }, [myIpnsKey, myPeerId, latestStateCID, setUserProfilesMap, queueAction, mergePendingUpdates, setUserState]);


    return {
        isProcessing,
        addPost,
        deletePost, 
        likePost,
        dislikePost,
        followUser,
        unfollowUser,
        blockUser,
        unblockUser,
        updateProfile,
        repairPins,
        queueFollowUpdates,
    };
};