// fileName: src/hooks/useAuth.ts
// src/hooks/useAppAuth.ts
import { useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
// --- REMOVED: Unused Session import ---
import { UserState } from '../../types';
import {
    getSession,
    loginToKubo,
    logoutSession,
    createEmptyUserState,
    resolveIpns,
    fetchUserState,
    UserStateNotFoundError,
    // --- ADDED: saveOptimisticCookie (explicitly import from correct location) ---
    saveOptimisticCookie
} from '../../api/ipfsIpns';
// --- REMOVED: saveOptimisticCookie import from stateActions ---


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
	loginWithKubo: (apiUrl: string, keyName: string, username?: string, password?: string) => Promise<void>;
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
        const identifierToResolve = ipnsKey;

        if (!ipnsKey || !identifierToResolve) {
            console.warn("[refreshAuthState] No IPNS key/identifier found in Kubo session.");
            setIsLoggedIn(false);
            return null;
        }

        const timeSinceLastAction = Date.now() - (currentUserState?.updatedAt || 0);
        if (currentUserState?.updatedAt && timeSinceLastAction < POST_COOLDOWN_MS) {
            console.log(`[refreshAuthState] Skipping network fetch due to active cooldown (${Math.round((POST_COOLDOWN_MS - timeSinceLastAction)/1000)}s remaining).`);
            return currentUserState;
        }

        let headCid: string | null = null;
        let state: UserState | null = null;
        try {
            console.log("[refreshAuthState] Attempting to resolve IPNS Key:", identifierToResolve);
            headCid = await resolveIpns(identifierToResolve); // resolveIpns handles auth internally if needed via session
            console.log(`[refreshAuthState] Resolved to CID: ${headCid}`);

            const profileNameHint = currentUserState?.profile?.name || session.ipnsKeyName || "";
            state = await fetchUserState(headCid, profileNameHint); // fetchUserState handles auth internally if needed via session
            console.log("[refreshAuthState] Fetched aggregated state:", state);

            if (!state) throw new Error("Fetched state is null");

            setUserState(state);
            setLatestStateCID(headCid);
            setMyIpnsKey(ipnsKey);
            setIsLoggedIn(true);

            const userName = state.profile.name || session.ipnsKeyName || "";
            // Use resolved IPNS key for cookie, name hint for value
            saveOptimisticCookie(ipnsKey, { cid: headCid, name: userName, updatedAt: state.updatedAt });

            return state;

        } catch (error) {
            console.error("[refreshAuthState] Error fetching own state:", error);
            toast.error("Failed to refresh user state.");
            setIsLoggedIn(false);
            setUserState(prev => prev ? createEmptyUserState(prev.profile) : null);
            setLatestStateCID('');
            return null;
        }
    }, [currentUserState, setUserState, setLatestStateCID, setMyIpnsKey, setIsLoggedIn]);

	useEffect(() => {
        const session = getSession();
        if (session.sessionType === 'kubo' && session.resolvedIpnsKey) {
            console.log("[useAppAuth useEffect] Kubo Session found. Attempting initial state fetch via refreshAuthState.");
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
            setIsLoggedIn(false);
            setMyIpnsKey(''); setUserState(null); setLatestStateCID('');
        }
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const logout = useCallback(() => {
		logoutSession(); resetAllState();
	}, [resetAllState]);

	const loginWithKubo = useCallback(async (apiUrl: string, keyName: string, username?: string, password?: string) => {
        if (!apiUrl || !keyName) { toast.error("API URL/Key Name required."); return; }
		resetAllState();
		setIsLoggedIn(null);

        const attemptLogin = async (forceInitialize: boolean = false) => {
            toast.loading("Logging in...", { id: "login-toast" });
            try {
                const { session, state, cid } = await loginToKubo(apiUrl, keyName, forceInitialize, username, password);

                sessionStorage.setItem("currentUserLabel", keyName);
                setMyIpnsKey(session.resolvedIpnsKey!);
                setUserState(state);
                setLatestStateCID(cid);
                setIsLoggedIn(true);
                // Use resolved IPNS key for cookie, keyName hint for value
                saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: keyName, updatedAt: state.updatedAt });

                closeInitializeDialog();
                toast.dismiss("login-toast");
                toast.success("Welcome!");

                await processMainFeed(state);
            } catch (error) {
                toast.dismiss("login-toast");
                if (error instanceof UserStateNotFoundError) {
                    console.warn("[loginWithKubo] UserStateNotFoundError caught.");
                    const onInitialize = () => {
                        console.log("[loginWithKubo] User chose to initialize.");
                        attemptLogin(true);
                    };
                    const onRetry = () => {
                        console.log("[loginWithKubo] User chose to retry.");
                        attemptLogin(false);
                    };
                    openInitializeDialog(onInitialize, onRetry);
                } else {
                    setIsLoggedIn(false);
                    closeInitializeDialog();
                    toast.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        };
        await attemptLogin(false);

	}, [resetAllState, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn, processMainFeed, openInitializeDialog, closeInitializeDialog]);


	return { loginWithKubo, logout };
};

