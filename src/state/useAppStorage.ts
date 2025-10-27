// fileName: src/state/useAppStorage.ts
import { useState, useMemo, useContext, useCallback } from 'react';
import toast from 'react-hot-toast';
import { AppStateContext } from '../state/AppContext';
import { UserState, Post, UserProfile, OnlinePeer, NewPostData } from '@/types';
import { useCooldown } from '@/hooks/useCooldown';
import { useParentPostFetcher } from '@/hooks/useSharedPostFetcher';
import { useAppAuth, UseAppAuthReturn } from '@/features/auth/useAuth';
import { useAppFeed, UseAppFeedReturn } from '@/features/feed/useFeed';
import { useAppExplore, UseAppExploreReturn } from '@/features/feed/useExploreFeed';
import { useAppPeers } from '@/features/feed/useOnlinePeers';
import { useAppActions } from './useActions';

const POST_COOLDOWN_MS = 300 * 1000;

export interface UseAppStateReturn {
    isLoggedIn: boolean | null;
	userState: UserState | null;
	myIpnsKey: string;
	latestStateCID: string;
	isLoadingFeed: boolean;
	isProcessing: boolean;
	isCoolingDown: boolean;
	countdown: number;
	loginWithKubo: (apiUrl: string, keyName: string) => Promise<void>;
	logout: () => void;
	addPost: (postData: NewPostData) => Promise<void>;
	likePost: (postId: string) => Promise<void>;
	dislikePost: (postId: string) => Promise<void>;
	followUser: (ipnsKeyToFollow: string) => Promise<void>;
	unfollowUser: (ipnsKeyToUnfollow: string) => Promise<void>;
	refreshFeed: (force?: boolean) => Promise<void>;
	isLoadingExplore: boolean;
	loadMoreExplore: () => Promise<void>;
	refreshExploreFeed: () => Promise<void>;
    canLoadMoreExplore: boolean;
	updateProfile: (profileData: Partial<UserProfile>) => Promise<void>;
    // --- START MODIFICATION: Update signature ---
	ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
    // --- END MODIFICATION ---
	unresolvedFollows: string[];
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	otherUsers: OnlinePeer[];
    isInitializeDialogOpen: boolean;
    onInitializeUser: (() => void) | null;
    onRetryLogin: (() => void) | null;
}

export const useAppStateInternal = (): UseAppStateReturn => {
    const [userState, setUserState] = useState<UserState | null>(null);
	const [myIpnsKey, setMyIpnsKey] = useState<string>('');
	const [latestStateCID, setLatestStateCID] = useState<string>('');
	const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
    const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
	const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
	const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
	const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    const [initializeDialog, setInitializeDialog] = useState<{
        isOpen: boolean;
        onInitialize: (() => void) | null;
        onRetry: (() => void) | null;
    }>({ isOpen: false, onInitialize: null, onRetry: null });
	const lastPostTimestamp = useMemo(() => userState?.updatedAt, [userState]);
	const { isCoolingDown, countdown } = useCooldown(lastPostTimestamp, POST_COOLDOWN_MS);

	const resetAllState = useCallback(() => {
        setUserState(null); setMyIpnsKey(''); setLatestStateCID(''); setIsLoggedIn(false);
        setAllPostsMap(new Map()); setUserProfilesMap(new Map());
        setUnresolvedFollows([]); setOtherUsers([]);
        setInitializeDialog({ isOpen: false, onInitialize: null, onRetry: null });
        toast("Logged out.");
	}, []);

    const openInitializeDialog = (onInitialize: () => void, onRetry: () => void) => {
        setInitializeDialog({ isOpen: true, onInitialize, onRetry });
    };
    const closeInitializeDialog = () => {
        setInitializeDialog({ isOpen: false, onInitialize: null, onRetry: null });
    };

	const fetchMissingParentPost = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap,
    });
	const { isLoadingFeed, processMainFeed, ensurePostsAreFetched }: UseAppFeedReturn = useAppFeed({
        allPostsMap, userProfilesMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost,
    });
	const { loginWithKubo, logout }: UseAppAuthReturn = useAppAuth({
        setUserState, setMyIpnsKey, setLatestStateCID, setIsLoggedIn, resetAllState, currentUserState: userState, processMainFeed,
        openInitializeDialog, closeInitializeDialog
    });
	const { isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore }: UseAppExploreReturn = useAppExplore({
        myIpnsKey, userState, allPostsMap, setAllPostsMap, setUserProfilesMap, fetchMissingParentPost,
    });
	useAppPeers({
        isLoggedIn, myIpnsKey, userState, setOtherUsers,
    });

    const refreshFeed = useCallback(async (force?: boolean) => {
        console.log("[refreshFeed] Initiated. Force:", force); // <-- MODIFIED LOG
		if (isLoggedIn !== true || !myIpnsKey) {
             console.log("[refreshFeed] Skipping: Not logged in or no IPNS key."); // <-- ADDED LOG
             return;
        }
        // --- START MODIFICATION: Add cooldown check ---
        if (!force) {
            const timeSinceLastAction = Date.now() - (userState?.updatedAt || 0);
            if (userState?.updatedAt && timeSinceLastAction < POST_COOLDOWN_MS) {
                console.log(`[refreshFeed] Skipping non-forced refresh due to active cooldown (${Math.round((POST_COOLDOWN_MS - timeSinceLastAction)/1000)}s remaining).`);
                return; // Skip if cooling down and not forced
            }
        }
        // --- END MODIFICATION ---

        if (userState) {
            console.log("[refreshFeed] User state exists. Calling processMainFeed..."); // <-- ADDED LOG
            await processMainFeed(userState, myIpnsKey);
             console.log("[refreshFeed] processMainFeed completed."); // <-- ADDED LOG
        } else {
             console.warn("[refreshFeed] Cannot refresh, no user state available.");
        }
	}, [ isLoggedIn, myIpnsKey, userState, processMainFeed ]);


	const {
		isProcessing, addPost, likePost, dislikePost, followUser, unfollowUser, updateProfile,
	} = useAppActions({
		userState, setUserState, myIpnsKey, latestStateCID,
        setAllPostsMap, setLatestStateCID, setUserProfilesMap,
        refreshFeed, allPostsMap,
	});


	return {
		isLoggedIn, userState, myIpnsKey, latestStateCID,
		isLoadingFeed,
		isProcessing, isCoolingDown, countdown,
        loginWithKubo, logout,
		addPost, likePost, dislikePost, followUser, unfollowUser,
		refreshFeed,
		isLoadingExplore, loadMoreExplore, refreshExploreFeed,
        canLoadMoreExplore,
		updateProfile, ensurePostsAreFetched,
		unresolvedFollows, allPostsMap, userProfilesMap,
		otherUsers,
        isInitializeDialogOpen: initializeDialog.isOpen,
        onInitializeUser: initializeDialog.onInitialize,
        onRetryLogin: initializeDialog.onRetry,
	};
};

export const useAppState = (): UseAppStateReturn => {
	const context = useContext(AppStateContext);
	if (!context) throw new Error('useAppState must be used within an AppStateProvider');
	return context;
};