// src/hooks/useAppAuth.ts
import { useCallback, useEffect } from 'react'; // Removed useState
import toast from 'react-hot-toast';
import { UserState, UserProfile } from '../../types';
import {
    getSession,
    loginToFilebase,
    loginToKubo,
    logoutSession,
    createEmptyUserState,
    resolveIpns,
    fetchUserState
} from '../../api/ipfsIpns';
import { loadOptimisticCookie, saveOptimisticCookie } from '../../state/stateActions'; // Removed EXPECTED_CID_KEY for now

const POST_COOLDOWN_MS = 300 * 1000;

interface UseAppAuthArgs {
	setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
	setMyIpnsKey: React.Dispatch<React.SetStateAction<string>>;
	setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
    // --- FIX: Allow null type ---
	setIsLoggedIn: React.Dispatch<React.SetStateAction<boolean | null>>;
    // --- End Fix ---
	resetAllState: () => void;
    currentUserState: UserState | null;
}

export interface UseAppAuthReturn {
    loginWithFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
	loginWithKubo: (apiUrl: string, keyName: string) => Promise<void>;
	logout: () => void;
    refreshAuthState: () => Promise<UserState | null>;
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
    currentUserState
}: UseAppAuthArgs): UseAppAuthReturn => {

	// Session rehydration on mount
	useEffect(() => {
        // --- FIX: Use sessionStorage ---
        const currentUserLabel = sessionStorage.getItem("currentUserLabel") || "";
        // --- End Fix ---
		const session = getSession(); // getSession() now also reads from sessionStorage
		if (session.sessionType && currentUserLabel && session.resolvedIpnsKey) {
			const ipnsKey = session.resolvedIpnsKey;
			const optimisticStateData = loadOptimisticCookie(ipnsKey);
			const profileName = session.sessionType === 'filebase' ? session.ipnsNameLabel || currentUserLabel : session.ipnsKeyName || currentUserLabel;
			const basicProfile: UserProfile = { name: profileName };
			if (optimisticStateData && optimisticStateData.name === profileName) {
                console.log("[useAppAuth useEffect] Hydrating state from optimistic cookie:", optimisticStateData);
				setUserState({ ...createEmptyUserState(basicProfile), updatedAt: optimisticStateData.updatedAt });
				setLatestStateCID(optimisticStateData.cid); // <-- Set CID from cookie
			} else {
                console.log("[useAppAuth useEffect] No valid optimistic cookie found, setting default empty state.");
				setUserState(createEmptyUserState(basicProfile));
				setLatestStateCID('');
			}
			setMyIpnsKey(ipnsKey);
			setIsLoggedIn(true);
		} else {
            console.log("[useAppAuth useEffect] No session found.");
            // --- FIX: This is critical. Set to false to stop loading. ---
            setIsLoggedIn(false); 
            // --- End Fix ---
            setMyIpnsKey(''); setUserState(null); setLatestStateCID('');
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // Keep dependencies minimal for mount-only effect

	const logout = useCallback(() => { // ...
		logoutSession(); resetAllState();
	}, [resetAllState]);

	const loginWithFilebase = useCallback(async (nameLabel: string, bucketCredential?: string) => { // ...
        if (!nameLabel || !bucketCredential) { toast.error("Credentials required."); return; }
        // --- FIX: Call resetAllState directly instead of logout() ---
		resetAllState();
        // --- End Fix ---
		await toast.promise((async () => {
			const { session, state, cid } = await loginToFilebase(nameLabel, bucketCredential);
            // --- FIX: Use sessionStorage ---
			sessionStorage.setItem("currentUserLabel", nameLabel);
            // --- End Fix ---
			setMyIpnsKey(session.resolvedIpnsKey!);
			setUserState(state); setLatestStateCID(cid); setIsLoggedIn(true);
			saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: nameLabel, updatedAt: state.updatedAt });
		})(), { loading: "Logging in...", success: "Welcome!", error: (e) => `Login failed: ${e instanceof Error ? e.message : String(e)}` });
	}, [resetAllState, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn]);

	const loginWithKubo = useCallback(async (apiUrl: string, keyName: string) => { // ...
        if (!apiUrl || !keyName) { toast.error("API URL/Key Name required."); return; }
        // --- FIX: Call resetAllState directly instead of logout() ---
		resetAllState();
        // --- End Fix ---
		await toast.promise((async () => {
			const { session, state, cid } = await loginToKubo(apiUrl, keyName);
            // --- FIX: Use sessionStorage ---
			sessionStorage.setItem("currentUserLabel", keyName);
            // --- End Fix ---
			setMyIpnsKey(session.resolvedIpnsKey!);
			setUserState(state); setLatestStateCID(cid); setIsLoggedIn(true);
			saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: keyName, updatedAt: state.updatedAt });
		})(), { loading: "Logging in...", success: "Welcome!", error: (e) => `Login failed: ${e instanceof Error ? e.message : String(e)}` });
	}, [resetAllState, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn]);

    const refreshAuthState = useCallback(async (): Promise<UserState | null> => {
        // ... (refreshAuthState logic remains the same)
        const session = getSession(); const ipnsKey = session.resolvedIpnsKey; const identifierToResolve = session.sessionType === 'filebase' ? session.ipnsNameLabel : ipnsKey;
        if (!ipnsKey || !identifierToResolve) { console.warn("[refreshAuthState] No IPNS key/identifier found in session."); return null; }
        const timeSinceLastAction = Date.now() - (currentUserState?.updatedAt || 0);
        if (currentUserState?.updatedAt && timeSinceLastAction < POST_COOLDOWN_MS) { console.log(`[refreshAuthState] Skipping network fetch due to active cooldown (${Math.round((POST_COOLDOWN_MS - timeSinceLastAction)/1000)}s remaining).`); return null; }
        let headCid: string | null = null; let state: UserState | null = null;
        try {
            headCid = await resolveIpns(identifierToResolve); console.log(`[refreshAuthState] Resolved IPNS ${identifierToResolve} to CID: ${headCid}`);
            // --- FIX: Pass profile name hint ---
            state = await fetchUserState(headCid, currentUserState?.profile?.name);
            // --- End Fix ---
            console.log("[refreshAuthState] Fetched own aggregated state:", state);
            setUserState(state); setLatestStateCID(headCid);
            // --- FIX: Use sessionStorage ---
            const userName = state.profile.name || sessionStorage.getItem("currentUserLabel") || ""; saveOptimisticCookie(ipnsKey, { cid: headCid, name: userName, updatedAt: state.updatedAt });
            // --- End Fix ---
            return state;
        } catch (error) { console.error("[refreshAuthState] Error fetching own state:", error); toast.error("Failed to refresh user state."); return null; }
    }, [currentUserState, setUserState, setLatestStateCID]);

	return { loginWithFilebase, loginWithKubo, logout, refreshAuthState };
};