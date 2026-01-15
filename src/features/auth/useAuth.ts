// fileName: src/features/auth/useAuth.ts
import { useState, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { UserState } from '../../types';
import {
    getSession,
    loginToKubo,
    logoutSession,
    resolveIpns,
    fetchUserState,
    UserStateNotFoundError,
    fetchKubo,
    loadOptimisticCookie
} from '../../api/ipfsIpns';

export interface UseAppAuthReturn {
    isLoggedIn: boolean | null;
    myIpnsKey: string;
    myPeerId: string;
    setMyIpnsKey: React.Dispatch<React.SetStateAction<string>>;
    userState: UserState | null;
    setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
    latestStateCID: string;
    setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
    loginWithKubo: (apiUrl: string, keyName: string, username?: string, password?: string) => Promise<{ success: boolean; state?: UserState; key?: string }>;
    logout: () => void;
    resetAllState: () => void;
    isInitializeDialogOpen: boolean;
    onInitializeUser: () => void;
    onRetryLogin: () => void;
    openInitializeDialog: (onInit: () => void, onRetry: () => void) => void;
    closeInitializeDialog: () => void;
    isSessionLocked: boolean;
    unlockSession: (password: string) => Promise<boolean>;
}

export const useAppAuth = (): UseAppAuthReturn => {
    const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
    const [isSessionLocked, setIsSessionLocked] = useState<boolean>(false);
    const [myIpnsKey, setMyIpnsKey] = useState<string>('');
    const [myPeerId, setMyPeerId] = useState<string>(''); 
    const [userState, setUserState] = useState<UserState | null>(null);
    const [latestStateCID, setLatestStateCID] = useState<string>('');
    
    const [isInitializeDialogOpen, setInitializeDialogOpen] = useState(false);
    const [dialogHandlers, setDialogHandlers] = useState<{ onInit: () => void; onRetry: () => void } | null>(null);

    const openInitializeDialog = useCallback((onInit: () => void, onRetry: () => void) => {
        setDialogHandlers({ onInit, onRetry });
        setInitializeDialogOpen(true);
    }, []);

    const closeInitializeDialog = useCallback(() => {
        setInitializeDialogOpen(false);
        setDialogHandlers(null);
    }, []);

    const resetAllState = useCallback(() => {
        setIsLoggedIn(false);
        setMyIpnsKey('');
        setMyPeerId(''); 
        setUserState(null);
        setLatestStateCID('');
    }, []);

    useEffect(() => {
        const checkSession = async () => {
            const session = getSession();
            
            // Determine Lock Status
            if (session.sessionType === 'kubo' && session.ipnsKeyName) {
                 // Locked ONLY if password was required but is missing from memory
                 if (session.requiresPassword && !session.kuboPassword) {
                     setIsSessionLocked(true);
                 } else {
                     setIsSessionLocked(false);
                 }
            }

            if (session.sessionType === 'kubo' && session.ipnsKeyName && session.rpcApiUrl) {
                try {
                    // 1. Verify Connection & GET Peer ID
                    // FIX: Capture the response to get the ID
                    const idResponse = await fetchKubo(session.rpcApiUrl, '/api/v0/id', undefined, undefined, { username: session.kuboUsername, password: session.kuboPassword });
                    
                    setMyIpnsKey(session.ipnsKeyName);

                    // FIX: Use the ID from the Node if cookie is missing it
                    if (session.resolvedIpnsKey) {
                        setMyPeerId(session.resolvedIpnsKey);
                    } else if (idResponse && idResponse.ID) {
                        console.log("[useAuth] Recovered Peer ID from node:", idResponse.ID);
                        setMyPeerId(idResponse.ID);
                    }

                    // 2. Load User State with Fallback Strategy
                    let cidToFetch = '';
                    let source = 'network';

                    // A. Try Optimistic Cookie First
                    const optimistic = loadOptimisticCookie(session.ipnsKeyName);
                    if (optimistic && optimistic.cid) {
                        console.log(`[useAuth] Found optimistic cookie: ${optimistic.cid}`);
                        cidToFetch = optimistic.cid;
                        source = 'cookie';
                    }

                    // B. If no cookie, resolve IPNS
                    if (!cidToFetch) {
                        try {
                            cidToFetch = await resolveIpns(session.ipnsKeyName);
                        } catch (e) {
                            console.warn("Could not resolve IPNS during session check:", e);
                        }
                    }

                    // 3. Fetch the State Data
                    if (cidToFetch) {
                        try {
                            const state = await fetchUserState(cidToFetch, session.ipnsKeyName);
                            setUserState(state);
                            setLatestStateCID(cidToFetch);
                            setIsLoggedIn(true);
                        } catch (e) {
                            console.warn(`Failed to load state from ${source} (${cidToFetch}). Trying fallback...`, e);
                            
                            // C. Fallback
                            if (source === 'cookie') {
                                try {
                                    const networkCid = await resolveIpns(session.ipnsKeyName);
                                    const fallbackState = await fetchUserState(networkCid, session.ipnsKeyName);
                                    setUserState(fallbackState);
                                    setLatestStateCID(networkCid);
                                    setIsLoggedIn(true);
                                } catch (netErr) {
                                    console.error("Fallback IPNS load also failed:", netErr);
                                    setIsLoggedIn(true);
                                }
                            } else {
                                setIsLoggedIn(true);
                            }
                        }
                    } else {
                         setIsLoggedIn(true);
                    }

                } catch (e) {
                    console.error("Session check failed (node unreachable?):", e);
                    logoutSession();
                    setIsLoggedIn(false);
                }
            } else {
                setIsLoggedIn(false);
            }
        };
        checkSession();
    }, []);

    const loginWithKubo = useCallback(async (apiUrl: string, keyName: string, username?: string, password?: string) => {
        const attemptLogin = async (forceInit: boolean) => {
            try {
                const { session, state, cid } = await loginToKubo(apiUrl, keyName, forceInit, username, password);
                
                setUserState(state);
                setMyIpnsKey(keyName);
                if (session.resolvedIpnsKey) setMyPeerId(session.resolvedIpnsKey);
                
                setLatestStateCID(cid);
                setIsLoggedIn(true);
                setIsSessionLocked(false); // Password provided, unlocked
                closeInitializeDialog();
                toast.success(`Connected as ${keyName}`);
                return { success: true, state, key: keyName };
            } catch (error) {
                if (error instanceof UserStateNotFoundError || (error instanceof Error && error.name === 'UserStateNotFoundError')) {
                    openInitializeDialog(
                        () => attemptLogin(true), 
                        () => attemptLogin(false)
                    );
                    return { success: false };
                }
                throw error;
            }
        };
        return attemptLogin(false);
    }, [closeInitializeDialog, openInitializeDialog]);

    const logout = useCallback(() => {
        logoutSession();
        resetAllState();
        window.location.reload();
    }, [resetAllState]);

    const unlockSession = useCallback(async (password: string) => {
        const session = getSession();
        if (!session.rpcApiUrl || !session.ipnsKeyName) {
            toast.error("No active session found. Please login again.");
            return false;
        }
        try {
            await loginWithKubo(session.rpcApiUrl, session.ipnsKeyName, session.kuboUsername, password);
            return true;
        } catch (e) {
            console.error("Unlock failed", e);
            toast.error("Incorrect password.");
            return false;
        }
    }, [loginWithKubo]);

    return {
        isLoggedIn,
        isSessionLocked,
        unlockSession,
        myIpnsKey, setMyIpnsKey,
        myPeerId, 
        userState, setUserState,
        latestStateCID, setLatestStateCID,
        loginWithKubo,
        logout,
        resetAllState,
        isInitializeDialogOpen,
        onInitializeUser: dialogHandlers?.onInit || (() => {}),
        onRetryLogin: dialogHandlers?.onRetry || (() => {}),
        openInitializeDialog,
        closeInitializeDialog
    };
};