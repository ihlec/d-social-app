import toast from 'react-hot-toast';
import { Session, UserState, KuboAuth } from '../types';
import { saveSessionCookie, getDynamicSessionCookieName, logoutSession, setSessionMemoryPassword } from './session';
import { fetchKubo, uploadJsonToIpfs, publishToIpns } from './kuboClient';
import { resolveIpns } from './resolution';
import { fetchUserStateChunk, createEmptyUserState, fetchUserState } from './content';
import { getLatestLocalCid } from '../lib/utils';
import { KUBO_PUBLISH_TIMEOUT_MS, CURRENT_USER_LABEL_KEY } from '../constants';

export class UserStateNotFoundError extends Error {
    public readonly identifier: string; 
    constructor(message: string, identifier: string) {
        super(message);
        this.name = 'UserStateNotFoundError';
        this.identifier = identifier;
    }
}

export async function loginToKubo(apiUrl: string, keyName: string, forceInitialize: boolean = false, username?: string, password?: string): Promise<{ session: Session, state: UserState, cid: string }> {
     setSessionMemoryPassword(password);
     
     const auth: KuboAuth = { username, password };
     try {
         await fetchKubo(apiUrl, '/api/v0/id', undefined, undefined, auth);
         const keysResponse = await fetchKubo(apiUrl, '/api/v0/key/list', undefined, undefined, auth);
         let keyInfo = Array.isArray(keysResponse?.Keys) ? keysResponse.Keys.find((k: any) => k.Name === keyName) : undefined;

         let resolvedIpnsKey: string;
         let initialCid = '';
         let initialState: UserState;

         if (!keyInfo?.Id) {
            try {
                const genResponse = await fetchKubo(apiUrl, '/api/v0/key/gen', { arg: keyName, type: 'ed25519' }, undefined, auth);
                keyInfo = genResponse;
                resolvedIpnsKey = keyInfo.Id;
                initialState = createEmptyUserState({ name: keyName });
                initialCid = await uploadJsonToIpfs(apiUrl, initialState, auth);
                await publishToIpns(apiUrl, initialCid, keyName, auth, KUBO_PUBLISH_TIMEOUT_MS);
                toast.success(`Created new profile: ${keyName}`);
            } catch (genError) { throw new Error(`Failed to create profile "${keyName}"`); }
         } else {
             resolvedIpnsKey = keyInfo.Id;
             try {
                 const remoteCidPromise = resolveIpns(resolvedIpnsKey);
                 const localCid = getLatestLocalCid(keyName);
                 
                 initialCid = await remoteCidPromise; 

                 if (localCid && localCid !== initialCid) {
                     console.log(`[Login] Found optimistic CID ${localCid} (Remote: ${initialCid || 'None'}). Verifying timestamps...`);
                     try {
                         const [remoteState, localState] = await Promise.all([
                             initialCid ? fetchUserStateChunk(initialCid).catch(() => null) : null,
                             fetchUserStateChunk(localCid).catch(() => null)
                         ]);

                         const remoteTime = remoteState?.updatedAt || 0;
                         const localTime = localState?.updatedAt || 0;

                         if (localTime > remoteTime) {
                             console.log(`[Login] 🟢 Using newer local state (${localTime} > ${remoteTime})`);
                             initialCid = localCid;
                             initialState = localState as UserState;
                         } else {
                             console.log(`[Login] 🟡 Remote state is newer/equal.`);
                             initialState = remoteState ? remoteState as UserState : await fetchUserState(initialCid, keyName);
                         }
                     } catch (e) {
                         initialState = await fetchUserState(initialCid, keyName);
                     }
                 } else {
                     initialState = await fetchUserState(initialCid, keyName); 
                 }

             } catch (e) {
                 if (forceInitialize) {
                     initialState = createEmptyUserState({ name: keyName });
                     initialCid = await uploadJsonToIpfs(apiUrl, initialState, auth);
                     await publishToIpns(apiUrl, initialCid, keyName, auth, KUBO_PUBLISH_TIMEOUT_MS);
                 } else { throw new UserStateNotFoundError(`Profile not found for ${keyName}`, keyName); }
             }
         }
         const requiresPassword = !!password && password.length > 0;
         const session: Session = { 
             sessionType: 'kubo', 
             rpcApiUrl: apiUrl, 
             ipnsKeyName: keyName, 
             resolvedIpnsKey, 
             kuboUsername: username, 
             kuboPassword: password,
             requiresPassword 
         };
         const cookieName = getDynamicSessionCookieName(keyName);
         if (cookieName) saveSessionCookie(cookieName, session);
         sessionStorage.setItem(CURRENT_USER_LABEL_KEY, keyName);
         return { session, state: initialState, cid: initialCid };
     } catch (error) { logoutSession(); throw error; }
}
