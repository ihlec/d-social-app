// fileName: src/state/useAppStorage.ts
import { useState, useContext, useCallback, useEffect, useRef, useMemo } from 'react';
import { AppStateContext } from '../state/AppContext';
import { UserState, Post, UserProfile, OnlinePeer, NewPostData } from '../types';
import { useCooldown } from '../hooks/useCooldown';
import { useParentPostFetcher } from '../hooks/useSharedPostFetcher';
import { useAppAuth } from '../features/auth/useAuth';
import { useAppFeed } from '../features/feed/useFeed';
import { useAppExplore } from '../features/feed/useExploreFeed';
import { useAppPeers } from '../features/feed/useOnlinePeers';
import { useAppActions } from './useActions';
import { resolveIpns, fetchUserState } from '../api/ipfsIpns';
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess, markRequestPending } from '../lib/fetchBackoff';
import { pinCid } from '../api/admin';
import { POST_COOLDOWN_MS } from '../constants';

export interface UseAppStateReturn {
    isLoggedIn: boolean | null;
    userState: UserState | null;
    myIpnsKey: string;
    myPeerId: string;
    latestStateCID: string;
    isLoadingFeed: boolean;
    isProcessing: boolean;
    isCoolingDown: boolean;
    countdown: number;
    loginWithKubo: (apiUrl: string, keyName: string, username?: string, password?: string) => Promise<void>;
    logout: () => void;
    addPost: (postData: NewPostData) => Promise<void>;
    deletePost: (postId: string) => Promise<void>;
    likePost: (postId: string) => Promise<void>;
    dislikePost: (postId: string) => Promise<void>;
    followUser: (ipnsKeyToFollow: string) => Promise<void>;
    unfollowUser: (ipnsKeyToUnfollow: string) => Promise<void>;
    blockUser: (ipnsKey: string) => Promise<void>;
    unblockUser: (ipnsKey: string) => Promise<void>;
    refreshFeed: (force?: boolean) => Promise<void>;
    isLoadingExplore: boolean;
    loadMoreExplore: () => Promise<void>;
    refreshExploreFeed: () => Promise<void>;
    canLoadMoreExplore: boolean;
    updateProfile: (profileData: Partial<UserProfile>) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string, force?: boolean) => Promise<void>;
    fetchUser: (ipnsKey: string) => Promise<void>;
    unresolvedFollows: string[];
    allPostsMap: Map<string, Post>;
    allUserStatesMap: Map<string, UserState>;
    userProfilesMap: Map<string, UserProfile>;
    otherUsers: OnlinePeer[];
    isInitializeDialogOpen: boolean;
    onInitializeUser: () => void;
    onRetryLogin: () => void;
    loadMoreMyFeed: () => Promise<void>;
    canLoadMoreMyFeed: boolean;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setAllUserStatesMap: React.Dispatch<React.SetStateAction<Map<string, UserState>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
    myFeedPosts: Post[];
    exploreFeedPosts: Post[];
    getReplyCount: (postId: string) => number;
    unifiedIds: string[];
    loadMoreFeed: () => Promise<void>;
    isSessionLocked: boolean;
    unlockSession: (password: string) => Promise<boolean>;
}

export const useAppStateInternal = (): UseAppStateReturn => {
    // 1. Auth Hook
    const { 
        isLoggedIn, myIpnsKey, myPeerId, userState, setUserState, 
        latestStateCID, setLatestStateCID,
        loginWithKubo, logout, isInitializeDialogOpen,
        onInitializeUser, onRetryLogin,
        isSessionLocked, unlockSession
    } = useAppAuth();

    // 2. Data State
    const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
    const [allUserStatesMap, setAllUserStatesMap] = useState<Map<string, UserState>>(new Map());
    const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
    const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
    const [followCursors, setFollowCursors] = useState<Map<string, string | null>>(new Map());

    // --- Loading Gates ---
    const [isFeedLoaded, setIsFeedLoaded] = useState(false); 

    // --- NEW: Stable Explore List ---
    const [stableExploreIds, setStableExploreIds] = useState<string[]>([]);
    const exploreDebounceRef = useRef<NodeJS.Timeout | null>(null);

    const allPostsMapRef = useRef(allPostsMap);
    useEffect(() => { allPostsMapRef.current = allPostsMap; }, [allPostsMap]);

    // 3. Actions Hook (Instantiated EARLY to pass 'queueFollowUpdates' down)
    const { 
        isProcessing, addPost, deletePost, likePost, dislikePost, followUser, unfollowUser, blockUser, unblockUser, updateProfile, 
        queueFollowUpdates // <--- NEW: Grab the queue function
    } = useAppActions({
        userState, setUserState, myIpnsKey, myPeerId, latestStateCID,
        setAllPostsMap, setLatestStateCID, setUserProfilesMap, allPostsMap
    });

    // 4. Shared Fetcher
    const { fetchMissingParentPost } = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap
    });

    // 5. Online Peers
    const { otherUsers } = useAppPeers({ isLoggedIn, myPeerId, userState });

    // 6. Main Feed Hook
    const { 
        isLoadingFeed, processMainFeed, ensurePostsAreFetched: originalEnsurePosts, 
        loadMoreMyFeed, canLoadMoreMyFeed 
    } = useAppFeed({
        allPostsMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, 
        fetchMissingParentPost, followCursors, setFollowCursors,
        // --- WIRE UP: Pass the queue function to the feed ---
        // The feed will push updates to this queue, and useActions will save them
        // the next time the user interacts (Post/Like/Follow).
        updateFollowMetadata: async (updates) => queueFollowUpdates(updates),
        myIpnsKey,
        myLatestStateCID: latestStateCID,
        allUserStatesMap
    });

    // 7. Explore Feed Hook (Gated)
    const { 
        isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore 
    } = useAppExplore({
        myIpnsKey, userState, 
        allPostsMap, 
        setAllPostsMap,
        setUserProfilesMap,
        fetchMissingParentPost,
        otherUsers,
        enabled: isFeedLoaded 
    });


    // --- INSTANT PROFILE SYNC ---
    useEffect(() => {
        if (userState?.profile && myIpnsKey) {
            setUserProfilesMap(prev => {
                const existing = prev.get(myIpnsKey);
                if (existing && existing.name === userState.profile.name && existing.bio === userState.profile.bio) {
                    return prev;
                }
                return new Map(prev).set(myIpnsKey, userState.profile);
            });
        }
    }, [userState, myIpnsKey]);

    // OPTIMIZATION: Debounce feed recalculation to reduce excessive recalculations
    const [debouncedPostsMap, setDebouncedPostsMap] = useState(allPostsMap);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    
    useEffect(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }
        
        // Debounce feed recalculation by 250ms
        debounceTimerRef.current = setTimeout(() => {
            setDebouncedPostsMap(new Map(allPostsMap));
        }, 250);
        
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [allPostsMap]);

    // --- STABILIZE EXPLORE FEED (DEBOUNCED) ---
    useEffect(() => {
        if (!userState) return;

        if (exploreDebounceRef.current) {
            clearTimeout(exploreDebounceRef.current);
        }

        exploreDebounceRef.current = setTimeout(() => {
            setStableExploreIds(prev => {
                const myFeedSet = new Set(userState.follows.map(f => f.ipnsKey));
                myFeedSet.add(myPeerId);

                const currentExploreIdsSet = new Set(prev);
                const newIds: string[] = [];

                debouncedPostsMap.forEach((post) => {
                    if (!myFeedSet.has(post.authorKey) && !currentExploreIdsSet.has(post.id)) {
                        newIds.push(post.id);
                    }
                });

                if (newIds.length === 0) return prev; 
                return [...prev, ...newIds]; 
            });
        }, 500); 

        return () => {
            if (exploreDebounceRef.current) clearTimeout(exploreDebounceRef.current);
        };

    }, [debouncedPostsMap, userState, myPeerId]); 


    // Backoff Logic
    const ensurePostsAreFetched = useCallback(async (postCids: string[], authorHint?: string, force: boolean = false) => {
        const allowedCids = postCids.filter(cid => {
            if (allPostsMapRef.current.has(cid)) return false; 
            if (force) return true;
            return !shouldSkipRequest(cid); 
        });

        if (allowedCids.length === 0) return;

        // Mark them as pending immediately to prevent thundering herd
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

    const fetchUser = useCallback(async (ipnsKey: string, force?: boolean) => {
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
    }, [allUserStatesMap, ensurePostsAreFetched]);

    const { isCoolingDown, countdown } = useCooldown(
        userState?.updatedAt || 0,
        POST_COOLDOWN_MS 
    );

    const loginWithKuboWrapper = async (apiUrl: string, keyName: string, username?: string, password?: string) => {
        await loginWithKubo(apiUrl, keyName, username, password);
    };

    const refreshFeed = useCallback(async (_force: boolean = false) => {
        if (isLoggedIn && myPeerId && userState) {
            await processMainFeed(userState);
        }
    }, [isLoggedIn, myPeerId, userState, processMainFeed]);

    // OPTIMIZATION: Batch populate allUserStatesMap from lastSeenCids in follows
    const allUserStatesMapRef = useRef(allUserStatesMap);
    useEffect(() => { allUserStatesMapRef.current = allUserStatesMap; }, [allUserStatesMap]);
    
    useEffect(() => {
        if (!userState || !userState.follows) return;
        
        const populateUserStatesFromFollows = async () => {
            const followsWithCids = userState.follows.filter(f => f.ipnsKey && f.lastSeenCid && !shouldSkipRequest(f.lastSeenCid));
            
            // OPTIMIZATION: Process in batches of 3 to avoid overwhelming gateway
            const BATCH_SIZE = 3;
            const BATCH_DELAY_MS = 500; // Delay between batches
            
            for (let i = 0; i < followsWithCids.length; i += BATCH_SIZE) {
                const batch = followsWithCids.slice(i, i + BATCH_SIZE);
                
                const promises = batch.map(async (follow) => {
                    // Skip if already in map
                    if (allUserStatesMapRef.current.has(follow.ipnsKey)) return;
                    
                    // Check backoff
                    if (shouldSkipRequest(follow.lastSeenCid!)) return;
                    
                    markRequestPending(follow.lastSeenCid!);
                    
                    try {
                        const fetchedState = await fetchUserState(follow.lastSeenCid!, follow.ipnsKey);
                        
                        // Pin the lastSeenCid to avoid waiting for IPNS resolution in future
                        pinCid(follow.lastSeenCid!).catch(() => {}); // Fire-and-forget, don't block
                        
                        // Store in map
                        setAllUserStatesMap(prev => {
                            const next = new Map(prev);
                            next.set(follow.ipnsKey, fetchedState);
                            return next;
                        });
                        
                        // Update profile map
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
                        // Check if it's a 504 or timeout error
                        if (e?.message?.includes('504') || e?.message?.includes('Gateway Timeout') || e?.message?.includes('timeout')) {
                            console.warn(`[App] Gateway timeout for ${follow.ipnsKey} (${follow.lastSeenCid}), will retry later via backoff`);
                        } else {
                            console.warn(`[App] Failed to populate user state for ${follow.ipnsKey} from lastSeenCid`, e);
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

    const hasInitialFetch = useRef(false);
    useEffect(() => {
        if (!isLoggedIn) {
            hasInitialFetch.current = false;
            setIsFeedLoaded(false); 
        }
    }, [isLoggedIn]);

    // --- INITIAL FETCH TRIGGER ---
    useEffect(() => {
        if (isLoggedIn && userState && !hasInitialFetch.current) {
            hasInitialFetch.current = true;
            console.log("[App] Initial fetch triggered (My Feed only).");
            
            refreshFeed().then(() => {
                setIsFeedLoaded(true); 
            });
        }
    }, [isLoggedIn, userState, refreshFeed]);

    const replyGraph = useMemo(() => {
        const map = new Map<string, string[]>();
        debouncedPostsMap.forEach(post => {
            if (post.referenceCID) {
                const parent = post.referenceCID;
                const existing = map.get(parent) || [];
                existing.push(post.id);
                map.set(parent, existing);
            }
        });
        return map;
    }, [debouncedPostsMap]);

    const getReplyCount = useCallback((postId: string): number => {
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

    // --- MODIFIED FEED GENERATION (REMOVED SORT) ---
    const { myFeedPosts, exploreFeedPosts } = useMemo(() => {
        if (!userState) return { myFeedPosts: [], exploreFeedPosts: [] };
        
        // REMOVED: const sorter = (a: Post, b: Post) => b.timestamp - a.timestamp;
        
        // OPTIMIZATION: Use debounced map to reduce recalculations
        // This preserves "Load Order" because Map.values() iterates in insertion order.
        // As useFeed adds batches, they are added to the end of the Map.
        const allPosts = Array.from(debouncedPostsMap.values());
        
        const myFeedSet = new Set(userState.follows.map(f => f.ipnsKey));
        myFeedSet.add(myPeerId);

        const myFeed = allPosts
            .filter(p => myFeedSet.has(p.authorKey));
            // .sort(sorter); // <--- REMOVED TO PRESERVE APPEND BEHAVIOR

        const exploreFeed = stableExploreIds
            .map(id => debouncedPostsMap.get(id))
            .filter((p): p is Post => !!p); 

        return {
            myFeedPosts: myFeed,
            exploreFeedPosts: exploreFeed
        };
    }, [allPostsMap, userState, myPeerId, stableExploreIds]);

    // Compute unifiedIds (used by HomePage) - uses debounced map
    const unifiedIds = useMemo(() => {
        if (!userState) return [];
        const dislikedIds = new Set(userState.dislikedPostCIDs || []);
        const blockedUsers = new Set(userState.blockedUsers || []);
        const followingSet = new Set(userState.follows?.map(f => f.ipnsKey) || []);
        
        const isValidRootPost = (p: Post) => !p.referenceCID && !dislikedIds.has(p.id) && !blockedUsers.has(p.authorKey);

        const myIds: string[] = [];
        for (const post of debouncedPostsMap.values()) {
            const isMyPost = (myIpnsKey && post.authorKey === myIpnsKey) || (myPeerId && post.authorKey === myPeerId);
            const isFollowed = followingSet.has(post.authorKey);
            
            if (!isValidRootPost(post)) continue;
            
            if (isFollowed || isMyPost) {
                myIds.push(post.id);
            }
        }
        
        const myIdsSet = new Set(myIds);
        const exploreIds = exploreFeedPosts
            .filter(p => isValidRootPost(p) && !myIdsSet.has(p.id))
            .map(p => p.id);
        
        return [...myIds, ...exploreIds];
    }, [debouncedPostsMap, exploreFeedPosts, userState, myIpnsKey, myPeerId]);

    const loadMoreFeed = useCallback(async () => {
        if (canLoadMoreMyFeed) await loadMoreMyFeed();
        if (canLoadMoreExplore) await loadMoreExplore();
    }, [canLoadMoreMyFeed, canLoadMoreExplore, loadMoreMyFeed, loadMoreExplore]);

    return {
        isLoggedIn, userState, myIpnsKey, myPeerId, latestStateCID,
        isLoadingFeed, isProcessing, isCoolingDown, countdown,
        loginWithKubo: loginWithKuboWrapper, logout,
        addPost, deletePost, likePost, dislikePost, followUser, unfollowUser, blockUser, unblockUser,
        refreshFeed,
        isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore,
        updateProfile, 
        ensurePostsAreFetched, 
        fetchUser, 
        unresolvedFollows, allPostsMap, allUserStatesMap, userProfilesMap,
        otherUsers,
        isInitializeDialogOpen, onInitializeUser, onRetryLogin,
        loadMoreMyFeed, canLoadMoreMyFeed,
        setAllPostsMap,
        setAllUserStatesMap,
        setUserProfilesMap,
        setLatestStateCID,
        myFeedPosts,
        exploreFeedPosts,
        getReplyCount,
        unifiedIds,
        loadMoreFeed,
        isSessionLocked,
        unlockSession
    };
};

export const useAppState = (): UseAppStateReturn => {
    const context = useContext(AppStateContext);
    if (!context) throw new Error('useAppState must be used within an AppStateProvider');
    return context;
};