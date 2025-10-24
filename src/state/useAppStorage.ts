// fileName: src/state/useAppStorage.ts
import { useState, useMemo, useContext, useCallback } from 'react'; // Removed useRef
import toast from 'react-hot-toast';
import AppStateContext from '../state/AppContext';
import { UserState, Post, UserProfile, OnlinePeer, NewPostData } from '@/types'; // Use alias if configured
import { useCooldown } from '@/hooks/useCooldown'; // Use alias if configured

// Import new modular hooks
import { useParentPostFetcher } from '@/hooks/useSharedPostFetcher'; // Use alias if configured
import { useAppAuth, UseAppAuthReturn } from '@/features/auth/useAuth'; // Use alias if configured
import { useAppFeed, UseAppFeedReturn } from '@/features/feed/useFeed';   // Use alias if configured
import { useAppExplore } from '@/features/feed/useExploreFeed'; // Use alias if configured
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
	refreshFeed: (force?: boolean) => Promise<void>; // Keep refreshFeed
	isLoadingExplore: boolean;
	loadMoreExplore: () => Promise<void>;
	refreshExploreFeed: () => Promise<void>;
	updateProfile: (profileData: Partial<UserProfile>) => Promise<void>;
	ensurePostsAreFetched: (postCids: string[]) => Promise<void>;
	unresolvedFollows: string[];
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	otherUsers: OnlinePeer[];
}

// --- The Main Hook Logic (Assembler) ---
export const useAppStateInternal = (): UseAppStateReturn => {
    // Removed navigation hooks
    const [userState, setUserState] = useState<UserState | null>(null);
	const [myIpnsKey, setMyIpnsKey] = useState<string>('');
	const [latestStateCID, setLatestStateCID] = useState<string>('');
	const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null); // Start as null (loading)
    const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
	const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
	const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
	const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    // --- FIX: Removed initialLoadRef ---
    // const initialLoadRef = useRef(false);
    // --- END FIX ---

	const lastPostTimestamp = useMemo(() => userState?.updatedAt, [userState]);
	const { isCoolingDown, countdown } = useCooldown(lastPostTimestamp, POST_COOLDOWN_MS);

	const resetAllState = useCallback(() => {
        setUserState(null); setMyIpnsKey(''); setLatestStateCID(''); setIsLoggedIn(false);
        setAllPostsMap(new Map()); setUserProfilesMap(new Map());
        setUnresolvedFollows([]); setOtherUsers([]);
        // --- FIX: Removed initialLoadRef reset ---
        // initialLoadRef.current = false;
        // --- END FIX ---
        toast("Logged out.");
	}, []);

	// --- FIX: Pass processMainFeed from useAppFeed to useAppAuth ---
	const fetchMissingParentPost = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap,
    });
	const { isLoadingFeed, processMainFeed, ensurePostsAreFetched }: UseAppFeedReturn = useAppFeed({
        myIpnsKey, allPostsMap, userProfilesMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost,
    });
	const { loginWithFilebase, loginWithKubo, logout }: UseAppAuthReturn = useAppAuth({
        setUserState, setMyIpnsKey, setLatestStateCID, setIsLoggedIn, resetAllState, currentUserState: userState, processMainFeed // Pass it here
    });
	const { isLoadingExplore, loadMoreExplore, refreshExploreFeed } = useAppExplore({
        myIpnsKey, userState, allPostsMap, setAllPostsMap, setUserProfilesMap, fetchMissingParentPost,
    });
	useAppPeers({
        isLoggedIn, myIpnsKey, userState, setOtherUsers,
    });
    // --- END FIX ---

    // --- FIX: refreshFeed now calls the internal refreshAuthState ---
    // We need a way to trigger refreshAuthState from outside useAuth.
    // For simplicity, let's just use processMainFeed which indirectly uses the state fetched by useAuth's effect or login calls.
    // A forced refresh should likely re-run the state fetching part of useAuth.
    // Let's reconsider `refreshFeed`. Maybe it should trigger `refreshAuthState` somehow?
    // Easiest is to keep `refreshAuthState` internal to `useAuth` and have `refreshFeed` just call `processMainFeed` on current state.
    // Manual refresh might need a dedicated function exposed from `useAuth` if we want to force IPNS resolution.
    // For now, let's simplify `refreshFeed` to only re-process the current state.
    const refreshFeed = useCallback(async (/* force = false */) => {
        // The 'force' logic is now primarily handled within useAuth's refreshAuthState (via cooldown check).
        // This function will just re-process whatever state is current.
        // If a user *really* wants to bypass cooldown, they'd need a different mechanism (maybe logout/login).
		if (isLoggedIn !== true || !myIpnsKey) return;
        if (userState) {
            console.log("[refreshFeed] Re-processing current user state.");
            await processMainFeed(userState);
        } else {
             console.warn("[refreshFeed] Cannot refresh, no user state available.");
        }
	}, [ isLoggedIn, myIpnsKey, userState, processMainFeed ]);
    // --- END FIX ---

    // --- FIX: Removed Initial load useEffect ---
    // The initial load and feed processing is now handled entirely within useAuth's useEffect
    // useEffect(() => {
    //     if (isLoggedIn === true && myIpnsKey && latestStateCID && userState?.profile && !initialLoadRef.current) {
    //         initialLoadRef.current = true;
    //         console.log("[useAppState useEffect] Initial load triggered. Processing current feed state.");
    //         if(userState){
    //              processMainFeed(userState);
    //         } else {
    //             console.warn("[useAppState useEffect] Initial load: userState is null, cannot process feed yet.");
    //         }
    //     }
    // }, [isLoggedIn, myIpnsKey, latestStateCID, userState, processMainFeed]);
    // --- END FIX ---


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
		refreshFeed, // Keep refreshFeed
		isLoadingExplore, loadMoreExplore, refreshExploreFeed,
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