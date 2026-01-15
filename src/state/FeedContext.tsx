import React, { createContext, useContext, useState, useMemo } from 'react';
import { Post, UserProfile, OnlinePeer, UserState, NewPostData } from '../types';
import { useCooldown } from '../hooks/useCooldown';
import { useParentPostFetcher } from '../hooks/useSharedPostFetcher';
import { useAppFeed } from '../features/feed/useFeed';
import { useAppExplore } from '../features/feed/useExploreFeed';
import { useAppPeers } from '../features/feed/useOnlinePeers';
import { useAppActions } from '../state/useActions';
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess, markRequestPending } from '../lib/fetchBackoff';
import { resolveIpns, fetchUserState } from '../api/ipfsIpns';

// We import the AuthContext hook here if we separate Auth, but for this step
// we are defining FeedContext. 
// Ideally, FeedContext depends on Auth.

// TEMPORARY: We will assume we receive Auth State as props or use a hook if available.
// For now, let's stick to the plan:
// 1. Create FeedContext that manages the Data (Posts, Profiles, Feeds).

export interface FeedContextState {
    allPostsMap: Map<string, Post>;
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
    followUser: (ipnsKey: string) => Promise<void>;
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

    myFeedPosts: Post[];
    exploreFeedPosts: Post[];
    myFeedIds: string[];
    exploreFeedIds: string[];
    unifiedIds: string[];
    loadMoreFeed: () => Promise<void>;
    getReplyCount: (postId: string) => number;
    
    // --- SETTERS (Exposed for Legacy Compatibility) ---
    // CAUTION: Use with care. Prefer using Actions.
    setAllPostsMap?: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setUserProfilesMap?: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
}

export const FeedContext = createContext<FeedContextState | null>(null);

interface FeedProviderProps {
    children: React.ReactNode;
    // We inject auth state to avoid circular dependency or complex setup in this step
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
    const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
    const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
    const [followCursors, setFollowCursors] = useState<Map<string, string | null>>(new Map());
    const [isFeedLoaded, setIsFeedLoaded] = useState(false);
    
    // Stable Explore
    const [stableExploreIds, setStableExploreIds] = useState<string[]>([]);
    const exploreDebounceRef = React.useRef<NodeJS.Timeout | null>(null);

    // Refs
    const allPostsMapRef = React.useRef(allPostsMap);
    React.useEffect(() => { allPostsMapRef.current = allPostsMap; }, [allPostsMap]);

    // Actions
    const { 
        isProcessing, addPost, deletePost, likePost, dislikePost, followUser, unfollowUser, updateProfile, 
        blockUser, unblockUser,
        queueFollowUpdates 
    } = useAppActions({
        userState, setUserState, myIpnsKey, myPeerId, latestStateCID,
        setAllPostsMap, setLatestStateCID, setUserProfilesMap, allPostsMap
    });

    // Shared Fetcher
    const { fetchMissingParentPost } = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap
    });

    // Peers
    const { otherUsers } = useAppPeers({ isLoggedIn, myPeerId, userState });

    // Main Feed
    const { 
        isLoadingFeed, processMainFeed, ensurePostsAreFetched: originalEnsurePosts, 
        loadMoreMyFeed, canLoadMoreMyFeed 
    } = useAppFeed({
        allPostsMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, 
        fetchMissingParentPost, followCursors, setFollowCursors,
        updateFollowMetadata: async (updates) => queueFollowUpdates(updates),
        myIpnsKey,
        myLatestStateCID: latestStateCID
    });

    // Explore Feed
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

    // Instant Profile Sync
    React.useEffect(() => {
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

    // Stabilize Explore
    React.useEffect(() => {
        if (!userState) return;
        if (exploreDebounceRef.current) clearTimeout(exploreDebounceRef.current);

        exploreDebounceRef.current = setTimeout(() => {
            setStableExploreIds(prev => {
                const myFeedSet = new Set(userState.follows.map(f => f.ipnsKey));
                myFeedSet.add(myPeerId);

                const currentExploreIdsSet = new Set(prev);
                const newIds: string[] = [];

                allPostsMap.forEach((post) => {
                    if (!myFeedSet.has(post.authorKey) && !currentExploreIdsSet.has(post.id)) {
                        newIds.push(post.id);
                    }
                });

                if (newIds.length === 0) return prev; 
                return [...prev, ...newIds]; 
            });
        }, 500); 

        return () => { if (exploreDebounceRef.current) clearTimeout(exploreDebounceRef.current); };
    }, [allPostsMap, userState, myPeerId]);

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

    const fetchUser = React.useCallback(async (ipnsKey: string) => {
        if (!ipnsKey) return;
        if (shouldSkipRequest(ipnsKey)) return;
        
        try {
            const cid = await resolveIpns(ipnsKey);
            if (cid) {
                const fetchedState = await fetchUserState(cid, ipnsKey);
                if (fetchedState && fetchedState.profile) {
                    setUserProfilesMap(prev => {
                        const next = new Map(prev);
                        next.set(ipnsKey, fetchedState.profile!);
                        return next;
                    });
                }
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
    }, [userProfilesMap, ensurePostsAreFetched]);

    // Cooldown
    const { isCoolingDown, countdown } = useCooldown(
        userState?.updatedAt || 0,
        300 * 1000 
    );

    // Refresh Logic
    const refreshFeed = React.useCallback(async (_force: boolean = false) => {
        if (isLoggedIn && myPeerId && userState) {
            await processMainFeed(userState);
        }
    }, [isLoggedIn, myPeerId, userState, processMainFeed]);

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
            console.log("[FeedProvider] Initial fetch triggered.");
            refreshFeed().then(() => setIsFeedLoaded(true));
        }
    }, [isLoggedIn, userState, refreshFeed]);

    // Reply Graph (Incremental Logic)
    const [replyGraph, setReplyGraph] = useState<Map<string, string[]>>(new Map());
    const previousMapSize = React.useRef(0);

    // Effect: Rebuild Graph only when necessary
    React.useEffect(() => {
        // Optimization: If the size hasn't changed, we likely just updated a timestamp or non-structural field.
        // This is a heuristic. A true diff would be expensive.
        // However, since we mainly append, size check is a good proxy for "new posts added".
        if (allPostsMap.size === previousMapSize.current && allPostsMap.size > 0) {
            return;
        }

        const newGraph = new Map<string, string[]>();
        allPostsMap.forEach(post => {
            if (post.referenceCID) {
                const parent = post.referenceCID;
                const existing = newGraph.get(parent) || [];
                existing.push(post.id);
                newGraph.set(parent, existing);
            }
        });
        
        setReplyGraph(newGraph);
        previousMapSize.current = allPostsMap.size;
    }, [allPostsMap]);

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

    // Feed Generation
    const { myFeedPosts, exploreFeedPosts, myFeedIds, exploreFeedIds, unifiedIds } = useMemo(() => {
        if (!userState) return { myFeedPosts: [], exploreFeedPosts: [], myFeedIds: [], exploreFeedIds: [], unifiedIds: [] };
        
        const allPosts = Array.from(allPostsMap.values());
        const followsSet = new Set(userState.follows.map(f => f.ipnsKey));
        const blockedSet = new Set(userState.blockedUsers || []);
        
        // Helper: Find Root
        const findRoot = (startId: string): string => {
            let curr = allPostsMap.get(startId);
            const visited = new Set<string>();
            while (curr && curr.referenceCID && !visited.has(curr.id)) {
                visited.add(curr.id);
                const parent = allPostsMap.get(curr.referenceCID);
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

        // 1. MY FEED
        const myFeed = allPosts.filter(p => {
            // A. Post is by ME
            if (p.authorKey === myPeerId) return true;
            
            // BLOCKED FILTER
            if (blockedSet.has(p.authorKey)) return false;
            
            // B. Post is by Followed User
            if (followsSet.has(p.authorKey)) return true;

            // C. Post is a Root of a thread I participated in
            if (myParticipatedRootIds.has(p.id)) return true;
            
            return false;
        });
        
        console.log(`[FeedContext] Recalculating Feed. Total Posts: ${allPosts.length}. MyPeerId: ${myPeerId}. My Feed Count: ${myFeed.length}.`);
        
        // 2. EXPLORE FEED
        // - Logic: Show the ROOT post if it contains any "Explore-Relevant" activity (Stranger Reply).
        // - This groups the conversation under the original context.

        const isStranger = (key: string) => key !== myPeerId && !followsSet.has(key) && !blockedSet.has(key);


        const exploreRelevantIds = new Set<string>();

        // Scan all posts to find "Stranger Replies"
        allPosts.forEach(post => {
             // If a stranger posted this (and it's a reply or root)
             if (isStranger(post.authorKey)) {
                 // The post itself is content. Trace to root.
                 exploreRelevantIds.add(findRoot(post.id));
             }
        });

        // Also check "My Posts" replied to by strangers (already covered if we scan the stranger's reply above)
        // because the stranger's reply (post.authorKey == stranger) will trigger findRoot(reply) -> MyRoot.

        const exploreFeed = Array.from(exploreRelevantIds)
            .map(id => allPostsMap.get(id))
            .filter((p): p is Post => !!p)
            .filter(p => !blockedSet.has(p.authorKey)); // Final safety check
        
        // Sort by timestamp (Newest first)
        myFeed.sort((a, b) => b.timestamp - a.timestamp);
        exploreFeed.sort((a, b) => b.timestamp - a.timestamp);

        // --- Unified IDs Calculation (for Navigation) ---
        // 1. Filter for Top-Level Posts only (no replies) & remove dislikes
        const dislikedIds = new Set(userState.dislikedPostCIDs || []);
        const isTopLevel = (p: Post) => !p.referenceCID && !dislikedIds.has(p.id);

        const myTopLevel = myFeed.filter(isTopLevel);
        const exploreTopLevel = exploreFeed.filter(isTopLevel);

        const myIds = myTopLevel.map(p => p.id);
        const myIdsSet = new Set(myIds);

        // 2. Merge Explore (Deduplicated)
        const exploreIds = exploreTopLevel
            .filter(p => !myIdsSet.has(p.id))
            .map(p => p.id);
            
        const unified = [...myIds, ...exploreIds];

        return { 
            myFeedPosts: myFeed, 
            exploreFeedPosts: exploreFeed,
            myFeedIds: myFeed.map(p => p.id),
            exploreFeedIds: exploreFeed.map(p => p.id),
            unifiedIds: unified
        };
    }, [allPostsMap, userState, myPeerId, stableExploreIds, replyGraph]);

    const loadMoreFeed = React.useCallback(async () => {
        if (canLoadMoreMyFeed) await loadMoreMyFeed();
        if (canLoadMoreExplore) await loadMoreExplore();
    }, [canLoadMoreMyFeed, canLoadMoreExplore, loadMoreMyFeed, loadMoreExplore]);

    const value: FeedContextState = {
        allPostsMap, userProfilesMap, unresolvedFollows, otherUsers,
        isLoadingFeed, isProcessing, isCoolingDown, countdown,
        addPost, deletePost, likePost, dislikePost, followUser, unfollowUser, updateProfile,
        blockUser, unblockUser,
        refreshFeed, isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore,
        loadMoreMyFeed, canLoadMoreMyFeed, ensurePostsAreFetched, fetchUser,
        myFeedPosts, exploreFeedPosts, 
        myFeedIds, exploreFeedIds, unifiedIds, loadMoreFeed,
        getReplyCount,
        // Expose setters
        setAllPostsMap,
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
