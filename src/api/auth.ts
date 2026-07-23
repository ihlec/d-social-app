import toast from 'react-hot-toast';
import { Session, UserState } from '../types';
import { saveSessionCookie, getDynamicSessionCookieName, logoutSession, setSessionMemoryPassword } from './session';
import { resolveIpns } from './resolution';
import { fetchUserStateChunk, createEmptyUserState, fetchUserState } from './content';
import { getLatestLocalCid } from '../lib/utils';
import { CURRENT_USER_LABEL_KEY } from '../constants';
import { uploadJson } from './contentUpload';
import {
    startHelia,
    ensureIdentityKey,
    publishIpns,
} from './heliaNode';

export class UserStateNotFoundError extends Error {
    public readonly identifier: string;
    constructor(message: string, identifier: string) {
        super(message);
        this.name = 'UserStateNotFoundError';
        this.identifier = identifier;
    }
}

/**
 * Login with browser Helia identity.
 * @param keyName - local keychain label / display name
 * @param passphrase - optional custom keychain password
 * @param forceInitialize - create empty profile if none found
 */
export async function loginWithHelia(
    keyName: string,
    passphrase?: string,
    forceInitialize: boolean = false
): Promise<{ session: Session; state: UserState; cid: string }> {
    const trimmed = keyName.trim();
    if (!trimmed) throw new Error('Identity name is required');

    setSessionMemoryPassword(passphrase);
    const requiresPassword = !!(passphrase && passphrase.length > 0);

    // Reuse warm node when password matches; only restart on keychain password change.
    await startHelia(passphrase);

    const { ipnsName } = await ensureIdentityKey(trimmed);

    let initialCid = '';
    let initialState: UserState;

    const localCid = getLatestLocalCid(trimmed);
    let networkCid = '';
    try {
        networkCid = await resolveIpns(ipnsName);
    } catch { /* ignore */ }

    if (localCid || networkCid) {
        try {
            if (localCid && networkCid && localCid !== networkCid) {
                const [remoteState, localState] = await Promise.all([
                    fetchUserStateChunk(networkCid).catch(() => null),
                    fetchUserStateChunk(localCid).catch(() => null),
                ]);
                const remoteTime = remoteState?.updatedAt || 0;
                const localTime = localState?.updatedAt || 0;
                if (localTime > remoteTime && localState) {
                    initialCid = localCid;
                    initialState = localState as UserState;
                } else {
                    initialCid = networkCid || localCid;
                    initialState = (remoteState as UserState) || await fetchUserState(initialCid, trimmed);
                }
            } else {
                initialCid = networkCid || localCid!;
                initialState = await fetchUserState(initialCid, trimmed);
            }
        } catch (e) {
            if (forceInitialize) {
                initialState = createEmptyUserState({ name: trimmed });
                initialCid = await uploadJson(initialState);
                await publishIpns(trimmed, initialCid);
                toast.success(`Created new profile: ${trimmed}`);
            } else {
                throw new UserStateNotFoundError(`Profile not found for ${trimmed}`, trimmed);
            }
        }
    } else {
        // New identity — create empty state + publish
        try {
            initialState = createEmptyUserState({ name: trimmed });
            initialCid = await uploadJson(initialState);
            await publishIpns(trimmed, initialCid);
            toast.success(`Created new profile: ${trimmed}`);
        } catch (e) {
            console.error('[loginWithHelia] create failed', e);
            throw new Error(`Failed to create profile "${trimmed}"`);
        }
    }

    // Ensure IPNS points at latest if we only had local
    if (initialCid && initialCid !== networkCid) {
        publishIpns(trimmed, initialCid).catch(e => console.warn('[loginWithHelia] background publish', e));
    }

    const session: Session = {
        sessionType: 'helia',
        ipnsKeyName: trimmed,
        resolvedIpnsKey: ipnsName,
        requiresPassword,
    };

    sessionStorage.setItem(CURRENT_USER_LABEL_KEY, trimmed);
    const cookieName = getDynamicSessionCookieName(trimmed);
    if (cookieName) saveSessionCookie(cookieName, session);

    return { session, state: initialState!, cid: initialCid };
}

export { logoutSession };
