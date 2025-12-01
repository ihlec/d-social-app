// fileName: src/lib/ipfsIpns.ts
// src/lib/ipfs.ts
import { UserState, Post, Session, Follow } from '../types';
import { getCookie, setCookie, eraseCookie } from '../lib/utils';
import toast from 'react-hot-toast';
export { saveOptimisticCookie, loadOptimisticCookie } from '../state/stateActions';

// --- NEW CUSTOM ERROR ---
/**
 * Custom error thrown when user state resolution fails during login,
 * distinguishing it from other login failures (e.g., bad credentials).
 */
export class UserStateNotFoundError extends Error {
    public readonly identifier: string; // The keyName
    constructor(message: string, identifier: string) {
        super(message);
        this.name = 'UserStateNotFoundError';
        this.identifier = identifier;
    }
}
// --- END NEW CUSTOM ERROR ---


const SESSION_COOKIE_PREFIX = 'dSocialSession';
const DEFAULT_USER_STATE_CID = "QmRh23Gd4AJLBH82CN9wz2MAe6sY95AqDSDBMFW1qnheny";

// --- HELPER: Multibase Encoding (base64url with 'u' prefix) ---
function toMultibase(str: string): string {
    try {
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return 'u' + base64url;
    } catch (e) {
        console.error("Multibase encoding failed", e);
        return str;
    }
}

// --- NEW HELPER: Get user-specific cookie name ---
function getDynamicSessionCookieName(label?: string | null): string | null {
    const userLabel = label || sessionStorage.getItem("currentUserLabel");
    if (!userLabel) {
        console.warn("getDynamicSessionCookieName: No user label found.");
        return null;
    }
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${SESSION_COOKIE_PREFIX}_${sanitizedLabel}`;
}

export const createEmptyUserState = (profile: { name: string }): UserState => ({
    profile: profile, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null,
});


// --- Session Management ---

export function getSession(): Session {
    const cookieName = getDynamicSessionCookieName();
    if (!cookieName) {
        return { sessionType: null };
    }
    const sessionCookie = loadSessionCookie<Session>(cookieName);

    if (sessionCookie?.sessionType === 'kubo' && sessionCookie.rpcApiUrl && sessionCookie.ipnsKeyName && sessionCookie.resolvedIpnsKey) {
        return {
            ...sessionCookie,
            kuboUsername: sessionCookie.kuboUsername,
            kuboPassword: sessionCookie.kuboPassword
        };
    }
    return { sessionType: null };
 }

export function saveSessionCookie<T extends Partial<Session>>(name: string, value: T): void {
    const days = 7;
    try {
        const serializableValue: Partial<Session> = value;
        const cookieToSave = {
            sessionType: serializableValue.sessionType,
            rpcApiUrl: serializableValue.rpcApiUrl,
            ipnsKeyName: serializableValue.ipnsKeyName,
            resolvedIpnsKey: serializableValue.resolvedIpnsKey,
            kuboUsername: serializableValue.kuboUsername,
            kuboPassword: serializableValue.kuboPassword
        };
        const stringValue = JSON.stringify(cookieToSave);
        setCookie(name, stringValue, days);
    } catch (e) { console.error("Failed save cookie:", e); }
}

export function loadSessionCookie<T>(name: string): T | null {
  const cookieValue = getCookie(name); if (cookieValue) { try { return JSON.parse(cookieValue) as T; } catch (e) { console.error("Failed parse cookie:", e); eraseCookie(name); return null; } } return null;
}

export function logoutSession(): void {
    const cookieName = getDynamicSessionCookieName();
    if (cookieName) eraseCookie(cookieName);
    sessionStorage.removeItem("currentUserLabel");
}


// --- IPFS/IPNS Operations ---

export async function fetchKubo(
    apiUrl: string,
    path: string,
    params?: Record<string, string>,
    body?: FormData | string,
    auth?: { username?: string, password?: string },
    timeoutMs: number = 60000 // Default to 60 seconds
): Promise<any> {
    let actualPath = path;
    let queryString = '';
    if (path.includes('?')) {
        [actualPath, queryString] = path.split('?', 2);
    }
    const url = new URL(`${apiUrl}${actualPath}`);
    if (queryString) {
        new URLSearchParams(queryString).forEach((value, key) => {
            url.searchParams.append(key, value);
        });
    }
    // Append additional params
    if (params) {
         Object.entries(params).forEach(([k, v]) => { url.searchParams.append(k, v); });
    }

    const headers = new Headers();
    if (auth?.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers.append('Authorization', `Basic ${credentials}`);
    }

    let fetchBody: BodyInit | null = null;
    if (body instanceof FormData) {
        fetchBody = body;
    } else if (typeof body === 'string') {
        fetchBody = body;
        headers.append('Content-Type', 'application/json');
    }

    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => {
        console.warn(`[fetchKubo] TIMEOUT for ${actualPath} after ${timeoutMs/1000}s.`);
        ctrl.abort();
    }, timeoutMs);

    try {
        const response = await fetch(url.toString(), {
            method: "POST",
            headers: headers,
            body: fetchBody,
            signal: ctrl.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const txt = await response.text();
            let jsn; try { jsn = JSON.parse(txt); } catch { /* ignore */ }
            const msg = jsn?.Message || txt || `HTTP ${response.status}`;
            if (actualPath === '/api/v0/name/resolve' && msg.includes('could not resolve name')) throw new Error(`Kubo IPNS failed: ${msg}`);
            throw new Error(`Kubo RPC error ${actualPath}: ${msg}`);
        }

        // --- Robust handling for /api/v0/add response ---
        if (actualPath === "/api/v0/add") {
            const txt = await response.text();
            if (!txt || txt.trim() === '') {
                 throw new Error("Bad 'add' response: Empty body.");
            }
            const lines = txt.trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const p = JSON.parse(lines[i]);
                    if (p?.Hash) return p; // Return the parsed object containing the Hash
                } catch (e) {
                     // ignore
                }
            }
            throw new Error("Bad 'add' response: No valid JSON object with 'Hash' found.");
        }

        if (actualPath === "/api/v0/cat") {
            try { return await response.json(); } catch (e) { throw new Error("Bad 'cat' response."); }
        }

        if (["/api/v0/name/resolve", "/api/v0/name/publish", "/api/v0/key/list", "/api/v0/id", "/api/v0/key/gen", "/api/v0/pin/rm", "/api/v0/files/rm", "/api/v0/repo/gc", "/api/v0/files/cp", "/api/v0/pubsub/pub"].includes(actualPath)) {
             // For /files/cp and /pubsub/pub, success is indicated by 200 OK
             if (actualPath === '/api/v0/files/cp' || actualPath === '/api/v0/pubsub/pub') {
                 const text = await response.text();
                 if (text) {
                     try { return JSON.parse(text); } catch { return { Success: true }; }
                 } else {
                     return { Success: true }; // Indicate success even with empty body
                 }
             }
             return response.json();
        }
        return response.json();
    } catch (e) {
        clearTimeout(timeoutId);
        if (e instanceof Error && e.name === 'AbortError') {
             throw new Error(`Kubo RPC error ${actualPath}: Request timed out after ${timeoutMs/1000}s.`);
        }
        throw e;
    }
}


export async function uploadJsonToIpfs(apiUrl: string, data: any, auth?: { username?: string, password?: string }): Promise<string> {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); const fd = new FormData(); fd.append('file', blob, `data-${Date.now()}.json`);
    // Uses default (longer) timeout
    const res = await fetchKubo(apiUrl, '/api/v0/add', { pin: 'true', 'cid-version': '1' }, fd, auth);
    if (!res?.Hash) throw new Error("Upload failed (JSON)."); return res.Hash;
}

export async function publishToIpns(apiUrl: string, cid: string, keyName: string, auth?: { username?: string, password?: string }): Promise<string> {
    // Uses default (longer) timeout
    const res = await fetchKubo(apiUrl, '/api/v0/name/publish', { arg: `/ipfs/${cid}`, key: keyName, lifetime: '720h' }, undefined, auth);
    if (!res?.Name) throw new Error("Publish failed (IPNS)."); return res.Name;
}

// --- NEW PUBSUB FUNCTIONS (FIXED) ---

export async function publishToPubsub(
    apiUrl: string,
    topic: string,
    data: any,
    auth?: { username?: string, password?: string }
): Promise<void> {
    const serialized = JSON.stringify(data);
    const encodedTopic = toMultibase(topic); 
    
    const formData = new FormData();
    const blob = new Blob([serialized], { type: 'application/json' });
    formData.append('file', blob, 'data.json'); 

    await fetchKubo(apiUrl, '/api/v0/pubsub/pub', { arg: encodedTopic }, formData, auth);
}

export async function subscribeToPubsub(
    apiUrl: string,
    topic: string,
    onMessage: (msg: any) => void,
    abortSignal: AbortSignal,
    auth?: { username?: string, password?: string }
): Promise<void> {
    const encodedTopic = toMultibase(topic);
    const url = new URL(`${apiUrl}/api/v0/pubsub/sub`);
    url.searchParams.append('arg', encodedTopic);
    url.searchParams.append('discover', 'true');

    const headers = new Headers();
    if (auth?.username && auth.password) {
        headers.append('Authorization', `Basic ${btoa(`${auth.username}:${auth.password}`)}`);
    }

    try {
        const response = await fetch(url.toString(), {
            method: 'POST',
            headers,
            signal: abortSignal
        });

        if (!response.ok) {
             const txt = await response.text();
             throw new Error(`PubSub sub failed (${response.status}): ${txt || response.statusText}`);
        }
        if (!response.body) {
             throw new Error('PubSub sub failed: No response body.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;

                let parsedEnvelope;
                try {
                    parsedEnvelope = JSON.parse(line);
                } catch (e) {
                    continue; // Skip heartbeats or non-JSON lines
                }

                if (parsedEnvelope && parsedEnvelope.data) {
                    let decodedData = '';
                    try {
                        let base64Data = parsedEnvelope.data;
                        
                        // FIX: Detect and strip Multibase prefix ('u') if present
                        if (base64Data.startsWith('u')) {
                            base64Data = base64Data.slice(1);
                        }

                        // Fix URL-safe characters
                        base64Data = base64Data.replace(/-/g, '+').replace(/_/g, '/');
                        // Fix Padding
                        while (base64Data.length % 4) {
                            base64Data += '=';
                        }

                        const binString = atob(base64Data);
                        decodedData = new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)!));
                        
                        const jsonMsg = JSON.parse(decodedData);
                        onMessage(jsonMsg);
                    } catch (e) {
                        console.warn("[subscribeToPubsub] Parse Error. Raw Data:", parsedEnvelope.data, "Decoded:", decodedData, "Error:", e);
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
             console.log("[subscribeToPubsub] Subscription aborted.");
             return;
        }
        console.error("[subscribeToPubsub] Stream error:", e);
    }
}
// --- END NEW PUBSUB FUNCTIONS ---


export async function loginToKubo(
    apiUrl: string,
    keyName: string,
    forceInitialize: boolean = false,
    username?: string,
    password?: string
): Promise<{ session: Session, state: UserState, cid: string }> {
     try {
         await fetchKubo(apiUrl, '/api/v0/id', undefined, undefined, { username, password });
         const keysResponse = await fetchKubo(apiUrl, '/api/v0/key/list', undefined, undefined, { username, password });
         let keyInfo = Array.isArray(keysResponse?.Keys) ? keysResponse.Keys.find((k: any) => k.Name === keyName) : undefined;

         let resolvedIpnsKey: string;
         let initialCid = '';
         let initialState: UserState;

         if (!keyInfo?.Id) {
            console.log(`[loginToKubo] Key "${keyName}" not found. Generating new key...`);
            try {
                const genResponse = await fetchKubo(apiUrl, '/api/v0/key/gen', { arg: keyName, type: 'ed25519' }, undefined, { username, password });
                if (!genResponse?.Id || !genResponse?.Name || genResponse.Name !== keyName) {
                    throw new Error(`Failed to generate key "${keyName}" or response was invalid.`);
                }
                keyInfo = genResponse;
                resolvedIpnsKey = keyInfo.Id;
                
                initialState = createEmptyUserState({ name: keyName });
                initialCid = await uploadJsonToIpfs(apiUrl, initialState, { username, password });
                await publishToIpns(apiUrl, initialCid, keyName, { username, password });
                toast.success(`Created new profile key: ${keyName}`);

            } catch (genError) {
                throw new Error(`Failed to create or initialize profile "${keyName}". ${genError instanceof Error ? genError.message : ''}`);
            }
         } else {
             resolvedIpnsKey = keyInfo.Id;
             try {
                 initialCid = await resolveIpns(resolvedIpnsKey); 
                 initialState = await fetchUserState(initialCid, keyName); 
             } catch (e) {
                 if (forceInitialize) {
                     initialState = createEmptyUserState({ name: keyName });
                     initialCid = await uploadJsonToIpfs(apiUrl, initialState, { username, password });
                     await publishToIpns(apiUrl, initialCid, keyName, { username, password });
                 } else {
                     throw new UserStateNotFoundError(`Failed to resolve initial state for ${keyName}`, keyName);
                 }
             }
         }

         const session: Session = {
             sessionType: 'kubo',
             rpcApiUrl: apiUrl,
             ipnsKeyName: keyName,
             resolvedIpnsKey,
             kuboUsername: username,
             kuboPassword: password
         };
         const cookieName = getDynamicSessionCookieName(keyName);
         if (!cookieName) throw new Error("Could not create session cookie name.");
         saveSessionCookie(cookieName, session);

         return { session, state: initialState, cid: initialCid };

     } catch (error) {
         console.error("Kubo login failed:", error);
         logoutSession();
         if (error instanceof UserStateNotFoundError) {
             throw error;
         }
         if (error instanceof Error && error.message.includes('401 Unauthorized')) {
             throw new Error(`Authentication failed for Kubo node. Please check username/password.`);
         }
         throw new Error(`Kubo login failed. ${error instanceof Error ? error.message : ''}`);
     }
}

const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();
const IPNS_CACHE_TTL = 5 * 60 * 1000; 

export const invalidateSpecificIpnsCacheEntry = (ipnsIdentifier: string): void => {
    if (ipnsResolutionCache.has(ipnsIdentifier)) {
        ipnsResolutionCache.delete(ipnsIdentifier);
    }
};


const PUBLIC_IPNS_GATEWAYS = [
    { type: 'path', url: 'https://ipfs.io' },
    { type: 'subdomain', url: 'https://{ipnsKey}.ipns.dweb.link' }
] as const;
type IpnsGateway = typeof PUBLIC_IPNS_GATEWAYS[number];

async function resolveIpnsViaGateways(ipnsKey: string): Promise<string> {
    if (!ipnsKey.startsWith('k51')) console.warn(`Resolving non-PeerID: ${ipnsKey}`);

    const promises = PUBLIC_IPNS_GATEWAYS.map(async (gw: IpnsGateway) => {
        let url: string;
        if (gw.type === 'path') {
            url = `${gw.url}/ipns/${ipnsKey}`;
        } else {
            url = gw.url.replace('{ipnsKey}', ipnsKey);
        }

        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 25000); 
        try {
            const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(tId);

            if (!res.ok && res.status !== 302) {
                throw new Error(`${url} failed: ${res.status}`);
            }
            const rootsHeader = res.headers.get('x-ipfs-roots');
            if (rootsHeader) return rootsHeader;
            const locationHeader = res.headers.get('location');
            if (locationHeader?.startsWith('/ipfs/')) return locationHeader.replace('/ipfs/', '');
            const pathHeader = res.headers.get('x-ipfs-path');
            if (pathHeader?.startsWith('/ipfs/')) return pathHeader.replace('/ipfs/', '');
            throw new Error(`${url} no valid header (roots, location, or path).`);
        } catch (e) { clearTimeout(tId); throw e; }
    });

    try {
        const cid = await Promise.any(promises);
        ipnsResolutionCache.set(ipnsKey, { cid, timestamp: Date.now() });
        return cid;
    } catch (e) {
        throw e;
    }
}

export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    const cached = ipnsResolutionCache.get(ipnsIdentifier);
    if (cached && (Date.now() - cached.timestamp < IPNS_CACHE_TTL)) {
         return cached.cid;
    }
    const session = getSession();
    let keyToResolve: string | null = ipnsIdentifier;

    if (session.sessionType === 'kubo' && session.rpcApiUrl && session.resolvedIpnsKey && (ipnsIdentifier === session.ipnsKeyName || ipnsIdentifier === session.resolvedIpnsKey)) {
        keyToResolve = session.resolvedIpnsKey;
        try {
            const res = await fetchKubo(
                session.rpcApiUrl,
                '/api/v0/name/resolve',
                { arg: keyToResolve }, 
                undefined,
                { username: session.kuboUsername, password: session.kuboPassword },
                5000 
            );
            if (res?.Path?.startsWith('/ipfs/')) {
                 const cid = res.Path.replace('/ipfs/', '');
                 ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() });
                 ipnsResolutionCache.set(keyToResolve, { cid, timestamp: Date.now() });
                 return cid;
            }
            throw new Error("Kubo resolve returned invalid path.");
        } catch (e) {
             keyToResolve = ipnsIdentifier.startsWith('k51') ? ipnsIdentifier : null;
        }
    }
    else if (!ipnsIdentifier.startsWith('k51')) {
        keyToResolve = null;
    } else {
        keyToResolve = ipnsIdentifier;
    }


    if (!keyToResolve) {
         if (cached) {
             return cached.cid;
         }
         throw new Error(`Cannot resolve identifier "${ipnsIdentifier}" without a Peer ID or Kubo session.`);
    }

    try {
         const cid = await resolveIpnsViaGateways(keyToResolve); 
         ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() });
         if (keyToResolve !== ipnsIdentifier && ipnsIdentifier.startsWith('k51')) { 
             ipnsResolutionCache.set(keyToResolve, { cid, timestamp: Date.now() });
         }
         return cid;
     }
    catch (e) {
        if (cached) {
            return cached.cid;
        }
        throw e;
    }
}


const PUBLIC_CONTENT_GATEWAYS = [
    { type: 'path', url: 'https://ipfs.io' },
    { type: 'subdomain', url: 'https://{cid}.ipfs.dweb.link' }
] as const;
type ContentGateway = typeof PUBLIC_CONTENT_GATEWAYS[number];

async function fetchCidViaGateways(cid: string): Promise<any> {
    const isCidV0 = cid.startsWith('Qm');
    const gatewaysToTry = PUBLIC_CONTENT_GATEWAYS.filter(gw => isCidV0 ? gw.type === 'path' : true);
    if (gatewaysToTry.length === 0) throw new Error(`No suitable public gateway found for CID: ${cid}`);

    const promises = gatewaysToTry.map(async (gw: ContentGateway) => {
        let url: string;
        if (gw.type === 'path') url = `${gw.url}/ipfs/${cid}`;
        else url = gw.url.replace('{cid}', cid);
        const ctrl = new AbortController(); const tId = setTimeout(() => ctrl.abort(), 60000); 
        try { const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(tId); if (!res.ok) throw new Error(`${url} fail: ${res.status}`); return await res.json(); } catch (e) { clearTimeout(tId); throw e; }
    });
    try {
        return await Promise.any(promises);
    } catch (e) {
        throw e;
    }
}

export async function fetchUserState(cid: string, profileNameHint?: string): Promise<UserState> {
    let aggregatedState: Partial<UserState> = { postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], profile: undefined, updatedAt: 0, };
    let currentCid: string | null = cid; let isHead = true; let chunksProcessed = 0; const maxChunksToFetch = 100;

    while (currentCid && chunksProcessed < maxChunksToFetch) {
        if (currentCid === DEFAULT_USER_STATE_CID && isHead) { return createEmptyUserState({ name: profileNameHint || "Default User" }); }
        chunksProcessed++; 

        try {
            const chunk = await fetchUserStateChunk(currentCid, profileNameHint); 
            if (!chunk || (isHead && !chunk.profile)) { if (isHead) { throw new Error(`Head state chunk ${currentCid} is invalid or missing profile.`); } else { toast.error(`Could not load older state (CID: ${currentCid.substring(0, 8)}...). Some history may be missing.`); currentCid = null; continue; } }
            if (isHead) { aggregatedState.profile = chunk.profile; aggregatedState.updatedAt = typeof chunk.updatedAt === 'number' ? chunk.updatedAt : 0; isHead = false; }
            aggregatedState.postCIDs = [...(aggregatedState.postCIDs ?? []), ...(Array.isArray(chunk.postCIDs) ? chunk.postCIDs : [])];
            aggregatedState.follows = [...(aggregatedState.follows ?? []), ...(Array.isArray(chunk.follows) ? chunk.follows : [])];
            aggregatedState.likedPostCIDs = [...(aggregatedState.likedPostCIDs ?? []), ...(Array.isArray(chunk.likedPostCIDs) ? chunk.likedPostCIDs : [])];
            aggregatedState.dislikedPostCIDs = [...(aggregatedState.dislikedPostCIDs ?? []), ...(Array.isArray(chunk.dislikedPostCIDs) ? chunk.dislikedPostCIDs : [])];
            currentCid = chunk.extendedUserState || null;
        } catch (error) { const shortCid = currentCid ? currentCid.substring(0, 8) : 'unknown'; if (isHead) { toast.error(`Failed to load primary user state (CID: ${shortCid}...).`); throw new Error(`Failed to fetch head state chunk ${currentCid}: ${error instanceof Error ? error.message : String(error)}`); } else { toast.error(`Failed to load part of the state history (CID: ${shortCid}...).`); currentCid = null; } }
    }
    if (chunksProcessed >= maxChunksToFetch) { toast.error("Reached maximum state history depth. Older data may be missing."); }

    const uniqueFollowsMap = new Map<string, Follow>();
    (aggregatedState.follows ?? []).forEach(follow => { if (follow?.ipnsKey && !uniqueFollowsMap.has(follow.ipnsKey)) { uniqueFollowsMap.set(follow.ipnsKey, follow); } });

    const uniquePostCIDs = [...new Set(aggregatedState.postCIDs ?? [])];
    const uniqueLikedPostCIDs = [...new Set(aggregatedState.likedPostCIDs ?? [])];
    const uniqueDislikedPostCIDs = [...new Set(aggregatedState.dislikedPostCIDs ?? [])];

    return {
        profile: aggregatedState.profile || { name: profileNameHint || 'Unknown User' },
        postCIDs: uniquePostCIDs,
        follows: Array.from(uniqueFollowsMap.values()),
        likedPostCIDs: uniqueLikedPostCIDs,
        dislikedPostCIDs: uniqueDislikedPostCIDs,
        updatedAt: aggregatedState.updatedAt || 0,
        extendedUserState: null 
    };
}

export async function fetchUserStateChunk(cid: string, profileNameHint?: string): Promise<Partial<UserState>> {
    if (cid === DEFAULT_USER_STATE_CID) {
         return { profile: { name: profileNameHint || "Default User" }, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null };
    }
    try {
        const data = await fetchPost(cid); 
        if (!data) throw new Error(`No data found for CID ${cid}`);
        return data as Partial<UserState>;
    } catch (error) { console.error(`Failed to fetch UserState chunk ${cid}:`, error); return {}; }
}

export async function fetchPost(cid: string): Promise<Post | UserState | any > {
    const session = getSession();
    if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        try {
            return await fetchKubo(
                session.rpcApiUrl,
                '/api/v0/cat',
                { arg: cid },
                undefined,
                { username: session.kuboUsername, password: session.kuboPassword },
                5000 
            );
        } catch (e) { console.warn(`Kubo fetch ${cid} failed, falling back to public gateways.`, e); }
    }
    try { return await fetchCidViaGateways(cid); } catch (e) { throw e; }
}

export async function fetchPostLocal(cid: string, authorHint: string): Promise<Post | UserState | any> {
    const session = getSession();
    let data: any = null;

    if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        try {
            data = await fetchKubo(
                session.rpcApiUrl,
                '/api/v0/cat',
                { arg: cid },
                undefined,
                { username: session.kuboUsername, password: session.kuboPassword },
                5000 
            );

            if (data && typeof data === 'object' && (data.authorKey || data.profile)) { return data; }
            else { data = null; }
        } catch (e) { data = null; }
    } 

    if (data === null) {
        try {
            data = await fetchCidViaGateways(cid); 
            if (data && typeof data === 'object' && (data.authorKey || data.profile)) { return data; }
            else { data = null; }
        } catch (e) { data = null; }
    }

    const errorMessage = "Content unavailable.";
    const placeholderPost: Post = {
        id: cid, authorKey: authorHint, content: `[Post content (CID: ${cid.substring(0, 10)}...) ${errorMessage}]`, timestamp: 0, replies: []
    };
    return placeholderPost;
}

export const getMediaUrl = (cid: string): string => {
    if (!cid || cid.startsWith('blob:')) return cid;
    const isCidV0 = cid.startsWith('Qm');
    if (isCidV0) return `${PUBLIC_CONTENT_GATEWAYS[0].url}/ipfs/${cid}`;
    const gw = PUBLIC_CONTENT_GATEWAYS[1]; return gw.url.replace('{cid}', cid);
};

export const invalidateIpnsCache = () => { console.log("Invalidating ALL IPNS cache."); ipnsResolutionCache.clear(); };