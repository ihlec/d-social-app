// src/context/AppContext.tsx
import React, { createContext, useMemo, ReactNode } from 'react';
import { useAppStateInternal, UseAppStateReturn } from '../state/useAppStorage';

const AppStateContext = createContext<UseAppStateReturn | null>(null);

interface AppStateProviderProps {
  children: ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  // --- FIX: Destructure all values from the hook ---
  const {
    isLoggedIn,
    userState,
    myIpnsKey,
    latestStateCID,
    isLoadingFeed,
    isProcessing,
    isCoolingDown,
    countdown,
    allPostsMap,
    userProfilesMap,
    exploreAllPostsMap,
    exploreUserProfilesMap,
    combinedUserProfilesMap,
    unresolvedFollows,
    otherUsers,
    loginWithFilebase,
    loginWithKubo,
    logout,
    addPost,
    likePost,
    dislikePost,
    followUser,
    unfollowUser,
    refreshFeed,
    isLoadingExplore, // <-- FIX: Added missing property
    loadMoreExplore,
    refreshExploreFeed,
    updateProfile,
    ensurePostsAreFetched,
  } = useAppStateInternal(); // The hook containing the actual logic

  // --- FIX: Memoize the *creation* of the context value object ---
  // This ensures consumers only re-render when a value they use *actually* changes.
  const contextValue = useMemo(() => ({
    isLoggedIn,
    userState,
    myIpnsKey,
    latestStateCID,
    isLoadingFeed,
    isProcessing,
    isCoolingDown,
    countdown,
    allPostsMap,
    userProfilesMap,
    exploreAllPostsMap,
    exploreUserProfilesMap,
    combinedUserProfilesMap,
    unresolvedFollows,
    otherUsers,
    loginWithFilebase,
    loginWithKubo,
    logout,
    addPost,
    likePost,
    dislikePost,
    followUser,
    unfollowUser,
    refreshFeed,
    isLoadingExplore, // <-- FIX: Added missing property
    loadMoreExplore,
    refreshExploreFeed,
    updateProfile,
    ensurePostsAreFetched,
  }), [
    // Add all states and functions to the dependency array
    isLoggedIn,
    userState,
    myIpnsKey,
    latestStateCID,
    isLoadingFeed,
    isProcessing,
    isCoolingDown,
    countdown,
    allPostsMap,
    userProfilesMap,
    exploreAllPostsMap,
    exploreUserProfilesMap,
    combinedUserProfilesMap,
    unresolvedFollows,
    otherUsers,
    loginWithFilebase,
    loginWithKubo,
    logout,
    addPost,
    likePost,
    dislikePost,
    followUser,
    unfollowUser,
    refreshFeed,
    isLoadingExplore, // <-- FIX: Added missing property
    loadMoreExplore,
    refreshExploreFeed,
    updateProfile,
    ensurePostsAreFetched,
  ]);


  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

export default AppStateContext;