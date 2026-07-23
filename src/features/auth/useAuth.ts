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
    ensureIdentityKey,
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
            const session = getSession();

            if (session.sessionType !== 'helia' || !session.ipnsKeyName) {
                setIsLoggedIn(false);
                return;
            }

            // Passphrase sessions: stay logged-in but locked until unlock
            if (session.requiresPassword && !getSessionMemoryPassword()) {
                setIsSessionLocked(true);
                setMyIpnsKey(session.ipnsKeyName);
                if (session.resolvedIpnsKey) setMyPeerId(session.resolvedIpnsKey);
                setIsLoggedIn(true);
                return;
            }

            try {
                await startHelia(getSessionMemoryPassword());
                setMyIpnsKey(session.ipnsKeyName);

                let peerId = session.resolvedIpnsKey || '';
                try {
                    const { ipnsName } = await ensureIdentityKey(session.ipnsKeyName);
                    peerId = ipnsName || peerId;
                } catch (e) {
                    console.warn('[Auth] ensureIdentityKey on restore failed', e);
                }
                if (peerId) setMyPeerId(peerId);

                // Refresh persisted session with resolved IPNS (cookie/localStorage)
                persistSession({
                    ...session,
                    resolvedIpnsKey: peerId || session.resolvedIpnsKey,
                });

                setIsSessionLocked(false);

                // Prefer local tip — public IPNS often missing for browser publishes
                let cidToFetch =
                    loadOptimisticCookie(session.ipnsKeyName)?.cid
                    || getLatestLocalCid(session.ipnsKeyName)
                    || getLatestLocalCid(peerId)
                    || '';

                if (!cidToFetch) {
                    const name = peerId || session.resolvedIpnsKey || session.ipnsKeyName;
                    try {
                        cidToFetch = await resolveIpns(name);
                    } catch (e) {
                        console.warn('[Auth] IPNS resolve during restore failed:', e);
                    }
                }

                if (cidToFetch) {
                    try {
                        const state = await fetchUserState(cidToFetch, session.ipnsKeyName);
                        setUserState(state);
                        setLatestStateCID(cidToFetch);
                    } catch (e) {
                        console.warn('[Auth] State load on restore failed — staying logged in', e);
                    }
                }

                setIsLoggedIn(true);
            } catch (e) {
                // Intentionally stay logged in: localStorage session + tip often still
                // work for read paths when Helia boot is flaky. Unlock covers writes.
                console.error('[Auth] Session restore failed (keeping persisted login):', e);
                setMyIpnsKey(session.ipnsKeyName);
                if (session.resolvedIpnsKey) setMyPeerId(session.resolvedIpnsKey);
                if (session.requiresPassword) {
                    setIsSessionLocked(true);
                }
                setIsLoggedIn(true);
                toast.error('Could not fully restore session. Try unlocking or reloading.');
            }
        };
        void checkSession();
    }, []);

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
