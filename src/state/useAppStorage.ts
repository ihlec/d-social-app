// fileName: src/state/useAppStorage.ts
import { useState, useMemo, useContext, useCallback, useEffect, useRef } from 'react';
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
    // --- FIX: Removed explore and combined maps ---
	// exploreAllPostsMap: Map<string, Post>;
	// exploreUserProfilesMap: Map<string, UserProfile>;
	// combinedUserProfilesMap: Map<string, UserProfile>;
    // --- END FIX ---
	otherUsers: OnlinePeer[];
}

// --- The Main Hook Logic (Assembler) ---
export const useAppStateInternal = (): UseAppStateReturn => {
    // Removed navigation hooks
    const [userState, setUserState] = useState<UserState | null>(null);
	const [myIpnsKey, setMyIpnsKey] = useState<string>('');
	const [latestStateCID, setLatestStateCID] = useState<string>('');
	const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
    // --- FIX: These are now the single source of truth ---
    const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
	const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
    // --- FIX: Removed explore-specific maps ---
	// const [exploreAllPostsMap, setExploreAllPostsMap] = useState<Map<string, Post>>(new Map());
	// const [exploreUserProfilesMap, setExploreUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
    // --- END FIX ---
	const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
	const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    const initialLoadRef = useRef(false);

	const lastPostTimestamp = useMemo(() => userState?.updatedAt, [userState]);
	const { isCoolingDown, countdown } = useCooldown(lastPostTimestamp, POST_COOLDOWN_MS);

	const resetAllState = useCallback(() => {
        setUserState(null); setMyIpnsKey(''); setLatestStateCID(''); setIsLoggedIn(false);
        // --- FIX: Reset single maps ---
        setAllPostsMap(new Map()); setUserProfilesMap(new Map());
        // setExploreAllPostsMap(new Map()); setExploreUserProfilesMap(new Map());
        // --- END FIX ---
        setUnresolvedFollows([]); setOtherUsers([]);
        initialLoadRef.current = false; toast("Logged out.");
	}, []);

	// --- FIX: Pass single maps to all hooks ---
	const fetchMissingParentPost = useParentPostFetcher({
        allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap,
    });
	const { loginWithFilebase, loginWithKubo, logout, refreshAuthState }: UseAppAuthReturn = useAppAuth({
        setUserState, setMyIpnsKey, setLatestStateCID, setIsLoggedIn, resetAllState, currentUserState: userState
    });
	const { isLoadingFeed, processMainFeed, ensurePostsAreFetched }: UseAppFeedReturn = useAppFeed({
        myIpnsKey, allPostsMap, userProfilesMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost,
    });
	const { isLoadingExplore, loadMoreExplore, refreshExploreFeed } = useAppExplore({
        myIpnsKey, userState, allPostsMap, 
        setAllPostsMap, // Pass main setter
        setUserProfilesMap, // Pass main setter
        fetchMissingParentPost,
    });
	useAppPeers({
        isLoggedIn, myIpnsKey, userState, setOtherUsers,
    });
    // --- END FIX ---

	const refreshFeed = useCallback(async (force = false) => {
		if (isLoggedIn !== true || !myIpnsKey) return;

		let stateToProcess: UserState | null = null;
        let skipProcessFeed = false;

		if (force) {
			console.log("[refreshFeed] Manual forced refresh requested.");
            console.log("[refreshFeed] Attempting network fetch via refreshAuthState.");
            stateToProcess = await refreshAuthState(); // Updates userState internally
            if (stateToProcess === null) { console.warn("[refreshFeed] refreshAuthState failed. Aborting feed processing."); skipProcessFeed = true; }
		} else {
            // Non-forced refresh uses current state
            stateToProcess = userState;
        }

		if (stateToProcess && !skipProcessFeed) {
			await processMainFeed(stateToProcess);
		} else if (!skipProcessFeed) {
			console.warn("[refreshFeed] No valid user state available to process feed.");
		}
	}, [ isLoggedIn, myIpnsKey, userState, refreshAuthState, processMainFeed ]);

    // Initial load useEffect remains largely the same, relying on processMainFeed
    useEffect(() => {
        if (isLoggedIn === true && myIpnsKey && latestStateCID && userState?.profile && !initialLoadRef.current) {
            initialLoadRef.current = true;
            console.log("[useAppState useEffect] Initial load triggered. Processing current feed state.");
            if(userState){
                 processMainFeed(userState);
            } else {
                console.warn("[useAppState useEffect] Initial load: userState is null, cannot process feed yet.");
            }
        }
    }, [isLoggedIn, myIpnsKey, latestStateCID, userState, processMainFeed]); // Dependencies adjusted


	// Actions hook call remains the same
	const {
		isProcessing, addPost, likePost, dislikePost, followUser, unfollowUser, updateProfile,
	} = useAppActions({
		userState, setUserState, myIpnsKey, setAllPostsMap, setLatestStateCID, setUserProfilesMap, refreshFeed,
	});

	// --- FIX: Removed Memoized Derived State ---
    // const combinedUserProfilesMap = useMemo(() => new Map<string, UserProfile>([
    //     ...userProfilesMap, ...exploreUserProfilesMap
    // ]), [userProfilesMap, exploreUserProfilesMap]);
    // --- END FIX ---

	return {
		isLoggedIn, userState, myIpnsKey, latestStateCID,
		isLoadingFeed,
		isProcessing, isCoolingDown, countdown,
		loginWithFilebase, loginWithKubo, logout,
		addPost,
		likePost, dislikePost, followUser, unfollowUser,
		refreshFeed, // Ensure refreshFeed is returned
		isLoadingExplore, loadMoreExplore, refreshExploreFeed,
		updateProfile, ensurePostsAreFetched,
		unresolvedFollows, 
        allPostsMap, // Return single map
        userProfilesMap, // Return single map
        // --- FIX: Removed deleted maps from return ---
		// exploreAllPostsMap, exploreUserProfilesMap, combinedUserProfilesMap,
        // --- END FIX ---
		otherUsers,
	};
};

// --- Context Consumer Hook (remains the same type) ---
export const useAppState = (): UseAppStateReturn => {
	const context = useContext(AppStateContext);
	if (!context) throw new Error('useAppState must be used within an AppStateProvider');
	return context;
};