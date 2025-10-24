// fileName: src/state/useAppStorage.ts
import { useState, useMemo, useContext, useCallback } from 'react'; // Removed useEffect
import toast from 'react-hot-toast';
import AppStateContext from '../state/AppContext';
import { UserState, Post, UserProfile, OnlinePeer, NewPostData } from '@/types'; // Use alias if configured
import { useCooldown } from '@/hooks/useCooldown'; // Use alias if configured

// Import new modular hooks
import { useParentPostFetcher } from '@/hooks/useSharedPostFetcher'; // Use alias if configured
import { useAppAuth, UseAppAuthReturn } from '@/features/auth/useAuth'; // Use alias if configured
import { useAppFeed, UseAppFeedReturn } from '@/features/feed/useFeed';   // Use alias if configured
// --- FIX: Import correct return type ---
import { useAppExplore, UseAppExploreReturn } from '@/features/feed/useExploreFeed'; // Use alias if configured
// --- END FIX ---
import { useAppPeers } from '@/features/feed/useOnlinePeers'; // Use alias if configured
import { useAppActions } from './useActions'; // Keep relative if in the same folder

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
	loginWithFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
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
    // --- FIX: Add canLoadMoreExplore ---
    canLoadMoreExplore: boolean;
    // --- END FIX ---
	updateProfile: (profileData: Partial<UserProfile>) => Promise<void>;
	ensurePostsAreFetched: (postCids: string[]) => Promise<void>;
	unresolvedFollows: string[];
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	otherUsers: OnlinePeer[];
}

// --- The Main Hook Logic (Assembler) ---
export const useAppStateInternal = (): UseAppStateReturn => {
    const [userState, setUserState] = useState<UserState | null>(null);
	const [myIpnsKey, setMyIpnsKey] = useState<string>('');
	const [latestStateCID, setLatestStateCID] = useState<string>('');
	const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
    const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
	const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
	const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
	const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);

	const lastPostTimestamp = useMemo(() => userState?.updatedAt, [userState]);
	const { isCoolingDown, countdown } = useCooldown(lastPostTimestamp, POST_COOLDOWN_MS);

	const resetAllState = useCallback(() => {
        setUserState(null); setMyIpnsKey(''); setLatestStateCID(''); setIsLoggedIn(false);
        setAllPostsMap(new Map()); setUserProfilesMap(new Map());
        setUnresolvedFollows([]); setOtherUsers([]);
        toast("Logged out.");
	}, []);

	const fetchMissingParentPost = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap,
    });
	const { isLoadingFeed, processMainFeed, ensurePostsAreFetched }: UseAppFeedReturn = useAppFeed({
        myIpnsKey, allPostsMap, userProfilesMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost,
    });
	const { loginWithFilebase, loginWithKubo, logout }: UseAppAuthReturn = useAppAuth({
        setUserState, setMyIpnsKey, setLatestStateCID, setIsLoggedIn, resetAllState, currentUserState: userState, processMainFeed
    });
    // --- FIX: Destructure canLoadMoreExplore ---
	const { isLoadingExplore, loadMoreExplore, refreshExploreFeed, canLoadMoreExplore }: UseAppExploreReturn = useAppExplore({
        myIpnsKey, userState, allPostsMap, setAllPostsMap, setUserProfilesMap, fetchMissingParentPost,
    });
    // --- END FIX ---
	useAppPeers({
        isLoggedIn, myIpnsKey, userState, setOtherUsers,
    });

    const refreshFeed = useCallback(async () => {
		if (isLoggedIn !== true || !myIpnsKey) return;
        if (userState) {
            console.log("[refreshFeed] Re-processing current user state.");
            await processMainFeed(userState);
        } else {
             console.warn("[refreshFeed] Cannot refresh, no user state available.");
        }
	}, [ isLoggedIn, myIpnsKey, userState, processMainFeed ]);


	const {
		isProcessing, addPost, likePost, dislikePost, followUser, unfollowUser, updateProfile,
	} = useAppActions({
		userState, setUserState, myIpnsKey, setAllPostsMap, setLatestStateCID, setUserProfilesMap, refreshFeed,
	});


	return {
		isLoggedIn, userState, myIpnsKey, latestStateCID,
		isLoadingFeed,
		isProcessing, isCoolingDown, countdown,
		loginWithFilebase, loginWithKubo, logout,
		addPost,
		likePost, dislikePost, followUser, unfollowUser,
		refreshFeed,
		isLoadingExplore, loadMoreExplore, refreshExploreFeed,
        // --- FIX: Return canLoadMoreExplore ---
        canLoadMoreExplore,
        // --- END FIX ---
		updateProfile, ensurePostsAreFetched,
		unresolvedFollows, allPostsMap, userProfilesMap,
		otherUsers,
	};
};

export const useAppState = (): UseAppStateReturn => {
	const context = useContext(AppStateContext);
	if (!context) throw new Error('useAppState must be used within an AppStateProvider');
	return context;
};