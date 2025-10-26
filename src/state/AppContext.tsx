// fileName: src/state/AppContext.tsx
// src/context/AppContext.tsx
import React, { createContext } from 'react';
import { UseAppStateReturn, useAppStateInternal } from './useAppStorage'; // Assuming the internal hook is exported from here

// Create the context with a default value of null or a specific structure
// The default value should match the shape of UseAppStateReturn but can be null initially
const AppStateContext = createContext<UseAppStateReturn | null>(null);

interface AppStateProviderProps {
  children: React.ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  const appState = useAppStateInternal(); // Use the internal hook

  // Prepare the value to be passed down, ensure it matches UseAppStateReturn
  // Make sure all properties returned by useAppStateInternal are included here
  const contextValue: UseAppStateReturn = {
    isLoggedIn: appState.isLoggedIn,
    userState: appState.userState,
    myIpnsKey: appState.myIpnsKey,
    latestStateCID: appState.latestStateCID,
    isLoadingFeed: appState.isLoadingFeed,
    isProcessing: appState.isProcessing,
    isCoolingDown: appState.isCoolingDown,
    countdown: appState.countdown,
    // --- REMOVED: loginWithFilebase from context value ---
    // loginWithFilebase: appState.loginWithFilebase,
    loginWithKubo: appState.loginWithKubo,
    logout: appState.logout,
    addPost: appState.addPost,
    likePost: appState.likePost,
    dislikePost: appState.dislikePost,
    followUser: appState.followUser,
    unfollowUser: appState.unfollowUser,
    refreshFeed: appState.refreshFeed,
    isLoadingExplore: appState.isLoadingExplore,
    loadMoreExplore: appState.loadMoreExplore,
    refreshExploreFeed: appState.refreshExploreFeed,
    canLoadMoreExplore: appState.canLoadMoreExplore,
    updateProfile: appState.updateProfile,
    ensurePostsAreFetched: appState.ensurePostsAreFetched,
    unresolvedFollows: appState.unresolvedFollows,
    allPostsMap: appState.allPostsMap,
    userProfilesMap: appState.userProfilesMap,
    otherUsers: appState.otherUsers,
    isInitializeDialogOpen: appState.isInitializeDialogOpen,
    onInitializeUser: appState.onInitializeUser,
    onRetryLogin: appState.onRetryLogin,
  };

  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

export default AppStateContext;
