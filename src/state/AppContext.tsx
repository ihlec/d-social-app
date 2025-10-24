// fileName: src/state/AppContext.tsx
import React, { createContext, useMemo, ReactNode } from 'react';
import { useAppStateInternal, UseAppStateReturn } from '../state/useAppStorage';

const AppStateContext = createContext<UseAppStateReturn | null>(null);

interface AppStateProviderProps {
  children: ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  const appState = useAppStateInternal();

  // Memoize the context value object based on the properties returned by the hook
  const contextValue = useMemo(() => ({
    ...appState, // Spread all properties from the reverted hook return value
  }), [
      // Add all properties from the UseAppStateReturn type
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
      // --- FIX: Removed deleted maps ---
      // appState.exploreAllPostsMap,
      // appState.exploreUserProfilesMap,
      // appState.combinedUserProfilesMap,
      // --- END FIX ---
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
      appState.isLoadingExplore,
      appState.loadMoreExplore,
      appState.refreshExploreFeed,
      appState.updateProfile,
      appState.ensurePostsAreFetched,
  ]);


  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

export default AppStateContext;