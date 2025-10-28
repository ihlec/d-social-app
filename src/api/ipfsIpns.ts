// fileName: src/lib/ipfsIpns.ts
// src/lib/ipfs.ts
import { UserState, Post, Session, Follow } from '../types'; // --- ADDED FOLLOW ---
import { getCookie, setCookie, eraseCookie } from '../lib/utils';
// --- REMOVED: S3Client import ---
import toast from 'react-hot-toast';
// --- ADDED: saveOptimisticCookie (moved back from stateActions) ---
// --- FIX: Export missing functions from stateActions that were moved back ---
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
const DEFAULT_USER_STATE_CID = "QmRh23Gd4AJLBH82CN9wz2MAe6sY95AqDSDBMFW1qnheny"; // Used

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
// --- End New Helper ---

// --- REMOVED: Filebase API Functions ---

export const createEmptyUserState = (profile: { name: string }): UserState => ({
    profile: profile, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null,
});

// --- REMOVED: S3 Client Helper ---

// --- Session Management ---

export function getSession(): Session {
    const cookieName = getDynamicSessionCookieName();
    if (!cookieName) {
        console.log("[getSession] No dynamic cookie name, returning null session.");
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

    console.log(`[getSession] No valid Kubo session found in cookie '${cookieName}'.`);
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
    if (cookieName) {
        eraseCookie(cookieName);
        console.log(`[logoutSession] Erased cookie: ${cookieName}`);
    } else {
        console.warn("[logoutSession] No cookie name found to erase.");
    }
    sessionStorage.removeItem("currentUserLabel");
}
// --- End Session Management ---


// --- IPFS/IPNS Operations ---

export async function fetchKubo(
    apiUrl: string,
    path: string,
    params?: Record<string, string>,
    body?: FormData | string,
    auth?: { username?: string, password?: string },
    timeoutMs: number = 60000 // Default to 60 seconds
): Promise<any> {
    // --- START MODIFICATION: Handle query string embedded in path ---
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
    // --- END MODIFICATION ---


    const headers = new Headers();
    if (auth?.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers.append('Authorization', `Basic ${credentials}`);
        // console.log(`[fetchKubo] Using Basic Auth for ${actualPath}`); // Log actualPath
    } else {
         // console.log(`[fetchKubo] No auth provided for ${actualPath}`); // Log actualPath
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
        console.warn(`[fetchKubo] TIMEOUT for ${actualPath} after ${timeoutMs/1000}s.`); // Log actualPath
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
            if (actualPath === '/api/v0/name/resolve' && msg.includes('could not resolve name')) throw new Error(`Kubo IPNS failed: ${msg}`); // Use actualPath
            throw new Error(`Kubo RPC error ${actualPath}: ${msg}`); // Use actualPath
        }

        // --- START MODIFICATION: Robust handling for /api/v0/add response ---
        if (actualPath === "/api/v0/add") {
            const txt = await response.text();
            if (!txt || txt.trim() === '') {
                 console.error("[fetchKubo] Received empty response body for /api/v0/add");
                 throw new Error("Bad 'add' response: Empty body.");
            }
            const lines = txt.trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const p = JSON.parse(lines[i]);
                    if (p?.Hash) return p; // Return the parsed object containing the Hash
                } catch (e) {
                     console.warn(`[fetchKubo] Failed to parse line ${i} of /api/v0/add response: "${lines[i]}"`, e);
                     // Continue trying previous lines
                }
            }
            console.error("[fetchKubo] Could not find valid JSON with 'Hash' in /api/v0/add response:", txt);
            throw new Error("Bad 'add' response: No valid JSON object with 'Hash' found.");
        }
        // --- END MODIFICATION ---

        if (actualPath === "/api/v0/cat") { // Use actualPath
            try { return await response.json(); } catch (e) { throw new Error("Bad 'cat' response."); }
        }

        // Use actualPath in includes check
        if (["/api/v0/name/resolve", "/api/v0/name/publish", "/api/v0/key/list", "/api/v0/id", "/api/v0/key/gen", "/api/v0/pin/rm", "/api/v0/files/rm", "/api/v0/repo/gc", "/api/v0/files/cp"].includes(actualPath)) {
             // For /files/cp, success is indicated by 200 OK, response body might be empty
             if (actualPath === '/api/v0/files/cp') {
                 // Attempt to read text, but don't fail if it's empty
                 const text = await response.text();
                 // If there's text, try parsing, otherwise return a success indicator
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
             throw new Error(`Kubo RPC error ${actualPath}: Request timed out after ${timeoutMs/1000}s.`); // Use actualPath
        }
        console.error(`Kubo call failed: ${actualPath}`, e); // Use actualPath
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

export async function loginToKubo(
    apiUrl: string,
    keyName: string,
    forceInitialize: boolean = false,
    username?: string,
    password?: string
): Promise<{ session: Session, state: UserState, cid: string }> {
     try {
         // Uses default (longer) timeout
         await fetchKubo(apiUrl, '/api/v0/id', undefined, undefined, { username, password });
         const keysResponse = await fetchKubo(apiUrl, '/api/v0/key/list', undefined, undefined, { username, password });
         let keyInfo = Array.isArray(keysResponse?.Keys) ? keysResponse.Keys.find((k: any) => k.Name === keyName) : undefined;

         let resolvedIpnsKey: string;
         let initialCid = '';
         let initialState: UserState;

         if (!keyInfo?.Id) {
            console.log(`[loginToKubo] Key "${keyName}" not found. Generating new key...`);
            try {
                // Uses default (longer) timeout
                const genResponse = await fetchKubo(apiUrl, '/api/v0/key/gen', { arg: keyName, type: 'ed25519' }, undefined, { username, password });
                if (!genResponse?.Id || !genResponse?.Name || genResponse.Name !== keyName) {
                    throw new Error(`Failed to generate key "${keyName}" or response was invalid.`);
                }
                keyInfo = genResponse;
                resolvedIpnsKey = keyInfo.Id;
                console.log(`[loginToKubo] Successfully generated key "${keyName}" with ID: ${resolvedIpnsKey}`);
                toast.success(`Created new profile key: ${keyName}`);

                console.log(`[loginToKubo] Initializing state for new user "${keyName}"...`);
                initialState = createEmptyUserState({ name: keyName });
                // Uses default (longer) timeout
                initialCid = await uploadJsonToIpfs(apiUrl, initialState, { username, password });
                console.log(`[loginToKubo] Uploaded initial state to CID: ${initialCid}`);

                // Uses default (longer) timeout
                await publishToIpns(apiUrl, initialCid, keyName, { username, password });
                console.log(`[loginToKubo] Published initial state CID to IPNS for key "${keyName}".`);

            } catch (genError) {
                console.error(`[loginToKubo] Error during key generation or initial publish for "${keyName}":`, genError);
                throw new Error(`Failed to create or initialize profile "${keyName}". ${genError instanceof Error ? genError.message : ''}`);
            }
         } else {
             resolvedIpnsKey = keyInfo.Id;
             console.log(`[loginToKubo] Found existing key "${keyName}" with ID: ${resolvedIpnsKey}`);
             try {
                 initialCid = await resolveIpns(resolvedIpnsKey); // Uses shorter timeout
                 initialState = await fetchUserState(initialCid, keyName); // Uses shorter timeout
             } catch (e) {
                 console.warn(`Could not resolve initial state for existing user ${keyName}:`, e);
                 if (forceInitialize) {
                     console.log(`[loginToKubo] Force initializing existing user ${keyName}.`);

                     // --- START MODIFICATION: Ensure empty state is uploaded before publishing ---
                     initialState = createEmptyUserState({ name: keyName });
                     initialCid = await uploadJsonToIpfs(apiUrl, initialState, { username, password });
                     console.log(`[loginToKubo] Uploaded new empty state to CID: ${initialCid}`);

                     // Uses default (longer) timeout
                     await publishToIpns(apiUrl, initialCid, keyName, { username, password });
                     console.log(`[loginToKubo] Force initialized and published NEW empty state for ${keyName}.`);
                     // --- END MODIFICATION ---

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

         console.log(`[loginToKubo] Login successful for "${keyName}". Returning state from CID: ${initialCid}`);
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

// --- REMOVED: loginToFilebase ---

const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();
const IPNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- START MODIFICATION: Add specific cache invalidation function ---
/**
 * Removes a specific IPNS key from the in-memory resolution cache.
 */
export const invalidateSpecificIpnsCacheEntry = (ipnsIdentifier: string): void => {
    if (ipnsResolutionCache.has(ipnsIdentifier)) {
        ipnsResolutionCache.delete(ipnsIdentifier);
        console.log(`[Cache] Invalidated cache entry for ${ipnsIdentifier}`);
    }
};
// --- END MODIFICATION ---


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
        const tId = setTimeout(() => ctrl.abort(), 10000); // 10s timeout for public gateways
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
        const msgs = e instanceof AggregateError ? e.errors.map(er => er instanceof Error ? er.message : String(er)).join(', ') : (e instanceof Error ? e.message : String(e));
        console.error(`IPNS resolve ${ipnsKey} failed via public gateways. Errors: ${msgs}`);
        throw new Error(`Could not resolve ${ipnsKey} via public gateways.`);
    }
}

export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    const cached = ipnsResolutionCache.get(ipnsIdentifier);
    if (cached && (Date.now() - cached.timestamp < IPNS_CACHE_TTL)) {
         console.log(`[resolveIpns] Returning cached CID for ${ipnsIdentifier}: ${cached.cid}`); // Added logging
         return cached.cid;
    }
    console.log(`[resolveIpns] Cache miss or expired for ${ipnsIdentifier}. Attempting fetch...`); // Added logging
    const session = getSession();
    let keyToResolve: string | null = ipnsIdentifier;

    if (session.sessionType === 'kubo' && session.rpcApiUrl && session.resolvedIpnsKey && (ipnsIdentifier === session.ipnsKeyName || ipnsIdentifier === session.resolvedIpnsKey)) {
        keyToResolve = session.resolvedIpnsKey;
        try {
            console.log(`[resolveIpns] Attempting Kubo resolve for ${keyToResolve}...`); // Added logging
            const res = await fetchKubo(
                session.rpcApiUrl,
                '/api/v0/name/resolve',
                { arg: keyToResolve, nocache: 'true' },
                undefined,
                { username: session.kuboUsername, password: session.kuboPassword },
                5000 // 5 seconds timeout
            );
            if (res?.Path?.startsWith('/ipfs/')) {
                 const cid = res.Path.replace('/ipfs/', '');
                 console.log(`[resolveIpns] Kubo success for ${keyToResolve}. Resolved to: ${cid}. Caching.`); // Added logging
                 ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() });
                 ipnsResolutionCache.set(keyToResolve, { cid, timestamp: Date.now() });
                 return cid;
            }
            throw new Error("Kubo resolve returned invalid path.");
        } catch (e) { console.warn(`Kubo resolve failed for ${ipnsIdentifier}, falling back to public gateways.`, e); }
    }
    else if (!ipnsIdentifier.startsWith('k51')) { keyToResolve = null; }

    if (!keyToResolve) { if (cached) { console.warn(`Could not resolve ${ipnsIdentifier} (not PeerID or no session), returning expired cache.`); return cached.cid; } throw new Error(`Cannot resolve identifier "${ipnsIdentifier}" without a Peer ID or Kubo session.`); }

    try {
         console.log(`[resolveIpns] Attempting public gateway resolve for ${keyToResolve}...`); // Added logging
         const cid = await resolveIpnsViaGateways(keyToResolve);
         console.log(`[resolveIpns] Public gateway success for ${keyToResolve}. Resolved to: ${cid}. Caching.`); // Added logging
         // Cache under both original identifier and the resolved key if different
         ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() });
         if (keyToResolve !== ipnsIdentifier) {
             ipnsResolutionCache.set(keyToResolve, { cid, timestamp: Date.now() });
         }
         return cid;
     }
    catch (e) { if (cached) { console.warn(`Public gateway resolve failed for ${ipnsIdentifier}, returning expired cache.`); return cached.cid; } throw e; }
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
        const ctrl = new AbortController(); const tId = setTimeout(() => ctrl.abort(), 60000); // 60s timeout
        try { const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(tId); if (!res.ok) throw new Error(`${url} fail: ${res.status}`); return await res.json(); } catch (e) { clearTimeout(tId); throw e; }
    });
    // --- START MODIFICATION: Ensure catch block re-throws ---
    try {
        // Promise.any resolves as soon as one promise resolves
        return await Promise.any(promises);
    } catch (e) {
        // If ALL promises reject, Promise.any rejects with an AggregateError
        const msgs = e instanceof AggregateError ? e.errors.map(er => er instanceof Error ? er.message : String(er)).join(', ') : (e instanceof Error ? e.message : String(e));
        console.error(`Fetch CID ${cid} failed via ALL public gateways. Errors: ${msgs}`);
        // Re-throw the original error (likely AggregateError) to signal failure
        throw e;
    }
    // --- END MODIFICATION ---
}

export async function fetchUserState(cid: string, profileNameHint?: string): Promise<UserState> {
    let aggregatedState: Partial<UserState> = { postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], profile: undefined, updatedAt: 0, };
    let currentCid: string | null = cid; let isHead = true; let chunksProcessed = 0; const maxChunksToFetch = 100;
    console.log(`[fetchUserState] Starting aggregation from head CID: ${cid}`);

    while (currentCid && chunksProcessed < maxChunksToFetch) {
        if (currentCid === DEFAULT_USER_STATE_CID && isHead) { console.log(`[fetchUserState] Hit default CID on head, using profileNameHint: '${profileNameHint}'`); return createEmptyUserState({ name: profileNameHint || "Default User" }); }
        chunksProcessed++; console.log(`[fetchUserState] Processing chunk ${chunksProcessed}, CID: ${currentCid}`);

        try {
            const chunk = await fetchUserStateChunk(currentCid, profileNameHint); // Pass hint
            if (!chunk || (isHead && !chunk.profile)) { console.error(`[fetchUserState] Fetched data for chunk ${chunksProcessed} (CID: ${currentCid}) is not a valid UserState chunk. Stopping traversal.`); if (isHead) { console.error(`[fetchUserState] Head chunk ${currentCid} failed validation.`); throw new Error(`Head state chunk ${currentCid} is invalid or missing profile.`); } else { toast.error(`Could not load older state (CID: ${currentCid.substring(0, 8)}...). Some history may be missing.`); currentCid = null; continue; } }
            console.log(`[fetchUserState] Successfully fetched and validated chunk ${chunksProcessed}`, chunk);
            if (isHead) { aggregatedState.profile = chunk.profile; aggregatedState.updatedAt = typeof chunk.updatedAt === 'number' ? chunk.updatedAt : 0; isHead = false; }
            aggregatedState.postCIDs = [...(aggregatedState.postCIDs ?? []), ...(Array.isArray(chunk.postCIDs) ? chunk.postCIDs : [])];
            aggregatedState.follows = [...(aggregatedState.follows ?? []), ...(Array.isArray(chunk.follows) ? chunk.follows : [])];
            aggregatedState.likedPostCIDs = [...(aggregatedState.likedPostCIDs ?? []), ...(Array.isArray(chunk.likedPostCIDs) ? chunk.likedPostCIDs : [])];
            aggregatedState.dislikedPostCIDs = [...(aggregatedState.dislikedPostCIDs ?? []), ...(Array.isArray(chunk.dislikedPostCIDs) ? chunk.dislikedPostCIDs : [])];
            currentCid = chunk.extendedUserState || null;
            console.log(`[fetchUserState] Next chunk CID: ${currentCid}`);
        } catch (error) { console.error(`[fetchUserState] Failed to fetch or process chunk ${chunksProcessed} (CID: ${currentCid}):`, error); const shortCid = currentCid ? currentCid.substring(0, 8) : 'unknown'; if (isHead) { toast.error(`Failed to load primary user state (CID: ${shortCid}...).`); throw new Error(`Failed to fetch head state chunk ${currentCid}: ${error instanceof Error ? error.message : String(error)}`); } else { toast.error(`Failed to load part of the state history (CID: ${shortCid}...).`); currentCid = null; } }
    }
    if (chunksProcessed >= maxChunksToFetch) { console.warn(`[fetchUserState] Stopped aggregation after reaching max chunks limit (${maxChunksToFetch}). State might be incomplete.`); toast.error("Reached maximum state history depth. Older data may be missing."); }
    console.log(`[fetchUserState] Aggregation finished after ${chunksProcessed} chunks. Final state:`, aggregatedState);

    const uniqueFollowsMap = new Map<string, Follow>();
    (aggregatedState.follows ?? []).forEach(follow => { if (follow?.ipnsKey && !uniqueFollowsMap.has(follow.ipnsKey)) { uniqueFollowsMap.set(follow.ipnsKey, follow); } });
    console.log(`[fetchUserState] De-duplicated follows: ${aggregatedState.follows?.length} -> ${uniqueFollowsMap.size}`);

    const uniquePostCIDs = [...new Set(aggregatedState.postCIDs ?? [])];
    const uniqueLikedPostCIDs = [...new Set(aggregatedState.likedPostCIDs ?? [])];
    const uniqueDislikedPostCIDs = [...new Set(aggregatedState.dislikedPostCIDs ?? [])];
    console.log(`[fetchUserState] De-duplicated postCIDs: ${aggregatedState.postCIDs?.length} -> ${uniquePostCIDs.length}`);
    console.log(`[fetchUserState] De-duplicated likedPostCIDs: ${aggregatedState.likedPostCIDs?.length} -> ${uniqueLikedPostCIDs.length}`);

    return {
        profile: aggregatedState.profile || { name: profileNameHint || 'Unknown User' },
        postCIDs: uniquePostCIDs,
        follows: Array.from(uniqueFollowsMap.values()),
        likedPostCIDs: uniqueLikedPostCIDs,
        dislikedPostCIDs: uniqueDislikedPostCIDs,
        updatedAt: aggregatedState.updatedAt || 0,
        extendedUserState: null // Aggregated state never has an extension link
    };
}

// --- fetchUserStateChunk remains the same ---
export async function fetchUserStateChunk(cid: string, profileNameHint?: string): Promise<Partial<UserState>> {
    if (cid === DEFAULT_USER_STATE_CID) {
         return { profile: { name: profileNameHint || "Default User" }, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null };
    }
    try {
        const data = await fetchPost(cid); // Uses shorter timeout
        if (!data) throw new Error(`No data found for CID ${cid}`);
        return data as Partial<UserState>;
    } catch (error) { console.error(`Failed to fetch UserState chunk ${cid}:`, error); return {}; }
}

// --- fetchPost remains the same ---
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
                5000 // 5 seconds timeout
            );
        } catch (e) { console.warn(`Kubo fetch ${cid} failed, falling back to public gateways.`, e); }
    }
    try { return await fetchCidViaGateways(cid); } catch (e) { throw e; }
}

// --- fetchPostLocal remains the same ---
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
                5000 // 5 seconds timeout
            );

            if (data && typeof data === 'object' && (data.authorKey || data.profile)) { return data; }
            else { console.warn(`[fetchPostLocal] Kubo fetch ${cid} returned invalid data. Falling back.`); data = null; }
        } catch (e) { console.warn(`[fetchPostLocal] Kubo fetch ${cid} failed. Falling back.`, e); data = null; }
    } else { console.warn("[fetchPostLocal] No Kubo session available. Attempting public gateways."); }

    if (data === null) {
        try {
            data = await fetchCidViaGateways(cid); // Uses 60s timeout internally
            if (data && typeof data === 'object' && (data.authorKey || data.profile)) { return data; }
            else { console.warn(`[fetchPostLocal] Public gateway fetch ${cid} returned invalid data.`); data = null; }
        } catch (e) { console.error(`[fetchPostLocal] Public gateway fetch ${cid} failed.`, e); data = null; }
    }

    console.warn(`[fetchPostLocal] All fetch attempts failed for ${cid}. Returning placeholder.`);
    const errorMessage = "Content unavailable.";
    const placeholderPost: Post = {
        id: cid, authorKey: authorHint, content: `[Post content (CID: ${cid.substring(0, 10)}...) ${errorMessage}]`, timestamp: 0, replies: []
    };
    return placeholderPost;
}

// --- getMediaUrl remains the same ---
export const getMediaUrl = (cid: string): string => {
    if (!cid || cid.startsWith('blob:')) return cid;
    const isCidV0 = cid.startsWith('Qm');
    if (isCidV0) return `${PUBLIC_CONTENT_GATEWAYS[0].url}/ipfs/${cid}`;
    const gw = PUBLIC_CONTENT_GATEWAYS[1]; return gw.url.replace('{cid}', cid);
};

// --- Invalidate all cache function remains ---
export const invalidateIpnsCache = () => { console.log("Invalidating ALL IPNS cache."); ipnsResolutionCache.clear(); };