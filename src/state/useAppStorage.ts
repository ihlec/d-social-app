// src/hooks/useAppState.ts
import { useState, useMemo, useContext, useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import AppStateContext from './AppContext';
import { UserState, Post, UserProfile, OnlinePeer, NewPostData } from '../types';
import { useCooldown } from '../hooks/useCooldown';
// --- FIX: Add fetchUserState ---
import { invalidateIpnsCache, fetchUserState } from '../api/ipfsIpns';
// --- End Fix ---

// Import new modular hooks
import { useParentPostFetcher } from '../hooks/useSharedPostFetcher';
import { useAppAuth, UseAppAuthReturn } from '../features/auth/useAuth';
import { useAppFeed, UseAppFeedReturn } from '../features/feed/useFeed';
import { useAppExplore } from '../features/feed/useExploreFeed';
import { useAppPeers } from '../features/feed/useOnlinePeers';
import { useAppActions } from './useActions';

const POST_COOLDOWN_MS = 300 * 1000;
const REFRESH_DELAY_MS = 250;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface UseAppStateReturn {
    // ... (interface remains the same)
    // --- FIX: isLoggedIn can now be null during initial load ---
    isLoggedIn: boolean | null;
    // --- End Fix ---
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
	updateProfile: (profileData: Partial<UserProfile>) => Promise<void>;
	ensurePostsAreFetched: (postCids: string[]) => Promise<void>;
	unresolvedFollows: string[];
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	exploreAllPostsMap: Map<string, Post>;
	exploreUserProfilesMap: Map<string, UserProfile>;
	combinedUserProfilesMap: Map<string, UserProfile>;
	otherUsers: OnlinePeer[];
}

// --- The Main Hook Logic (Assembler) ---
export const useAppStateInternal = (): UseAppStateReturn => {
	// ... (state definitions remain the same)
    const [userState, setUserState] = useState<UserState | null>(null);
	const [myIpnsKey, setMyIpnsKey] = useState<string>('');
	// latestStateCID is now primarily set by useAppAuth from cookie/login
	const [latestStateCID, setLatestStateCID] = useState<string>('');
    // --- FIX: Initialize isLoggedIn to null ---
	const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
    // --- End Fix ---
	const [allPostsMap, setAllPostsMap] = useState<Map<string, Post>>(new Map());
	const [userProfilesMap, setUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
	const [exploreAllPostsMap, setExploreAllPostsMap] = useState<Map<string, Post>>(new Map());
	const [exploreUserProfilesMap, setExploreUserProfilesMap] = useState<Map<string, UserProfile>>(new Map());
	const [unresolvedFollows, setUnresolvedFollows] = useState<string[]>([]);
	const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    const initialLoadRef = useRef(false);

	const lastPostTimestamp = useMemo(() => userState?.updatedAt, [userState]);
	const { isCoolingDown, countdown } = useCooldown(lastPostTimestamp, POST_COOLDOWN_MS);

	const resetAllState = useCallback(() => { // ...
        // --- FIX: Set isLoggedIn to false on reset ---
        setUserState(null); setMyIpnsKey(''); setLatestStateCID(''); setIsLoggedIn(false); 
        // --- End Fix ---
        setAllPostsMap(new Map()); setUserProfilesMap(new Map()); setExploreAllPostsMap(new Map()); setExploreUserProfilesMap(new Map()); setUnresolvedFollows([]); setOtherUsers([]); initialLoadRef.current = false; toast("Logged out.");
	}, []);

	// --- Modular Hook Composition ---
	const fetchMissingParentPost = useParentPostFetcher({ // ...
        allPostsMap, setAllPostsMap, exploreAllPostsMap, setExploreAllPostsMap, userProfilesMap, setUserProfilesMap, exploreUserProfilesMap, setExploreUserProfilesMap,
    });
	// useAppAuth sets initial isLoggedIn, myIpnsKey, latestStateCID, and minimal userState
	const { loginWithFilebase, loginWithKubo, logout, refreshAuthState }: UseAppAuthReturn = useAppAuth({
        setUserState, setMyIpnsKey, setLatestStateCID, setIsLoggedIn, resetAllState, currentUserState: userState
    });
	const { isLoadingFeed, processMainFeed, ensurePostsAreFetched }: UseAppFeedReturn = useAppFeed({ // ...
        myIpnsKey, allPostsMap, userProfilesMap, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost,
    });
	const { isLoadingExplore, loadMoreExplore, refreshExploreFeed } = useAppExplore({ // ...
        myIpnsKey, userState, allPostsMap, setExploreAllPostsMap, setExploreUserProfilesMap, fetchMissingParentPost,
    });
	useAppPeers({ // ...
        isLoggedIn, myIpnsKey, userState, setOtherUsers,
    });

	// --- Assembled Functions ---
    // refreshFeed is now ONLY for manual refresh button clicks (or programmatic forced refreshes elsewhere)
	const refreshFeed = useCallback(async (force = false) => {
        // --- FIX: Check for true ---
		if (isLoggedIn !== true || !myIpnsKey) return;
        // --- End Fix ---

		let stateToProcess: UserState | null = null;
        let skipProcessFeed = false;

		if (force) {
			console.log("[refreshFeed] Manual forced refresh requested.");
            if (isCoolingDown) {
                // Cooldown Active: Fetch state using cookie CID *for manual refresh*
                console.log(`[refreshFeed] Cooldown active (${countdown}s left). Fetching state from cookie CID: ${latestStateCID}`);
                toast("Refreshing feed (using local state reference due to cooldown)", { duration: 2000 });
                try {
                    // --- FIX: Pass profile name hint ---
                    stateToProcess = await fetchUserState(latestStateCID, userState?.profile?.name);
                    // --- End Fix ---
                    setUserState(stateToProcess); // Update main state
                } catch (err) { console.error("[refreshFeed] Failed to fetch state from cookie CID during cooldown:", err); toast.error("Failed to load state during cooldown."); stateToProcess = null; }
            } else {
                // Cooldown Over: Fetch from network
                console.log("[refreshFeed] Cooldown inactive. Attempting network fetch.");
                invalidateIpnsCache();
                console.log(`[refreshFeed] Delaying ${REFRESH_DELAY_MS}ms for IPNS propagation...`);
                await delay(REFRESH_DELAY_MS);
                console.log("[refreshFeed] Delay finished, refreshing auth state.");
                stateToProcess = await refreshAuthState(); // Updates userState internally
                 if (stateToProcess === null) { console.warn("[refreshFeed] refreshAuthState failed. Aborting feed processing."); skipProcessFeed = true; }
            }
		} else {
            // Non-forced refresh (if ever called) uses current state
            stateToProcess = userState;
        }

		if (stateToProcess && !skipProcessFeed) {
			await processMainFeed(stateToProcess);
		} else if (!skipProcessFeed) {
			console.warn("[refreshFeed] No valid user state available to process feed.");
		}
	}, [ isLoggedIn, myIpnsKey, userState, latestStateCID, refreshAuthState, processMainFeed, isCoolingDown, countdown, setUserState ]);

    // --- FIX: Revised Initial Load useEffect ---
    useEffect(() => {
        // --- FIX: Check for isLoggedIn === true ---
        if (isLoggedIn === true && myIpnsKey && latestStateCID && userState?.profile && !initialLoadRef.current) {
        // --- End Fix ---
            initialLoadRef.current = true; // Mark as run
            console.log("[useAppState useEffect] Initial load: Fetching state via cookie/login CID:", latestStateCID);

            // Directly fetch and process the state pointed to by the initial CID
            const loadInitialState = async () => {
                try {
                    // --- FIX: Pass profile name hint ---
                    // userState.profile.name is the correct name from useAuth's hydration
                    const initialState = await fetchUserState(latestStateCID, userState.profile.name);
                    // --- End Fix ---
                    console.log("[useAppState useEffect] Initial state fetched:", initialState);
                    setUserState(initialState); // Set the full initial state
                    console.log("[useAppState useEffect] Processing initial feed...");
                    await processMainFeed(initialState); // Process this specific state
                } catch (error) {
                    console.error("[useAppState useEffect] Failed to fetch initial state:", error);
                    toast.error("Failed to load initial feed state.");
                    // Optionally process an empty state to clear loading indicators
                    if (userState?.profile) { // Check if profile exists before creating empty state
                        processMainFeed({ // Assuming createEmptyUserState is available or reimplemented
                           profile: userState.profile, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null
                        });
                    }
                }
            };
            loadInitialState();
        }
    }, [isLoggedIn, myIpnsKey, latestStateCID, processMainFeed, setUserState, userState?.profile]); // Added latestStateCID, setUserState, userState.profile
    // --- End Fix ---

	// Actions hook depends on the *final* assembled `refreshFeed`
	const {
		isProcessing, addPost, likePost, dislikePost, followUser, unfollowUser, updateProfile,
	} = useAppActions({
		userState, setUserState, myIpnsKey, setAllPostsMap, setLatestStateCID, setUserProfilesMap, refreshFeed,
	});

	// --- Memoized Derived State ---
    const combinedUserProfilesMap = useMemo(() => new Map<string, UserProfile>([
        ...userProfilesMap, ...exploreUserProfilesMap
    ]), [userProfilesMap, exploreUserProfilesMap]);

	// --- Final Return Object ---
	return {
		isLoggedIn, userState, myIpnsKey, latestStateCID,
		isLoadingFeed,
		isProcessing, isCoolingDown, countdown,
		loginWithFilebase, loginWithKubo, logout,
		addPost,
		likePost, dislikePost, followUser, unfollowUser,
		refreshFeed, // Manual refresh function
		isLoadingExplore, loadMoreExplore, refreshExploreFeed,
		updateProfile, ensurePostsAreFetched,
		unresolvedFollows, allPostsMap, userProfilesMap,
		exploreAllPostsMap, exploreUserProfilesMap, combinedUserProfilesMap,
		otherUsers,
	};
};

// --- Context Consumer Hook ---
export const useAppState = (): UseAppStateReturn => {
	const context = useContext(AppStateContext);
	if (!context) throw new Error('useAppState must be used within an AppStateProvider');
	return context;
};