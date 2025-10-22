// src/context/AppContext.tsx
import React, { createContext, useMemo, ReactNode } from 'react';
// --- FIX: Corrected import path ---
import { useAppStateInternal, UseAppStateReturn } from '../state/useAppStorage';

const AppStateContext = createContext<UseAppStateReturn | null>(null);

interface AppStateProviderProps {
  children: ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  // --- Destructure all values from the hook ---
  const {
    isLoggedIn, // This is now boolean | null
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
    isLoadingExplore, 
    loadMoreExplore,
    refreshExploreFeed,
    updateProfile,
    ensurePostsAreFetched,
  } = useAppStateInternal(); // The hook containing the actual logic

  // --- Memoize the *creation* of the context value object ---
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
    isLoadingExplore, 
    loadMoreExplore,
    refreshExploreFeed,
    updateProfile,
    ensurePostsAreFetched,
  }), [
    // Add all states and functions to the dependency array
    isLoggedIn, // This dependency is now correct
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
    isLoadingExplore, 
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