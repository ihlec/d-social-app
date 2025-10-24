// src/hooks/useAppAuth.ts
import { useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { UserState } from '../../types'; // Added Session import
import {
    getSession,
    loginToFilebase,
    loginToKubo,
    logoutSession,
    createEmptyUserState,
    resolveIpns,
    fetchUserState
} from '../../api/ipfsIpns';
import { saveOptimisticCookie } from '../../state/stateActions';

const POST_COOLDOWN_MS = 300 * 1000;

interface UseAppAuthArgs {
	setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
	setMyIpnsKey: React.Dispatch<React.SetStateAction<string>>;
	setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
	setIsLoggedIn: React.Dispatch<React.SetStateAction<boolean | null>>;
	resetAllState: () => void;
    currentUserState: UserState | null;
    // --- FIX: Add processMainFeed ---
    processMainFeed: (state: UserState) => Promise<void>;
    // --- END FIX ---
}

export interface UseAppAuthReturn {
    loginWithFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
	loginWithKubo: (apiUrl: string, keyName: string) => Promise<void>;
	logout: () => void;
    // --- FIX: Removed refreshAuthState from return ---
    // refreshAuthState: () => Promise<UserState | null>;
    // --- END FIX ---
}

/**
 * Manages authentication state, session loading, login, and logout.
 */
export const useAppAuth = ({
	setUserState,
	setMyIpnsKey,
	setLatestStateCID,
	setIsLoggedIn,
	resetAllState,
    currentUserState,
    // --- FIX: Destructure processMainFeed ---
    processMainFeed
    // --- END FIX ---
}: UseAppAuthArgs): UseAppAuthReturn => {

    // --- FIX: Make refreshAuthState internal ---
    const refreshAuthState = useCallback(async (): Promise<UserState | null> => {
        const session = getSession();
        const ipnsKey = session.resolvedIpnsKey;
        const identifierToResolve = session.sessionType === 'filebase' ? session.ipnsNameLabel : ipnsKey;

        if (!ipnsKey || !identifierToResolve) {
            console.warn("[refreshAuthState] No IPNS key/identifier found in session.");
            setIsLoggedIn(false); // Can't be logged in without key
            return null;
        }

        // Check cooldown (only relevant if currentUserState exists)
        const timeSinceLastAction = Date.now() - (currentUserState?.updatedAt || 0);
        if (currentUserState?.updatedAt && timeSinceLastAction < POST_COOLDOWN_MS) {
            console.log(`[refreshAuthState] Skipping network fetch due to active cooldown (${Math.round((POST_COOLDOWN_MS - timeSinceLastAction)/1000)}s remaining).`);
            // If skipping due to cooldown, assume we are still logged in with current state
            // No need to set isLoggedIn here, it should already be true
            return currentUserState; // Return current state
        }

        let headCid: string | null = null;
        let state: UserState | null = null;
        try {
            console.log("[refreshAuthState] Attempting to resolve IPNS/Label:", identifierToResolve);
            headCid = await resolveIpns(identifierToResolve);
            console.log(`[refreshAuthState] Resolved to CID: ${headCid}`);

            // Pass profile name hint (use current state's profile OR label from session storage)
            const profileNameHint = currentUserState?.profile?.name || sessionStorage.getItem("currentUserLabel") || "";
            state = await fetchUserState(headCid, profileNameHint);
            console.log("[refreshAuthState] Fetched aggregated state:", state);

            if (!state) throw new Error("Fetched state is null");

            // --- SUCCESS ---
            setUserState(state);
            setLatestStateCID(headCid);
            setMyIpnsKey(ipnsKey); // Ensure IPNS key is set
            setIsLoggedIn(true); // Set logged in ON SUCCESS

            // Save optimistic cookie
            const userName = state.profile.name || sessionStorage.getItem("currentUserLabel") || "";
            saveOptimisticCookie(ipnsKey, { cid: headCid, name: userName, updatedAt: state.updatedAt });

            return state;

        } catch (error) {
            console.error("[refreshAuthState] Error fetching own state:", error);
            toast.error("Failed to refresh user state.");
            // --- FAILURE ---
            // Don't logout completely, maybe just revert to optimistic state if possible?
            // For now, set loggedIn to false to indicate failure.
            setIsLoggedIn(false);
            // Optionally clear sensitive state but keep basic profile?
            setUserState(prev => prev ? createEmptyUserState(prev.profile) : null); // Keep profile if exists
            setLatestStateCID('');
            // Keep MyIpnsKey? Maybe not if refresh failed badly.
            // setMyIpnsKey('');

            return null;
        }
    }, [currentUserState, setUserState, setLatestStateCID, setMyIpnsKey, setIsLoggedIn]);
    // --- END FIX ---

	// Session rehydration on mount
	useEffect(() => {
        const session = getSession(); // getSession() now also reads from sessionStorage
        if (session.sessionType && session.resolvedIpnsKey) {
            console.log("[useAppAuth useEffect] Session found. Attempting initial state fetch via refreshAuthState.");
            // --- FIX: Call refreshAuthState to fetch full state and trigger feed processing ---
            refreshAuthState().then(initialState => {
                if (initialState) {
                    console.log("[useAppAuth useEffect] Initial state fetched successfully. Processing feed.");
                    processMainFeed(initialState); // Process feed AFTER state is confirmed
                } else {
                    console.warn("[useAppAuth useEffect] Initial state fetch failed.");
                    // isLoggedIn should be false already from refreshAuthState failure
                }
            });
            // --- END FIX ---
        } else {
            console.log("[useAppAuth useEffect] No session found.");
            setIsLoggedIn(false); // Definitely not logged in
            setMyIpnsKey(''); setUserState(null); setLatestStateCID('');
        }
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // Keep dependencies minimal for mount-only effect

	const logout = useCallback(() => {
		logoutSession(); resetAllState();
	}, [resetAllState]);

	const loginWithFilebase = useCallback(async (nameLabel: string, bucketCredential?: string) => {
        if (!nameLabel || !bucketCredential) { toast.error("Credentials required."); return; }
		resetAllState();
		setIsLoggedIn(null); // Set loading state
		await toast.promise((async () => {
			const { session, state, cid } = await loginToFilebase(nameLabel, bucketCredential);
			sessionStorage.setItem("currentUserLabel", nameLabel);
			setMyIpnsKey(session.resolvedIpnsKey!);
			setUserState(state);
            setLatestStateCID(cid);
            setIsLoggedIn(true); // Set logged in AFTER state is set
			saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: nameLabel, updatedAt: state.updatedAt });
            // --- FIX: Process feed after successful login ---
            await processMainFeed(state);
            // --- END FIX ---
		})(), {
            loading: "Logging in...",
            success: "Welcome!",
            error: (e) => {
                setIsLoggedIn(false); // Ensure loggedIn is false on error
                return `Login failed: ${e instanceof Error ? e.message : String(e)}`;
            }
        });
	}, [resetAllState, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn, processMainFeed]);

	const loginWithKubo = useCallback(async (apiUrl: string, keyName: string) => {
        if (!apiUrl || !keyName) { toast.error("API URL/Key Name required."); return; }
		resetAllState();
		setIsLoggedIn(null); // Set loading state
		await toast.promise((async () => {
			const { session, state, cid } = await loginToKubo(apiUrl, keyName);
			sessionStorage.setItem("currentUserLabel", keyName);
			setMyIpnsKey(session.resolvedIpnsKey!);
			setUserState(state);
            setLatestStateCID(cid);
            setIsLoggedIn(true); // Set logged in AFTER state is set
			saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: keyName, updatedAt: state.updatedAt });
            // --- FIX: Process feed after successful login ---
            await processMainFeed(state);
            // --- END FIX ---
		})(), {
            loading: "Logging in...",
            success: "Welcome!",
            error: (e) => {
                setIsLoggedIn(false); // Ensure loggedIn is false on error
                return `Login failed: ${e instanceof Error ? e.message : String(e)}`;
            }
        });
	}, [resetAllState, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn, processMainFeed]);


	// --- FIX: Removed refreshAuthState from return ---
	return { loginWithFilebase, loginWithKubo, logout };
    // --- END FIX ---
};