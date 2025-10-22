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
	setIsLoggedIn: React.Dispatch<React.SetStateAction<boolean>>;
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
        // ... (hydration logic remains the same)
		const session = getSession();
		const currentUserLabel = localStorage.getItem("currentUserLabel") || "";
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
            setIsLoggedIn(false); setMyIpnsKey(''); setUserState(null); setLatestStateCID('');
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // Keep dependencies minimal for mount-only effect

	const logout = useCallback(() => { // ...
		logoutSession(); resetAllState();
	}, [resetAllState]);

	const loginWithFilebase = useCallback(async (nameLabel: string, bucketCredential?: string) => { // ...
        if (!nameLabel || !bucketCredential) { toast.error("Credentials required."); return; }
		logout();
		await toast.promise((async () => {
			const { session, state, cid } = await loginToFilebase(nameLabel, bucketCredential);
			localStorage.setItem("currentUserLabel", nameLabel);
			setMyIpnsKey(session.resolvedIpnsKey!);
			setUserState(state); setLatestStateCID(cid); setIsLoggedIn(true);
			saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: nameLabel, updatedAt: state.updatedAt });
		})(), { loading: "Logging in...", success: "Welcome!", error: (e) => `Login failed: ${e instanceof Error ? e.message : String(e)}` });
	}, [logout, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn]);

	const loginWithKubo = useCallback(async (apiUrl: string, keyName: string) => { // ...
        if (!apiUrl || !keyName) { toast.error("API URL/Key Name required."); return; }
		logout();
		await toast.promise((async () => {
			const { session, state, cid } = await loginToKubo(apiUrl, keyName);
			localStorage.setItem("currentUserLabel", keyName);
			setMyIpnsKey(session.resolvedIpnsKey!);
			setUserState(state); setLatestStateCID(cid); setIsLoggedIn(true);
			saveOptimisticCookie(session.resolvedIpnsKey!, { cid, name: keyName, updatedAt: state.updatedAt });
		})(), { loading: "Logging in...", success: "Welcome!", error: (e) => `Login failed: ${e instanceof Error ? e.message : String(e)}` });
	}, [logout, setMyIpnsKey, setUserState, setLatestStateCID, setIsLoggedIn]);

    const refreshAuthState = useCallback(async (): Promise<UserState | null> => {
        // ... (refreshAuthState logic remains the same)
        const session = getSession(); const ipnsKey = session.resolvedIpnsKey; const identifierToResolve = session.sessionType === 'filebase' ? session.ipnsNameLabel : ipnsKey;
        if (!ipnsKey || !identifierToResolve) { console.warn("[refreshAuthState] No IPNS key/identifier found in session."); return null; }
        const timeSinceLastAction = Date.now() - (currentUserState?.updatedAt || 0);
        if (currentUserState?.updatedAt && timeSinceLastAction < POST_COOLDOWN_MS) { console.log(`[refreshAuthState] Skipping network fetch due to active cooldown (${Math.round((POST_COOLDOWN_MS - timeSinceLastAction)/1000)}s remaining).`); return null; }
        let headCid: string | null = null; let state: UserState | null = null;
        try {
            headCid = await resolveIpns(identifierToResolve); console.log(`[refreshAuthState] Resolved IPNS ${identifierToResolve} to CID: ${headCid}`);
            state = await fetchUserState(headCid); console.log("[refreshAuthState] Fetched own aggregated state:", state);
            setUserState(state); setLatestStateCID(headCid);
            const userName = state.profile.name || localStorage.getItem("currentUserLabel") || ""; saveOptimisticCookie(ipnsKey, { cid: headCid, name: userName, updatedAt: state.updatedAt });
            return state;
        } catch (error) { console.error("[refreshAuthState] Error fetching own state:", error); toast.error("Failed to refresh user state."); return null; }
    }, [currentUserState, setUserState, setLatestStateCID]);

	return { loginWithFilebase, loginWithKubo, logout, refreshAuthState };
};