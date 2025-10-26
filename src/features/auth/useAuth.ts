// fileName: src/hooks/useAuth.ts
// src/hooks/useAppAuth.ts
import { useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { UserState } from '../../types'; // Added Session import
import {
    getSession,
    // --- REMOVED: loginToFilebase ---
    // loginToFilebase,
    loginToKubo,
    logoutSession,
    createEmptyUserState,
    resolveIpns,
    fetchUserState,
    UserStateNotFoundError
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
    processMainFeed: (state: UserState) => Promise<void>;
    openInitializeDialog: (onInitialize: () => void, onRetry: () => void) => void;
    closeInitializeDialog: () => void;
}

export interface UseAppAuthReturn {
    // --- REMOVED: loginWithFilebase ---
    // loginWithFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
	loginWithKubo: (apiUrl: string, keyName: string) => Promise<void>;
	logout: () => void;
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
    processMainFeed,
    openInitializeDialog,
    closeInitializeDialog
}: UseAppAuthArgs): UseAppAuthReturn => {

    const refreshAuthState = useCallback(async (): Promise<UserState | null> => {
        const session = getSession();
        const ipnsKey = session.resolvedIpnsKey;
        // --- MODIFIED: Simplified identifier ---
        const identifierToResolve = ipnsKey; 
        // const identifierToResolve = session.sessionType === 'filebase' ? session.ipnsNameLabel : ipnsKey;

        if (!ipnsKey || !identifierToResolve) {
            console.warn("[refreshAuthState] No IPNS key/identifier found in session.");
            setIsLoggedIn(false); // Can't be logged in without key
            return null;
        }

        // Check cooldown (only relevant if currentUserState exists)
        const timeSinceLastAction = Date.now() - (currentUserState?.updatedAt || 0);
        if (currentUserState?.updatedAt && timeSinceLastAction < POST_COOLDOWN_MS) {
            console.log(`[refreshAuthState] Skipping network fetch due to active cooldown (${Math.round((POST_COOLDOWN_MS - timeSinceLastAction)/1000)}s remaining).`);
            return currentUserState; // Return current state
        }

        let headCid: string | null = null;
        let state: UserState | null = null;
        try {
            console.log("[refreshAuthState] Attempting to resolve IPNS/Label:", identifierToResolve);
            headCid = await resolveIpns(identifierToResolve);
            console.log(`[refreshAuthState] Resolved to CID: ${headCid}`);

            const profileNameHint = currentUserState?.profile?.name || sessionStorage.getItem("currentUserLabel") || "";
            state = await fetchUserState(headCid, profileNameHint);
            console.log("[refreshAuthState] Fetched aggregated state:", state);

            if (!state) throw new Error("Fetched state is null");

            setUserState(state);
            setLatestStateCID(headCid);
            setMyIpnsKey(ipnsKey); // Ensure IPNS key is set
            setIsLoggedIn(true); // Set logged in ON SUCCESS

            const userName = state.profile.name || sessionStorage.getItem("currentUserLabel") || "";
            saveOptimisticCookie(ipnsKey, { cid: headCid, name: userName, updatedAt: state.updatedAt });

            return state;

        } catch (error) {
            console.error("[refreshAuthState] Error fetching own state:", error);
            toast.error("Failed to refresh user state.");
            setIsLoggedIn(false);
            setUserState(prev => prev ? createEmptyUserState(prev.profile) : null); // Keep profile if exists
            setLatestStateCID('');
            return null;
        }
    }, [currentUserState, setUserState, setLatestStateCID, setMyIpnsKey, setIsLoggedIn]);

	// Session rehydration on mount
	useEffect(() => {
        // --- MODIFIED: Simplified session check ---
        const session = getSession(); 
        if (session.sessionType === 'kubo' && session.resolvedIpnsKey) {
            console.log("[useAppAuth useEffect] Session found. Attempting initial state fetch via refreshAuthState.");
            refreshAuthState().then(initialState => {
                if (initialState) {
                    console.log("[useAppAuth useEffect] Initial state fetched successfully. Processing feed.");
                    processMainFeed(initialState); 
                } else {
                    console.warn("[useAppAuth useEffect] Initial state fetch failed.");
                }
            });
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

	// --- REMOVED: loginWithFilebase function ---

	const loginWithKubo = useCallback(async (apiUrl: string, keyName: string) => {
        if (!apiUrl || !keyName) { toast.error("API URL/Key Name required."); return; }
		resetAllState();
		setIsLoggedIn(null); // Set loading state

        const attemptLogin = async (forceInitialize: boolean = false) => {
            toast.loading("Logging in...", { id: "login-toast" }); // Show loading on each attempt
            try {
                const { session, state, cid } = await loginToKubo(apiUrl, keyName, forceInitialize);
                
                sessionStorage.setItem("currentUserLabel", keyName);
                setMyIpnsKey(session.resolvedIpnsKey!);
                setUserState(state);
                setLatestStateCID(cid);
                setIsLoggedIn(true);
                saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: keyName, updatedAt: state.updatedAt });
                
                closeInitializeDialog(); // Close dialog on success
                toast.dismiss("login-toast");
                toast.success("Welcome!");
                
                await processMainFeed(state); // Process feed *after* success toast
            } catch (error) {
                toast.dismiss("login-toast"); // Dismiss loading
                if (error instanceof UserStateNotFoundError) {
                    console.warn("[loginWithKubo] UserStateNotFoundError caught.");
                    const onInitialize = () => {
                        console.log("[loginWithKubo] User chose to initialize.");
                        attemptLogin(true); // Retry, force initialization
                    };
                    const onRetry = () => {
                        console.log("[loginWithKubo] User chose to retry.");
                        attemptLogin(false); // Retry, don't force
                    };
                    openInitializeDialog(onInitialize, onRetry);
                } else {
                    // Standard error
                    setIsLoggedIn(false);
                    closeInitializeDialog();
                    toast.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        };

        await attemptLogin(false);

	}, [resetAllState, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn, processMainFeed, openInitializeDialog, closeInitializeDialog]);


	// --- MODIFIED: Updated return object ---
	return { loginWithKubo, logout };
};
