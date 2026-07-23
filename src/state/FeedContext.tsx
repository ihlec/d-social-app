import React, { createContext, useContext, useState, useMemo } from 'react';
import { Post, UserProfile, OnlinePeer, UserState, NewPostData } from '../types';
import { useCooldown } from '../hooks/useCooldown';
import { useParentPostFetcher } from '../hooks/useSharedPostFetcher';
import { useAppFeed } from '../features/feed/useFeed';
import { useAppExplore } from '../features/feed/useExploreFeed';
import { useAppPeers } from '../features/feed/useOnlinePeers';
import { useContentServe } from '../features/feed/useContentServe';
import { useFollowP2PSync } from '../features/feed/useFollowP2PSync';
import { useAppActions } from '../state/useActions';
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess, markRequestPending } from '../lib/fetchBackoff';
import { resolveIpns, fetchUserState } from '../api/ipfsIpns';
import { POST_COOLDOWN_MS } from '../constants';
import { pinCid } from '../api/admin';
import * as contentCache from '../lib/contentCache';

export interface FeedContextState {
    allPostsMap: Map<string, Post>;
    allUserStatesMap: Map<string, UserState>;
    userProfilesMap: Map<string, UserProfile>;
    unresolvedFollows: string[];
    otherUsers: OnlinePeer[];
    
    isLoadingFeed: boolean;
    isProcessing: boolean;
    isCoolingDown: boolean;
    countdown: number;

    addPost: (postData: NewPostData) => Promise<void>;
    deletePost: (postId: string) => Promise<void>;
    likePost: (postId: string) => Promise<void>;
    dislikePost: (postId: string) => Promise<void>;
    savePost: (postId: string) => Promise<void>;
    clearMediaCache: () => Promise<void>;
    followUser: (ipnsKey: string, opts?: { name?: string; stateCid?: string }) => Promise<void>;
    unfollowUser: (ipnsKey: string) => Promise<void>;
    blockUser: (ipnsKey: string) => Promise<void>;
    unblockUser: (ipnsKey: string) => Promise<void>;
    updateProfile: (data: Partial<UserProfile>) => Promise<void>;

    refreshFeed: (force?: boolean) => Promise<void>;
    
    isLoadingExplore: boolean;
    loadMoreExplore: () => Promise<void>;
    refreshExploreFeed: () => Promise<void>;
    canLoadMoreExplore: boolean;

    loadMoreMyFeed: () => Promise<void>;
    canLoadMoreMyFeed: boolean;

    ensurePostsAreFetched: (postCids: string[], authorHint?: string, force?: boolean) => Promise<void>;
    fetchUser: (ipnsKey: string) => Promise<void>;

    exploreFeedPosts: Post[];
    unifiedIds: string[];
    loadMoreFeed: () => Promise<void>;
    getReplyCount: (postId: string) => number;

    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setAllUserStatesMap: React.Dispatch<React.SetStateAction<Map<string, UserState>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
}

export const FeedContext = createContext<FeedContextState | null>(null);

interface FeedProviderProps {
    children: React.ReactNode;
    /** Injected to avoid a circular Auth ↔ Feed import. */
    authState: {
        isLoggedIn: boolean | null;
        userState: UserState | null;
        myIpnsKey: string;
        myPeerId: string;
        latestStateCID: string;
        setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
        setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
    };
}

export const FeedProvider: React.FC<FeedProviderProps> = ({ children, authState }) => {
    const { 
        isLoggedIn, userState, myIpnsKey, myPeerId, latestStateCID, setLatestStateCID, setUserState 
    } = authState;

    const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
    const [allUserStatesMap, setAllUserStatesMap] = useState<Map<string, UserState>>(new Map());
    const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
    const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
    const [followCursors, setFollowCursors] = useState<Map<string, string | null>>(new Map());
    const [isFeedLoaded, setIsFeedLoaded] = useState(false);

    // Refs
    const allPostsMapRef = React.useRef(allPostsMap);
    React.useEffect(() => { allPostsMapRef.current = allPostsMap; }, [allPostsMap]);

    // Actions
    const { 
        isProcessing, lastPostAt, addPost, deletePost, likePost, dislikePost, savePost, followUser, unfollowUser: rawUnfollowUser, updateProfile, 
        blockUser, unblockUser, clearMediaCache,
        queueFollowUpdates 
    } = useAppActions({
        userState, setUserState, myIpnsKey, myPeerId, latestStateCID,
        setAllPostsMap, setLatestStateCID, setUserProfilesMap, allPostsMap
    });

    const unfollowUser = React.useCallback(async (ipnsKey: string) => {
        await rawUnfollowUser(ipnsKey);
        contentCache.markAuthorEvictable(ipnsKey).catch(() => {});
    }, [rawUnfollowUser]);

    // Hydrate posts/states from IndexedDB before network crawl
    const hasHydrated = React.useRef(false);
    React.useEffect(() => {
        if (hasHydrated.current) return;
        hasHydrated.current = true;
        (async () => {
            try {
                const [posts, states] = await Promise.all([
                    contentCache.hydrateRecentPosts(),
                    contentCache.hydrateRecentUserStates(),
                ]);
                if (posts.length > 0) {
                    setAllPostsMap(prev => {
                        if (prev.size > 0) return prev;
                        return new Map(
                            posts
                                .filter(p => p?.id && p.timestamp !== 0)
                                .map(p => [p.id, p])
                        );
                    });
                }
                if (states.size > 0) {
                    setAllUserStatesMap(prev => {
                        if (prev.size > 0) return prev;
                        return states;
                    });
                    setUserProfilesMap(prev => {
                        const next = new Map(prev);
                        states.forEach((st, key) => {
                            if (st.profile && !next.has(key)) next.set(key, st.profile);
                        });
                        return next;
                    });
                }
                console.debug(`[Feed] Hydrated ${posts.length} posts, ${states.size} user states from IndexedDB`);
            } catch (e) {
                console.warn('[Feed] IndexedDB hydrate failed', e);
            }
        })();
    }, []);

    // Shared Fetcher
    const { fetchMissingParentPost } = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap
    });

    // Peers
    const { otherUsers } = useAppPeers({ isLoggedIn, myPeerId, userState });
    useContentServe({ isLoggedIn, userState });

    // Main Feed
    const { 
        isLoadingFeed, processMainFeed, ensurePostsAreFetched: originalEnsurePosts, 
        loadMoreMyFeed, canLoadMoreMyFeed 
    } = useAppFeed({
        allPostsMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, 
        fetchMissingParentPost, followCursors, setFollowCursors,
        updateFollowMetadata: async (updates) => queueFollowUpdates(updates),
        myIpnsKey,
        myLatestStateCID: latestStateCID,
        allUserStatesMap,
        otherUsers,
    });

    // Online follows: sync tip over Trystero (clears "Resolving Follows" without IPNS)
    useFollowP2PSync({
        otherUsers,
        userState,
        myPeerId,
        setAllPostsMap,
        setAllUserStatesMap,
        setUserProfilesMap,
        setUnresolvedFollows,
        setFollowCursors,
        updateFollowMetadata: async (updates) => queueFollowUpdates(updates),
        ensurePostsAreFetched: originalEnsurePosts,
        enabled: isLoggedIn === true && !!myPeerId,
    });

    // Explore Feed
    const {
        isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore
    } = useAppExplore({
        myPeerId, userState,
        allPostsMap,
        setAllPostsMap,
        setUserProfilesMap,
        fetchMissingParentPost,
        otherUsers,
        enabled: isFeedLoaded
    });

    React.useEffect(() => {
        if (userState?.profile && myPeerId) {
            setUserProfilesMap(prev => {
                const existing = prev.get(myPeerId);
                if (existing && existing.name === userState.profile.name && existing.bio === userState.profile.bio) {
                    return prev;
                }
                return new Map(prev).set(myPeerId, userState.profile);
            });
        }
    }, [userState, myPeerId]);

    // Debounce feed recalculation — maps update often during hydrate/sync.
    const [debouncedPostsMap, setDebouncedPostsMap] = React.useState(allPostsMap);
    const debounceTimerRef = React.useRef<NodeJS.Timeout | null>(null);

    React.useEffect(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            setDebouncedPostsMap(new Map(allPostsMap));
        }, 250);

        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [allPostsMap]);

    // Backoff Logic / Ensure Posts
    const ensurePostsAreFetched = React.useCallback(async (postCids: string[], authorHint?: string, force: boolean = false) => {
        const allowedCids = postCids.filter(cid => {
            if (allPostsMapRef.current.has(cid)) return false; 
            if (force) return true;
            return !shouldSkipRequest(cid); 
        });

        if (allowedCids.length === 0) return;
        allowedCids.forEach(cid => markRequestPending(cid));

        const fetchedCids = await originalEnsurePosts(allowedCids, authorHint);
        const fetchedSet = new Set(fetchedCids || []);

        allowedCids.forEach(cid => {
            if (fetchedSet.has(cid) || allPostsMapRef.current.has(cid)) {
                reportFetchSuccess(cid);
            } else {
                reportFetchFailure(cid);
            }
        });
    }, [originalEnsurePosts]);

    const fetchUser = React.useCallback(async (ipnsKey: string, force?: boolean) => {
        if (!ipnsKey) return;
        
        // Check map first - use cached state unless forced refresh
        if (!force && allUserStatesMap.has(ipnsKey)) {
            const cachedState = allUserStatesMap.get(ipnsKey)!;
            // Update profile map from cached state
            if (cachedState.profile) {
                setUserProfilesMap(prev => {
                    const next = new Map(prev);
                    if (!next.has(ipnsKey) || next.get(ipnsKey)?.name !== cachedState.profile.name) {
                        next.set(ipnsKey, cachedState.profile);
                    }
                    return next;
                });
            }
            // Fetch posts from cached state
            if (cachedState.postCIDs && cachedState.postCIDs.length > 0) {
                const recentCids = cachedState.postCIDs.slice(0, 10);
                await ensurePostsAreFetched(recentCids, ipnsKey);
            }
            return;
        }
        
        if (shouldSkipRequest(ipnsKey)) return;
        
        try {
            // Prefer Trystero tip sync — public IPNS/gateways rarely have browser Helia publishes
            try {
                const { requestPeerFeed } = await import('../api/pubsub');
                const p2p = await requestPeerFeed(ipnsKey);
                if (p2p?.ok && p2p.state) {
                    setAllUserStatesMap(prev => {
                        const next = new Map(prev);
                        next.set(ipnsKey, p2p.state!);
                        return next;
                    });
                    if (p2p.state.profile) {
                        setUserProfilesMap(prev => new Map(prev).set(ipnsKey, p2p.state!.profile!));
                    }
                    if (p2p.posts?.length) {
                        setAllPostsMap(prev => {
                            const next = new Map(prev);
                            for (const p of p2p.posts) {
                                if (p?.id && !(p.timestamp === 0 && String(p.content || '').includes('Content Unavailable'))) {
                                    next.set(p.id, { ...p, authorKey: p.authorKey || ipnsKey });
                                }
                            }
                            return next;
                        });
                    }
                    const recentCids = (p2p.state.postCIDs || []).slice(0, 10);
                    if (recentCids.length > 0) {
                        await ensurePostsAreFetched(recentCids, ipnsKey);
                    }
                    reportFetchSuccess(ipnsKey);
                    return;
                }
            } catch { /* fall through to IPNS / optional gateway */ }

            const cid = await resolveIpns(ipnsKey);
            if (cid) {
                const fetchedState = await fetchUserState(cid, ipnsKey);
                
                // Store full UserState in map
                setAllUserStatesMap(prev => {
                    const next = new Map(prev);
                    next.set(ipnsKey, fetchedState);
                    return next;
                });
                
                // Update profile map
                if (fetchedState && fetchedState.profile) {
                    setUserProfilesMap(prev => {
                        const next = new Map(prev);
                        next.set(ipnsKey, fetchedState.profile!);
                        return next;
                    });
                }
                
                // Fetch posts
                if (fetchedState && fetchedState.postCIDs && fetchedState.postCIDs.length > 0) {
                    const recentCids = fetchedState.postCIDs.slice(0, 10);
                    await ensurePostsAreFetched(recentCids, ipnsKey); 
                }
                reportFetchSuccess(ipnsKey);
                return;
            }
            reportFetchFailure(ipnsKey);
        } catch (e) {
            console.warn(`[App] fetchUser failed for ${ipnsKey}`, e);
            reportFetchFailure(ipnsKey);
        }
    }, [allUserStatesMap, ensurePostsAreFetched, setAllPostsMap, setAllUserStatesMap, setUserProfilesMap]);

    // Post-only rate limit (not likes/follows/profile — those also bump updatedAt)
    const { isCoolingDown, countdown } = useCooldown(
        lastPostAt || undefined,
        POST_COOLDOWN_MS
    );

    // Refresh Logic
    const refreshFeed = React.useCallback(async (_force: boolean = false) => {
        if (isLoggedIn && myPeerId && userState) {
            await processMainFeed(userState);
        }
    }, [isLoggedIn, myPeerId, userState, processMainFeed]);

    // Populate allUserStatesMap from follow lastSeenCids (batched).
    const allUserStatesMapRef = React.useRef(allUserStatesMap);
    React.useEffect(() => { allUserStatesMapRef.current = allUserStatesMap; }, [allUserStatesMap]);

    React.useEffect(() => {
        if (!userState || !userState.follows) return;

        const populateUserStatesFromFollows = async () => {
            const followsWithCids = userState.follows.filter(f => f.ipnsKey && f.lastSeenCid && !shouldSkipRequest(f.lastSeenCid));

            const BATCH_SIZE = 3;
            const BATCH_DELAY_MS = 500;

            for (let i = 0; i < followsWithCids.length; i += BATCH_SIZE) {
                const batch = followsWithCids.slice(i, i + BATCH_SIZE);
                
                const promises = batch.map(async (follow) => {
                    // Skip if already in map (feed sync or hydrate may have filled it)
                    if (allUserStatesMapRef.current.has(follow.ipnsKey)) return;
                    
                    // Prefer IndexedDB before network (avoids duplicate crawl with processMainFeed)
                    const idb = await contentCache.getUserState(follow.ipnsKey);
                    if (idb?.state) {
                        setAllUserStatesMap(prev => {
                            if (prev.has(follow.ipnsKey)) return prev;
                            return new Map(prev).set(follow.ipnsKey, idb.state);
                        });
                        if (idb.state.profile) {
                            setUserProfilesMap(prev => {
                                if (prev.has(follow.ipnsKey)) return prev;
                                return new Map(prev).set(follow.ipnsKey, idb.state.profile);
                            });
                        }
                        return;
                    }

                    if (shouldSkipRequest(follow.lastSeenCid!)) return;
                    
                    markRequestPending(follow.lastSeenCid!);
                    
                    try {
                        const fetchedState = await fetchUserState(follow.lastSeenCid!, follow.ipnsKey);
                        
                        pinCid(follow.lastSeenCid!).catch(() => {});
                        contentCache.putUserState(follow.ipnsKey, fetchedState, follow.lastSeenCid!).catch(() => {});
                        
                        setAllUserStatesMap(prev => {
                            const next = new Map(prev);
                            next.set(follow.ipnsKey, fetchedState);
                            return next;
                        });
                        
                        if (fetchedState.profile) {
                            setUserProfilesMap(prev => {
                                const next = new Map(prev);
                                if (!next.has(follow.ipnsKey) || next.get(follow.ipnsKey)?.name !== fetchedState.profile.name) {
                                    next.set(follow.ipnsKey, fetchedState.profile);
                                }
                                return next;
                            });
                        }
                        
                        reportFetchSuccess(follow.lastSeenCid!);
                    } catch (e: any) {
                        reportFetchFailure(follow.lastSeenCid!);
                        if (e?.message?.includes('504') || e?.message?.includes('Gateway Timeout') || e?.message?.includes('timeout')) {
                            console.warn(`[Feed] Gateway timeout for ${follow.ipnsKey} (${follow.lastSeenCid}), will retry later via backoff`);
                        } else {
                            console.warn(`[Feed] Failed to populate user state for ${follow.ipnsKey} from lastSeenCid`, e);
                        }
                    }
                });
                
                await Promise.allSettled(promises);
                
                // Delay between batches to avoid overwhelming gateway
                if (i + BATCH_SIZE < followsWithCids.length) {
                    await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
                }
            }
        };
        
        populateUserStatesFromFollows();
    }, [userState?.follows]);

    // Initial Fetch
    const hasInitialFetch = React.useRef(false);
    React.useEffect(() => {
        if (!isLoggedIn) {
            hasInitialFetch.current = false;
            setIsFeedLoaded(false); 
        }
    }, [isLoggedIn]);

    React.useEffect(() => {
        if (isLoggedIn && userState && !hasInitialFetch.current) {
            hasInitialFetch.current = true;
            refreshFeed().then(() => setIsFeedLoaded(true));
        }
    }, [isLoggedIn, userState, refreshFeed]);

    const [replyGraph, setReplyGraph] = useState<Map<string, string[]>>(new Map());
    const previousMapSize = React.useRef(0);

    React.useEffect(() => {
        // Size is a cheap proxy for structural changes (we mostly append).
        if (allPostsMap.size === previousMapSize.current && allPostsMap.size > 0) {
            return;
        }

        const newGraph = new Map<string, string[]>();
        debouncedPostsMap.forEach(post => {
            if (post.referenceCID) {
                const parent = post.referenceCID;
                const existing = newGraph.get(parent) || [];
                existing.push(post.id);
                newGraph.set(parent, existing);
            }
        });
        
        setReplyGraph(newGraph);
        previousMapSize.current = debouncedPostsMap.size;
    }, [debouncedPostsMap]);

    const getReplyCount = React.useCallback((postId: string): number => {
        let count = 0;
        const stack = [postId];
        let safeGuard = 0; 
        while (stack.length > 0 && safeGuard < 1000) {
            const current = stack.pop()!;
            const children = replyGraph.get(current);
            if (children) {
                count += children.length;
                stack.push(...children);
            }
            safeGuard++;
        }
        return count;
    }, [replyGraph]);

    // Feed Generation (debounced map). Home builds its own my-feed order from allPostsMap;
    // we only export explore roots + unified nav ids.
    const { exploreFeedPosts, unifiedIds } = useMemo(() => {
        if (!userState) return { exploreFeedPosts: [], unifiedIds: [] };
        
        const allPosts = Array.from(debouncedPostsMap.values());
        const followsSet = new Set(userState.follows.map(f => f.ipnsKey));
        const blockedSet = new Set(userState.blockedUsers || []);
        
        // Helper: Find Root
        const findRoot = (startId: string): string => {
            let curr = debouncedPostsMap.get(startId);
            const visited = new Set<string>();
            while (curr && curr.referenceCID && !visited.has(curr.id)) {
                visited.add(curr.id);
                const parent = debouncedPostsMap.get(curr.referenceCID);
                if (!parent) break; 
                curr = parent;
            }
            return curr ? curr.id : startId;
        };

        // Identify threads I participated in
        const myParticipatedRootIds = new Set<string>();
        allPosts.forEach(p => {
             if (p.authorKey === myPeerId) {
                 myParticipatedRootIds.add(findRoot(p.id));
             }
        });

        const myFeed = allPosts.filter(p => {
            if (p.authorKey === myPeerId) return true;
            if (blockedSet.has(p.authorKey)) return false;
            if (followsSet.has(p.authorKey)) return true;
            if (myParticipatedRootIds.has(p.id)) return true;
            return false;
        });

        // Explore: roots that include activity from users outside follows/self/blocks.
        const isStranger = (key: string) => key !== myPeerId && !followsSet.has(key) && !blockedSet.has(key);
        const exploreRelevantIds = new Set<string>();
        allPosts.forEach(post => {
             if (isStranger(post.authorKey)) {
                 exploreRelevantIds.add(findRoot(post.id));
             }
        });

        const exploreFeed = Array.from(exploreRelevantIds)
            .map(id => debouncedPostsMap.get(id))
            .filter((p): p is Post => !!p)
            .filter(p => !blockedSet.has(p.authorKey));

        myFeed.sort((a, b) => b.timestamp - a.timestamp);
        exploreFeed.sort((a, b) => b.timestamp - a.timestamp);

        const dislikedIds = new Set(userState.dislikedPostCIDs || []);
        const isTopLevel = (p: Post) => !p.referenceCID && !dislikedIds.has(p.id);

        const myTopLevel = myFeed.filter(isTopLevel);
        const exploreTopLevel = exploreFeed.filter(isTopLevel);

        const myIds = myTopLevel.map(p => p.id);
        const myIdsSet = new Set(myIds);

        const exploreIds = exploreTopLevel
            .filter(p => !myIdsSet.has(p.id))
            .map(p => p.id);
            
        const unified = [...myIds, ...exploreIds];

        return {
            exploreFeedPosts: exploreFeed,
            unifiedIds: unified
        };
    }, [debouncedPostsMap, userState, myPeerId, replyGraph]);

    const loadMoreFeed = React.useCallback(async () => {
        if (canLoadMoreMyFeed) await loadMoreMyFeed();
        if (canLoadMoreExplore) await loadMoreExplore();
    }, [canLoadMoreMyFeed, canLoadMoreExplore, loadMoreMyFeed, loadMoreExplore]);

    const value: FeedContextState = {
        allPostsMap, allUserStatesMap, userProfilesMap, unresolvedFollows, otherUsers,
        isLoadingFeed, isProcessing, isCoolingDown, countdown,
        addPost, deletePost, likePost, dislikePost, savePost, clearMediaCache, followUser, unfollowUser, updateProfile,
        blockUser, unblockUser,
        refreshFeed, isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore,
        loadMoreMyFeed, canLoadMoreMyFeed, ensurePostsAreFetched, fetchUser,
        exploreFeedPosts,
        unifiedIds, loadMoreFeed,
        getReplyCount,
        // Expose setters
        setAllPostsMap,
        setAllUserStatesMap,
        setUserProfilesMap
    };

    return (
        <FeedContext.Provider value={value}>
            {children}
        </FeedContext.Provider>
    );
};

export const useFeedContext = () => {
    const context = useContext(FeedContext);
    if (!context) throw new Error("useFeedContext must be used within FeedProvider");
    return context;
};
