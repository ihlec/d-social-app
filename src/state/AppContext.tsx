import React, { createContext, useContext } from 'react';
import { UseAppStateReturn } from './useAppStorage'; // Type def only
import { AuthProvider, useAuthContext } from './AuthContext';
import { FeedProvider, useFeedContext } from './FeedContext';

/** Facade over AuthContext + FeedContext for useAppState / useAppContext consumers. */
export const AppStateContext = createContext<UseAppStateReturn | null>(null);

const StateAggregator: React.FC<{ children: React.ReactNode }> = ({ children }) => {
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
        loginWithHelia: async (keyName: string, passphrase?: string) => {
            await auth.loginWithHelia(keyName, passphrase);
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
        savePost: feed.savePost,
        clearMediaCache: feed.clearMediaCache,
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
        exploreFeedPosts: feed.exploreFeedPosts,
        getReplyCount: feed.getReplyCount,
        unifiedIds: feed.unifiedIds,
        loadMoreFeed: feed.loadMoreFeed,
        
        setAllPostsMap: feed.setAllPostsMap,
        setAllUserStatesMap: feed.setAllUserStatesMap,
        setUserProfilesMap: feed.setUserProfilesMap,
        isSessionLocked: auth.isSessionLocked,
        unlockSession: auth.unlockSession,
    };

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
            <StateAggregator>
                {children}
            </StateAggregator>
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