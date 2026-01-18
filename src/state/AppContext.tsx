// fileName: src/state/AppContext.tsx
import React, { createContext, useContext } from 'react';
import { UseAppStateReturn } from './useAppStorage'; // Type def only
import { AuthProvider, useAuthContext } from './AuthContext';
import { FeedProvider, useFeedContext } from './FeedContext';

// We want to maintain compatibility for now, so we expose the aggregated state via the old Context name
// But internally, we will assume consumers should ideally migrate.
// For now, AppStateContext will be a "facade" context or we just provide a hook that aggregates.

export const AppStateContext = createContext<UseAppStateReturn | null>(null);

// Wrapper that combines the two contexts into the legacy shape
const LegacyStateAggregator: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const auth = useAuthContext();
    const feed = useFeedContext();

    // Map to Legacy Interface
    const aggregated: UseAppStateReturn = {
        // Auth
        isLoggedIn: auth.isLoggedIn,
        userState: auth.userState,
        myIpnsKey: auth.myIpnsKey,
        myPeerId: auth.myPeerId,
        latestStateCID: auth.latestStateCID,
        loginWithKubo: async (apiUrl: string, keyName: string, username?: string, password?: string) => {
            await auth.loginWithKubo(apiUrl, keyName, username, password);
        },
        logout: auth.logout,
        isInitializeDialogOpen: auth.isInitializeDialogOpen,
        onInitializeUser: auth.onInitializeUser,
        onRetryLogin: auth.onRetryLogin,
        setLatestStateCID: auth.setLatestStateCID,
        
        // Feed / Data
        allPostsMap: feed.allPostsMap,
        allUserStatesMap: feed.allUserStatesMap,
        userProfilesMap: feed.userProfilesMap,
        unresolvedFollows: feed.unresolvedFollows,
        otherUsers: feed.otherUsers,
        isLoadingFeed: feed.isLoadingFeed,
        isProcessing: feed.isProcessing,
        isCoolingDown: feed.isCoolingDown,
        countdown: feed.countdown,
        addPost: feed.addPost,
        deletePost: feed.deletePost,
        likePost: feed.likePost,
        dislikePost: feed.dislikePost,
        followUser: feed.followUser,
        unfollowUser: feed.unfollowUser,
        blockUser: feed.blockUser,
        unblockUser: feed.unblockUser,
        updateProfile: feed.updateProfile,
        refreshFeed: feed.refreshFeed,
        isLoadingExplore: feed.isLoadingExplore,
        loadMoreExplore: feed.loadMoreExplore,
        refreshExploreFeed: feed.refreshExploreFeed,
        canLoadMoreExplore: feed.canLoadMoreExplore,
        loadMoreMyFeed: feed.loadMoreMyFeed,
        canLoadMoreMyFeed: feed.canLoadMoreMyFeed,
        ensurePostsAreFetched: feed.ensurePostsAreFetched,
        fetchUser: feed.fetchUser,
        myFeedPosts: feed.myFeedPosts,
        exploreFeedPosts: feed.exploreFeedPosts,
        getReplyCount: feed.getReplyCount,
        unifiedIds: feed.unifiedIds,
        loadMoreFeed: feed.loadMoreFeed,
        
        // setters (Less used in consumers, but maintained for compatibility if needed)
        // These are actually problematic because FeedContext doesn't expose raw setters usually.
        // But for 'useAppStateInternal' return type, they were there.
        // We might need to mock them or update the interface.
        // FeedContext exposes the STATE, but maybe not the raw setState.
        // Checking FeedContextState... it has map but not setAllPostsMap.
        // FIX: Add setters to FeedContext if consumers heavily rely on them, OR cast as any if unused.
        setAllPostsMap: feed.setAllPostsMap || (() => console.warn("setAllPostsMap deprecated")),
        setAllUserStatesMap: feed.setAllUserStatesMap || (() => console.warn("setAllUserStatesMap deprecated")),
        setUserProfilesMap: feed.setUserProfilesMap || (() => console.warn("setUserProfilesMap deprecated")),
        
        // Session Unlock
        isSessionLocked: auth.isSessionLocked,
        unlockSession: auth.unlockSession,
    } as UseAppStateReturn;

    return (
        <AppStateContext.Provider value={aggregated}>
            {children}
        </AppStateContext.Provider>
    );
};

// Bridge Component: AuthenticatedFeedProvider
// Need to extract auth state to pass to FeedProvider
const FeedProviderBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const auth = useAuthContext();
    return (
        <FeedProvider authState={{
            isLoggedIn: auth.isLoggedIn,
            userState: auth.userState,
            myIpnsKey: auth.myIpnsKey,
            myPeerId: auth.myPeerId,
            latestStateCID: auth.latestStateCID,
            setLatestStateCID: auth.setLatestStateCID,
            setUserState: auth.setUserState,
        }}>
            <LegacyStateAggregator>
                {children}
            </LegacyStateAggregator>
        </FeedProvider>
    );
};

export const AppStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <AuthProvider>
        <FeedProviderBridge>
            {children}
        </FeedProviderBridge>
    </AuthProvider>
  );
};

export const useAppContext = (): UseAppStateReturn => {
    const context = useContext(AppStateContext);
    if (!context) {
        throw new Error("useAppContext must be used within an AppStateProvider");
    }
    return context;
};