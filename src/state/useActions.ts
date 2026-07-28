import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { NewPostData, Post, UserState, Follow, UserProfile } from '../types';
import {
    uploadPost,
    uploadStateToIpfs,
    publishStateToIpns,
} from './stateActions';
import { 
    resolveIpns, 
    mirrorUser, 
    pinCid, 
    getSession, 
    startHelia,
    heliaListPins,
    listIdentityKeys,
    fetchUserStateChunk,
} from '../api/ipfsIpns'; 
import { MAX_POSTS_PER_STATE, MAX_UPLOAD_BYTES } from '../constants';
import { reportFetchSuccess } from '../lib/fetchBackoff';
import { pinForLike, pinForSave, dropLocalCid } from '../lib/pinPolicy';
import { buildMediaKeepSet, clearUnneededMedia, reclaimStorageForUpload } from '../lib/mediaGc';
import { hasStorageHeadroom, formatBytes, describeStorageGap } from '../lib/storageQuota';
import { resolveHeliaMediaUrl } from '../lib/heliaMediaUrl';

function formatGcResult(r: { blocksDeleted: number; rootsUnpinned: number; wipedBlockstore?: boolean }): string {
    if (r.wipedBlockstore) return 'Reset local media store (identity kept).';
    if (r.blocksDeleted <= 0 && r.rootsUnpinned <= 0) return '';
    return `Removed ${r.blocksDeleted} block(s)`
        + (r.rootsUnpinned > 0 ? `, unpinned ${r.rootsUnpinned} root(s)` : '')
        + '.';
}

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
    /** Timestamp of last successful post — used for post-only rate limit (not likes/follows). */
    const [lastPostAt, setLastPostAt] = useState<number>(() => {
        try {
            const v = sessionStorage.getItem('dsocial_last_post_at');
            return v ? Number(v) : 0;
        } catch {
            return 0;
        }
    });
    const actionQueue = useRef<Promise<any>>(Promise.resolve());
    const persistenceQueue = useRef<Promise<any>>(Promise.resolve());
    const hasRepairedRef = useRef(false);

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

    const mergePendingUpdates = useCallback((state: UserState): UserState => {
        if (pendingFollowUpdatesRef.current.size === 0) return state;

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
            console.debug(`[Actions] Queued ${count} follow updates for next interaction.`);
        }
    }, []);

    const repairPins = useCallback(async () => {
        const currentUserState = userStateRef.current;
        const currentPostsMap = allPostsMapRef.current;

        if (!currentUserState) return;

        const session = getSession();
        if (session.sessionType !== 'helia') return;

        try {
            await startHelia();
        } catch {
            return;
        }

        const keepSet = buildMediaKeepSet(currentUserState, currentPostsMap, myPeerId);

        // Also keep other local identities' own posts (multi-account same browser)
        try {
            const localKeys = await listIdentityKeys();
            for (const keyName of localKeys) {
                if (keyName === session.ipnsKeyName) continue;
                try {
                    const { ensureIdentityKey } = await import('../api/heliaNode');
                    const { ipnsName } = await ensureIdentityKey(keyName);
                    if (ipnsName === myPeerId) continue;
                    const stateCid = await resolveIpns(ipnsName);
                    if (!stateCid) continue;
                    const peerState = await fetchUserStateChunk(stateCid, ipnsName);
                    if (peerState) {
                        const merged = buildMediaKeepSet(
                            {
                                ...currentUserState,
                                postCIDs: peerState.postCIDs || [],
                                likedPostCIDs: peerState.likedPostCIDs || [],
                                savedPostCIDs: peerState.savedPostCIDs || [],
                            } as UserState,
                            currentPostsMap,
                            ipnsName
                        );
                        for (const cid of merged) keepSet.add(cid);
                    }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        let localPinSet: Set<string>;
        try {
            localPinSet = await heliaListPins();
        } catch {
            return;
        }

        // Ensure keep-set roots that are already local stay pinned
        for (const cid of keepSet) {
            if (localPinSet.has(cid)) continue;
            try {
                await pinCid(cid);
            } catch { /* missing locally — P2P/like path will fetch */ }
            await sleep(10);
        }

        // Do NOT sweep/wipe here — background getAll() races uploads and blocks
        // IndexedDB deletes on Firefox. Storage reclaim is upload/Settings only.
    }, [myPeerId, latestStateCID]);

    const clearMediaCache = useCallback(async () => {
        const currentUserState = userStateRef.current;
        if (!currentUserState) {
            toast.error('Log in to manage storage.');
            return;
        }
        try {
            const cleaned = await clearUnneededMedia(
                currentUserState,
                allPostsMapRef.current,
                myPeerId,
                {
                    mode: 'aggressive',
                    extraRoots: latestStateCID ? [latestStateCID] : [],
                    wipeIfStillFull: true,
                    // Aim for a typical media upload headroom after clear
                    bytesNeeded: 16 * 1024 * 1024,
                }
            );
            const msg = formatGcResult(cleaned);
            toast.success(
                msg
                    ? `Cleared local storage: ${msg}`
                    : 'Nothing to clear — only your posts and saved media remain pinned.'
            );
        } catch (e) {
            console.error(e);
            toast.error('Failed to clear media cache.');
        }
    }, [myPeerId, latestStateCID]); 

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
            const file = postData.file;
            if (file && file.size > 0) {
                if (file.size > MAX_UPLOAD_BYTES) {
                    throw new Error(
                        `File too large (${formatBytes(file.size)}). `
                        + `Max upload is ${formatBytes(MAX_UPLOAD_BYTES)} so peers can fetch it over P2P.`
                    );
                }
                let ok = await hasStorageHeadroom(file.size);
                if (!ok) {
                    // Fast wipe only — full blockstore getAll() sweeps hang Firefox for minutes
                    toast.loading('Resetting local media store…', { id: 'upload-gc' });
                    try {
                        const reclaimed = await reclaimStorageForUpload(file.size);
                        ok = await hasStorageHeadroom(file.size);
                        if (!ok && reclaimed.wipedBlockstore) ok = true;
                    } finally {
                        toast.dismiss('upload-gc');
                    }
                }
                if (!ok) {
                    const gap = await describeStorageGap(file.size);
                    throw new Error(
                        `Not enough browser storage for this upload (${formatBytes(file.size)}${gap}). `
                        + 'Close other localhost tabs, then Settings → Clear unused media (or clear site data).'
                    );
                }
            }

            toast.loading(
                file ? `Uploading ${formatBytes(file.size)}…` : 'Publishing…',
                { id: 'upload-progress' }
            );
            const { finalPost, finalPostCID } = await uploadPost(postData, myPeerId);
            toast.dismiss('upload-progress');

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

                // Warm blob: URLs from local CAS so PostPage doesn't wait on public gateways
                if (newPostObject.thumbnailCid) {
                    void resolveHeliaMediaUrl(newPostObject.thumbnailCid, 'image/jpeg');
                }
                if (newPostObject.mediaCid) {
                    void resolveHeliaMediaUrl(newPostObject.mediaCid, undefined, { allowLarge: true });
                }
                
                const stateCid = await uploadStateToIpfs(newState, myIpnsKey);

                // Await local tip publish
                toast.loading('Publishing…', { id: 'upload-progress' });
                await publishStateToIpns(stateCid, myIpnsKey);

                setLatestHeadCID(stateCid);
                setUserState(newState);
                return { newState, cid: stateCid };
            });

            const postedAt = Date.now();
            setLastPostAt(postedAt);
            try {
                sessionStorage.setItem('dsocial_last_post_at', String(postedAt));
            } catch { /* ignore */ }

            toast.success("Post published!");
        } catch (error) {
            console.error(error);
            toast.dismiss('upload-gc');
            toast.dismiss('upload-progress');
            const msg = error instanceof Error ? error.message : '';
            toast.error(
                msg.includes('storage is full')
                || msg.includes('quota')
                || msg.includes('Not enough browser storage')
                || msg.includes('File too large')
                || msg.includes('Could not delete')
                || msg.includes('Close other tabs')
                || msg.includes('Failed to free local storage')
                || msg.includes('Failed to free Helia')
                    ? msg
                    : 'Failed to create post.'
            );
        } finally {
            toast.dismiss('upload-gc');
            toast.dismiss('upload-progress');
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
            const stillSaved = (currentState.savedPostCIDs || []).includes(postId);
            const isAuthor = loadedPost.authorKey === myPeerId;

            if (isLiked) {
                newLikes = currentLikes.filter(id => id !== postId);
                // Drop serve hold unless still saved or authored
                if (!stillSaved && !isAuthor) {
                    if (loadedPost.mediaCid) void dropLocalCid(loadedPost.mediaCid);
                    if (loadedPost.thumbnailCid) void dropLocalCid(loadedPost.thumbnailCid);
                    void dropLocalCid(postId);
                }
            } else {
                // Serve commitment: pin post + thumb + full media before recording like
                const result = await pinForLike(loadedPost);
                if (!result.ok) {
                    toast.error(result.reason || 'Could not pin post to serve');
                    return { newState: currentState };
                }
                newLikes = [...currentLikes, postId];
                reportFetchSuccess(postId);
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
    }, [myPeerId, setUserState, queueAction, mergePendingUpdates, queuePersistence]);

    const savePost = useCallback(async (postId: string) => {
        const loadedPost = allPostsMapRef.current.get(postId);
        if (!loadedPost || loadedPost.timestamp === 0) {
            toast.error('Please wait for post data to load.');
            return;
        }

        queueAction('savePost', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);
            const currentSaved = currentState.savedPostCIDs || [];
            const isSaved = currentSaved.includes(postId);
            let newSaved: string[];

            if (isSaved) {
                newSaved = currentSaved.filter((id) => id !== postId);
                const stillLiked = (currentState.likedPostCIDs || []).includes(postId);
                const isAuthor = loadedPost.authorKey === myPeerId;
                // Like is also a full serve hold — only drop when neither like nor author
                if (!stillLiked && !isAuthor) {
                    if (loadedPost.mediaCid) void dropLocalCid(loadedPost.mediaCid);
                    if (loadedPost.thumbnailCid) void dropLocalCid(loadedPost.thumbnailCid);
                    void dropLocalCid(postId);
                }
                toast.success('Removed saved media pin');
            } else {
                newSaved = [...currentSaved, postId];
                const result = await pinForSave(loadedPost);
                if (result.ok) {
                    toast.success('Media saved locally');
                } else {
                    toast.error(result.reason || 'Could not save media');
                    return { newState: currentState };
                }
            }

            const newState: UserState = {
                ...currentState,
                savedPostCIDs: newSaved,
                updatedAt: Date.now(),
                extendedUserState: currentState.extendedUserState,
            };
            setUserState(newState);
            queuePersistence(newState);
            return { newState };
        });
    }, [myPeerId, setUserState, queueAction, mergePendingUpdates, queuePersistence]);


    const dislikePost = useCallback(async (postId: string) => {
        const loadedPost = allPostsMapRef.current.get(postId);

        queueAction('dislikePost', async (rawState) => {
            const currentState = mergePendingUpdates(rawState);
            const inOwnHistory = (currentState.postCIDs || []).includes(postId);
            const isAuthor =
                loadedPost?.authorKey === myPeerId
                || (inOwnHistory && (!loadedPost || loadedPost.authorKey === myPeerId));

            // Dislike on your own post = delete from history + local store (not a dislike entry).
            if (isAuthor) {
                const newState: UserState = {
                    ...currentState,
                    postCIDs: (currentState.postCIDs || []).filter((id) => id !== postId),
                    likedPostCIDs: (currentState.likedPostCIDs || []).filter((id) => id !== postId),
                    savedPostCIDs: (currentState.savedPostCIDs || []).filter((id) => id !== postId),
                    dislikedPostCIDs: (currentState.dislikedPostCIDs || []).filter((id) => id !== postId),
                    updatedAt: Date.now(),
                    extendedUserState: currentState.extendedUserState,
                };

                if (loadedPost?.mediaCid) void dropLocalCid(loadedPost.mediaCid);
                if (loadedPost?.thumbnailCid) void dropLocalCid(loadedPost.thumbnailCid);
                void dropLocalCid(postId);

                setAllPostsMap((prev) => {
                    if (!prev.has(postId)) return prev;
                    const next = new Map(prev);
                    next.delete(postId);
                    return next;
                });
                setUserState(newState);
                queuePersistence(newState);
                toast.success('Post removed');
                return { newState };
            }

            const currentDislikes = currentState.dislikedPostCIDs || [];
            let newDislikes: string[];

            if (currentDislikes.includes(postId)) {
                newDislikes = currentDislikes.filter(id => id !== postId);
            } else {
                newDislikes = [...currentDislikes, postId];
            }

            const wasLiked = (currentState.likedPostCIDs || []).includes(postId);
            const newLikes = (currentState.likedPostCIDs || []).filter(id => id !== postId);

            // Dislike clears like → drop serve hold unless saved
            if (wasLiked && loadedPost) {
                const stillSaved = (currentState.savedPostCIDs || []).includes(postId);
                if (!stillSaved) {
                    if (loadedPost.mediaCid) void dropLocalCid(loadedPost.mediaCid);
                    if (loadedPost.thumbnailCid) void dropLocalCid(loadedPost.thumbnailCid);
                    void dropLocalCid(postId);
                }
            }

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
    }, [myPeerId, setUserState, setAllPostsMap, queueAction, mergePendingUpdates, queuePersistence]);


    const followUser = useCallback(async (
        ipnsKey: string,
        opts?: { name?: string; stateCid?: string }
    ) => {
        const key = (ipnsKey || '').trim();
        if (!key) {
            toast.error('Missing peer key');
            return;
        }

        setIsProcessing(true);
        try {
            await queueAction('followUser', async (rawState) => {
                const currentState = mergePendingUpdates(rawState);

                if (currentState.follows.some(f => f.ipnsKey === key)) {
                    toast('Already following');
                    return { newState: currentState };
                }

                // Prefer Trystero-announced name/CID — never block the UI on public IPNS/gateways.
                let name = opts?.name?.trim() || `${key.slice(0, 8)}…`;
                let latestCid = opts?.stateCid || '';

                try {
                    const { requestPeerFeed } = await import('../api/pubsub');
                    const p2p = await Promise.race([
                        requestPeerFeed(key),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
                    ]);
                    if (p2p?.ok && p2p.state) {
                        if (p2p.state.profile?.name) name = p2p.state.profile.name;
                        if (p2p.stateCid) latestCid = p2p.stateCid;
                        if (p2p.state.profile) {
                            setUserProfilesMap(prev => new Map(prev).set(key, p2p.state!.profile));
                        }
                    }
                } catch {
                    /* optimistic follow below */
                }

                const newFollow: Follow = {
                    ipnsKey: key,
                    name,
                    lastSeenCid: latestCid || undefined,
                    updatedAt: Date.now(),
                };
                const newState: UserState = {
                    ...currentState,
                    follows: [...currentState.follows, newFollow],
                    updatedAt: Date.now(),
                    extendedUserState: currentState.extendedUserState,
                };

                setUserState(newState);
                userStateRef.current = newState;
                queuePersistence(newState);

                // Background enrichment only (must not gate the follow)
                void (async () => {
                    try {
                        if (!latestCid) {
                            const cid = await resolveIpns(key);
                            if (cid) {
                                latestCid = cid;
                                pendingFollowUpdatesRef.current.set(key, { cid, name });
                            }
                        }
                        if (latestCid) {
                            mirrorUser(key, latestCid).catch(() => {});
                            const state = await fetchUserStateChunk(latestCid, key).catch(() => null);
                            if (state?.profile?.name) {
                                pendingFollowUpdatesRef.current.set(key, {
                                    cid: latestCid,
                                    name: state.profile.name,
                                });
                                setUserProfilesMap(prev => new Map(prev).set(key, state.profile!));
                            }
                        }
                    } catch (e) {
                        console.debug('[Follow] Background enrich failed', e);
                    }
                })();

                toast.success(`Followed ${name}`);
                return { newState };
            });
        } catch (e) {
            console.error('[Follow] failed', e);
            toast.error('Follow failed');
        } finally {
            setIsProcessing(false);
        }
    }, [queueAction, setUserState, setUserProfilesMap, mergePendingUpdates, queuePersistence]);


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

            // Mark IndexedDB cache for this author as eviction-preferred
            import('../lib/contentCache').then(m => m.markAuthorEvictable(ipnsKey)).catch(() => {});
            
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

    // Identity key name must stay stable for session restore.
            const newName = profileData.name || currentState.profile.name || myIpnsKey || '';

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

            publishStateToIpns(stateCid, myIpnsKey).catch(console.error);
            
            toast.success("Profile updated!");
            return { newState: newUserState, cid: stateCid };
        });
    }, [myIpnsKey, myPeerId, latestStateCID, setUserProfilesMap, queueAction, mergePendingUpdates, setUserState]);


    return {
        isProcessing,
        lastPostAt,
        addPost,
        deletePost, 
        likePost,
        dislikePost,
        savePost,
        followUser,
        unfollowUser,
        blockUser,
        unblockUser,
        updateProfile,
        repairPins,
        clearMediaCache,
        queueFollowUpdates,
    };
};