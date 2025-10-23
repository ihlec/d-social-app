// fileName: src/context/AppContext.tsx
import React, { createContext, useMemo, ReactNode } from 'react';
// --- FIX: Revert import type ---
import { useAppStateInternal, UseAppStateReturn } from '../state/useAppStorage';
// --- END FIX ---

// --- FIX: Revert context type ---
const AppStateContext = createContext<UseAppStateReturn | null>(null);
// --- END FIX ---

interface AppStateProviderProps {
  children: ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  // Use the internal hook which now returns the reverted type
  const appState = useAppStateInternal();

  // Memoize the context value object based on the properties returned by the hook
  const contextValue = useMemo(() => ({
    ...appState, // Spread all properties from the reverted hook return value
  }), [
      // Add all properties from the reverted UseAppStateReturn type
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
      appState.isLoadingExplore,
      appState.loadMoreExplore,
      appState.refreshExploreFeed,
      appState.updateProfile,
      appState.ensurePostsAreFetched,
      // Modal properties removed from dependency array
  ]);


  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

export default AppStateContext;