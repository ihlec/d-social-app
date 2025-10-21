import React, { createContext, useMemo, ReactNode } from 'react';
import { useAppStateInternal, UseAppStateReturn } from '../hooks/useAppState';

const AppStateContext = createContext<UseAppStateReturn | null>(null);

interface AppStateProviderProps {
  children: ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  const appState = useAppStateInternal(); // The hook containing the actual logic

  // Memoize the context value to prevent unnecessary re-renders of consumers
  const contextValue = useMemo(() => appState, [
    appState.isLoggedIn,
    appState.userState,
    appState.myIpnsKey,
    appState.latestStateCID,
    appState.isLoadingFeed,
    appState.isProcessing,
    appState.isCoolingDown,
    appState.countdown,
    appState.allPostsMap,
    appState.userProfilesMap,
    appState.exploreAllPostsMap,
    appState.exploreUserProfilesMap,
    appState.combinedUserProfilesMap,
    appState.unresolvedFollows,
    appState.otherUsers,
    appState.loginWithFilebase,
    appState.loginWithKubo,
    appState.logout,
    appState.addPost,
    appState.likePost,
    appState.dislikePost,
    appState.followUser,
    appState.unfollowUser,
    appState.refreshFeed,
    appState.loadMoreExplore,
    appState.refreshExploreFeed,
    appState.updateProfile,
  ]);


  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

export default AppStateContext;