// Thin reader over AppStateContext (AuthContext + FeedContext facade).
// The old useAppStateInternal monolith was a dead fork of FeedContext — removed.
import { useContext } from 'react';
import { AppStateContext } from './AppContext';
import { UserState, Post, UserProfile, OnlinePeer, NewPostData } from '../types';

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
    loginWithHelia: (keyName: string, passphrase?: string) => Promise<void>;
    logout: () => void;
    addPost: (postData: NewPostData) => Promise<void>;
    deletePost: (postId: string) => Promise<void>;
    likePost: (postId: string) => Promise<void>;
    dislikePost: (postId: string) => Promise<void>;
    savePost: (postId: string) => Promise<void>;
    clearMediaCache: () => Promise<void>;
    followUser: (ipnsKeyToFollow: string, opts?: { name?: string; stateCid?: string }) => Promise<void>;
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
    exploreFeedPosts: Post[];
    getReplyCount: (postId: string) => number;
    unifiedIds: string[];
    loadMoreFeed: () => Promise<void>;
    isSessionLocked: boolean;
    unlockSession: (password: string) => Promise<boolean>;
}

export const useAppState = (): UseAppStateReturn => {
    const context = useContext(AppStateContext);
    if (!context) throw new Error('useAppState must be used within an AppStateProvider');
    return context;
};
