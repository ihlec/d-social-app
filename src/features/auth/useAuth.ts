import { useState, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { UserState } from '../../types';
import {
    getSession,
    loginWithHelia,
    logoutSession,
    resolveIpns,
    fetchUserState,
    UserStateNotFoundError,
    loadOptimisticCookie,
    getSessionMemoryPassword,
    startHelia,
    getExistingIdentityKey,
} from '../../api/ipfsIpns';
import { persistSession } from '../../api/session';
import { getLatestLocalCid } from '../../lib/utils';

export interface UseAppAuthReturn {
    isLoggedIn: boolean | null;
    myIpnsKey: string;
    myPeerId: string;
    setMyIpnsKey: React.Dispatch<React.SetStateAction<string>>;
    userState: UserState | null;
    setUserState: React.Dispatch<React.SetStateAction<UserState | null>>;
    latestStateCID: string;
    setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
    loginWithHelia: (keyName: string, passphrase?: string) => Promise<{ success: boolean; state?: UserState; key?: string }>;
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
        setIsSessionLocked(false);
    }, []);

    useEffect(() => {
        const checkSession = async () => {
            const clearToLogin = () => {
                logoutSession();
                resetAllState();
                setIsLoggedIn(false);
            };

            const session = getSession();

            if (session.sessionType !== 'helia' || !session.ipnsKeyName) {
                setIsLoggedIn(false);
                return;
            }

            try {
                await startHelia(getSessionMemoryPassword());

                // Never auto-create on restore — missing CAS identity ⇒ Login prompt
                // (covers fresh CAS install + leftover Helia session cookies).
                const existing = await getExistingIdentityKey(session.ipnsKeyName);
                if (!existing) {
                    console.info(
                        '[Auth] No local identity for persisted session — showing Login'
                    );
                    clearToLogin();
                    return;
                }

                // Passphrase sessions: stay logged-in but locked until unlock
                if (session.requiresPassword && !getSessionMemoryPassword()) {
                    setIsSessionLocked(true);
                    setMyIpnsKey(session.ipnsKeyName);
                    setMyPeerId(existing.ipnsName);
                    setIsLoggedIn(true);
                    return;
                }

                setMyIpnsKey(session.ipnsKeyName);
                setMyPeerId(existing.ipnsName);
                setIsSessionLocked(false);

                let cidToFetch =
                    loadOptimisticCookie(session.ipnsKeyName)?.cid
                    || getLatestLocalCid(session.ipnsKeyName)
                    || getLatestLocalCid(existing.ipnsName)
                    || '';

                if (!cidToFetch) {
                    try {
                        cidToFetch = await resolveIpns(existing.ipnsName);
                    } catch (e) {
                        console.warn('[Auth] tip resolve during restore failed:', e);
                    }
                }

                if (!cidToFetch) {
                    console.info('[Auth] Persisted session has no tip — showing Login');
                    clearToLogin();
                    return;
                }

                try {
                    const state = await fetchUserState(cidToFetch, session.ipnsKeyName);
                    if (!state?.profile) {
                        console.info('[Auth] Tip has no profile — showing Login');
                        clearToLogin();
                        return;
                    }
                    setUserState(state);
                    setLatestStateCID(cidToFetch);
                } catch (e) {
                    console.warn('[Auth] State load on restore failed — showing Login', e);
                    clearToLogin();
                    return;
                }

                persistSession({
                    ...session,
                    resolvedIpnsKey: existing.ipnsName,
                });

                setIsLoggedIn(true);
            } catch (e) {
                console.error('[Auth] Session restore failed — showing Login:', e);
                clearToLogin();
            }
        };
        void checkSession();
    }, [resetAllState]);

    const loginWithHeliaFn = useCallback(async (keyName: string, passphrase?: string) => {
        const attemptLogin = async (forceInit: boolean) => {
            try {
                const { session, state, cid } = await loginWithHelia(keyName, passphrase, forceInit);
                
                setUserState(state);
                setMyIpnsKey(keyName);
                if (session.resolvedIpnsKey) setMyPeerId(session.resolvedIpnsKey);
                
                setLatestStateCID(cid);
                setIsLoggedIn(true);
                setIsSessionLocked(false);
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
        if (!session.ipnsKeyName) {
            toast.error("No active session found. Please login again.");
            return false;
        }
        try {
            await loginWithHeliaFn(session.ipnsKeyName, password);
            return true;
        } catch (e) {
            console.error("Unlock failed", e);
            toast.error("Incorrect passphrase.");
            return false;
        }
    }, [loginWithHeliaFn]);

    return {
        isLoggedIn,
        isSessionLocked,
        unlockSession,
        myIpnsKey, setMyIpnsKey,
        myPeerId, 
        userState, setUserState,
        latestStateCID, setLatestStateCID,
        loginWithHelia: loginWithHeliaFn,
        logout,
        resetAllState,
        isInitializeDialogOpen,
        onInitializeUser: dialogHandlers?.onInit || (() => {}),
        onRetryLogin: dialogHandlers?.onRetry || (() => {}),
        openInitializeDialog,
        closeInitializeDialog
    };
};
