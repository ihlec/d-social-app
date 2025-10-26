// fileName: src/lib/ipfsIpns.ts
// src/lib/ipfs.ts
import { UserState, Post, Session, Follow } from '../types'; // --- ADDED FOLLOW ---
import { getCookie, setCookie, eraseCookie } from '../lib/utils';
// --- REMOVED: S3Client import ---
import toast from 'react-hot-toast';
// --- REMOVED: Circular import ---

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

    // Only Kubo sessions are valid now
    if (sessionCookie?.sessionType === 'kubo' && sessionCookie.rpcApiUrl && sessionCookie.ipnsKeyName && sessionCookie.resolvedIpnsKey) {
        return sessionCookie;
    }

    console.log(`[getSession] No valid Kubo session found in cookie '${cookieName}'.`);
    return { sessionType: null };
 }

export function saveSessionCookie<T>(name: string, value: T): void {
    const days = 7;
    try {
        const stringValue = JSON.stringify(value);
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

// fetchKubo uses its parameters
async function fetchKubo(apiUrl: string, path: string, params?: Record<string, string>, body?: FormData | string): Promise<any> {
    const url = new URL(`${apiUrl}${path}`); if (params) Object.entries(params).forEach(([k, v]) => { url.searchParams.append(k, v); }); try { const response = await fetch(url.toString(), { method: "POST", body: body }); if (!response.ok) { const txt = await response.text(); let jsn; try { jsn = JSON.parse(txt); } catch { /* ignore */ } const msg = jsn?.Message || txt || `HTTP ${response.status}`; if (path === '/api/v0/name/resolve' && msg.includes('could not resolve name')) throw new Error(`Kubo IPNS failed: ${msg}`); throw new Error(`Kubo RPC error ${path}: ${msg}`); } if (path === "/api/v0/add") { const txt = await response.text(); const lines = txt.trim().split('\n'); for (let i = lines.length - 1; i >= 0; i--) { try { const p = JSON.parse(lines[i]); if (p?.Hash) return p; } catch { /* ignore */ } } throw new Error("Bad 'add' response."); } if (path === "/api/v0/cat") { try { return await response.json(); } catch (e) { throw new Error("Bad 'cat' response."); } }
    // --- MODIFIED: Handle key/gen response ---
    if (["/api/v0/name/resolve", "/api/v0/name/publish", "/api/v0/key/list", "/api/v0/id", "/api/v0/key/gen"].includes(path)) return response.json();
    // --- END MODIFICATION ---
     return response.json(); } catch (e) { console.error(`Kubo call failed: ${path}`, e); throw e; }
}

// --- MOVED BACK: uploadJsonToIpfs from stateActions ---
export async function uploadJsonToIpfs(apiUrl: string, data: any): Promise<string> {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); const fd = new FormData(); fd.append('file', blob, `data-${Date.now()}.json`); const res = await fetchKubo(apiUrl, '/api/v0/add', { pin: 'true', 'cid-version': '1' }, fd); if (!res?.Hash) throw new Error("Upload failed."); return res.Hash;
}
// --- END MOVE ---

// publishToIpns uses its parameters
export async function publishToIpns(apiUrl: string, cid: string, keyName: string): Promise<string> {
    const res = await fetchKubo(apiUrl, '/api/v0/name/publish', { arg: `/ipfs/${cid}`, key: keyName, lifetime: '720h' }); if (!res?.Name) throw new Error("Publish failed."); return res.Name;
}

// --- MODIFIED: loginToKubo handles key creation and initialization ---
export async function loginToKubo(
    apiUrl: string,
    keyName: string,
    forceInitialize: boolean = false
): Promise<{ session: Session, state: UserState, cid: string }> {
     try {
         await fetchKubo(apiUrl, '/api/v0/id'); // Check Kubo connection
         const keysResponse = await fetchKubo(apiUrl, '/api/v0/key/list');
         let keyInfo = Array.isArray(keysResponse?.Keys) ? keysResponse.Keys.find((k: any) => k.Name === keyName) : undefined;

         let resolvedIpnsKey: string;
         let initialCid = '';
         let initialState: UserState;
         // --- REMOVED: Unused isNewUser variable ---

         if (!keyInfo?.Id) {
            // Key does not exist, create it
            console.log(`[loginToKubo] Key "${keyName}" not found. Generating new key...`);
            // isNewUser = true; // No longer needed
            try {
                const genResponse = await fetchKubo(apiUrl, '/api/v0/key/gen', { arg: keyName, type: 'ed25519' });
                if (!genResponse?.Id || !genResponse?.Name || genResponse.Name !== keyName) {
                    throw new Error(`Failed to generate key "${keyName}" or response was invalid.`);
                }
                keyInfo = genResponse; // Use the response as keyInfo
                resolvedIpnsKey = keyInfo.Id;
                console.log(`[loginToKubo] Successfully generated key "${keyName}" with ID: ${resolvedIpnsKey}`);
                toast.success(`Created new profile key: ${keyName}`);

                // Initialize state for the new user
                console.log(`[loginToKubo] Initializing state for new user "${keyName}"...`);
                initialState = createEmptyUserState({ name: keyName });
                // Use uploadJsonToIpfs (now defined in this file)
                initialCid = await uploadJsonToIpfs(apiUrl, initialState); // Upload the empty state
                console.log(`[loginToKubo] Uploaded initial state to CID: ${initialCid}`);

                // Publish the initial state CID
                await publishToIpns(apiUrl, initialCid, keyName);
                console.log(`[loginToKubo] Published initial state CID to IPNS for key "${keyName}".`);

            } catch (genError) {
                console.error(`[loginToKubo] Error during key generation or initial publish for "${keyName}":`, genError);
                throw new Error(`Failed to create or initialize profile "${keyName}". ${genError instanceof Error ? genError.message : ''}`);
            }
         } else {
             // Key exists, proceed as before
             resolvedIpnsKey = keyInfo.Id;
             console.log(`[loginToKubo] Found existing key "${keyName}" with ID: ${resolvedIpnsKey}`);
             try {
                 initialCid = await resolveIpns(resolvedIpnsKey);
                 initialState = await fetchUserState(initialCid, keyName); // Pass name hint
             } catch (e) {
                 console.warn(`Could not resolve initial state for existing user ${keyName}:`, e);
                 if (forceInitialize) {
                     console.log(`[loginToKubo] Force initializing existing user ${keyName}.`);
                     initialCid = DEFAULT_USER_STATE_CID; // Or re-upload empty state? For now, use default.
                     initialState = createEmptyUserState({ name: keyName });
                     // Maybe re-publish the default CID here?
                     await publishToIpns(apiUrl, initialCid, keyName);
                     console.log(`[loginToKubo] Force initialized and published default state for ${keyName}.`);

                 } else {
                     throw new UserStateNotFoundError(`Failed to resolve initial state for ${keyName}`, keyName);
                 }
             }
         }

         // Create and save session
         const session: Session = { sessionType: 'kubo', rpcApiUrl: apiUrl, ipnsKeyName: keyName, resolvedIpnsKey };
         const cookieName = getDynamicSessionCookieName(keyName);
         if (!cookieName) throw new Error("Could not create session cookie name.");
         saveSessionCookie(cookieName, session);

         console.log(`[loginToKubo] Login successful for "${keyName}". Returning state from CID: ${initialCid}`);
         return { session, state: initialState, cid: initialCid };

     } catch (error) {
         console.error("Kubo login failed:", error);
         logoutSession(); // Clear label and any old cookie
         // Re-throw specific errors or a generic one
         if (error instanceof UserStateNotFoundError) {
             throw error;
         }
         throw new Error(`Kubo login failed. ${error instanceof Error ? error.message : ''}`);
     }
}
// --- END MODIFICATION ---

// --- REMOVED: loginToFilebase ---

const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();
const IPNS_CACHE_TTL = 5 * 60 * 1000;

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
        const tId = setTimeout(() => ctrl.abort(), 10000);
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
        console.error(`IPNS resolve ${ipnsKey} failed. Errors: ${msgs}`);
        throw new Error(`Could not resolve ${ipnsKey}.`);
    }
}

// resolveIpns returns a value
export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    const cached = ipnsResolutionCache.get(ipnsIdentifier); if (cached && (Date.now() - cached.timestamp < IPNS_CACHE_TTL)) return cached.cid;
    const session = getSession();
    // --- REMOVED: Filebase API check ---
    let keyToResolve: string | null = ipnsIdentifier;
    if (session.sessionType === 'kubo' && session.rpcApiUrl && session.resolvedIpnsKey && (ipnsIdentifier === session.ipnsKeyName || ipnsIdentifier === session.resolvedIpnsKey)) { keyToResolve = session.resolvedIpnsKey; try { const res = await fetchKubo(session.rpcApiUrl, '/api/v0/name/resolve', { arg: keyToResolve, nocache: 'true' }); if (res?.Path?.startsWith('/ipfs/')) { const cid = res.Path.replace('/ipfs/', ''); ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() }); ipnsResolutionCache.set(keyToResolve, { cid, timestamp: Date.now() }); return cid; } throw new Error("Kubo invalid path."); } catch (e) { console.warn(`Kubo resolve failed for ${ipnsIdentifier}, falling back.`, e); } }
    // --- REMOVED: Filebase session check ---
    else if (!ipnsIdentifier.startsWith('k51')) { keyToResolve = null; } // Can only resolve Peer IDs via gateway
    if (!keyToResolve) { if (cached) { console.warn(`Could not resolve ${ipnsIdentifier}, returning expired cache.`); return cached.cid; } throw new Error(`Cannot resolve identifier "${ipnsIdentifier}" without a Peer ID.`); }
    try { return await resolveIpnsViaGateways(keyToResolve); } // This now uses the updated function
    catch (e) { if (cached) return cached.cid; throw e; }
}

const PUBLIC_CONTENT_GATEWAYS = [
    { type: 'path', url: 'https://ipfs.io' },
    { type: 'subdomain', url: 'https://{cid}.ipfs.dweb.link' }
] as const;
type ContentGateway = typeof PUBLIC_CONTENT_GATEWAYS[number];

// fetchCidViaGateways returns a value
async function fetchCidViaGateways(cid: string): Promise<any> {
    const isCidV0 = cid.startsWith('Qm');
    const gatewaysToTry = PUBLIC_CONTENT_GATEWAYS.filter(gw => isCidV0 ? gw.type === 'path' : true);
    if (gatewaysToTry.length === 0) throw new Error(`No suitable public gateway found for CID: ${cid}`);

    const promises = gatewaysToTry.map(async (gw: ContentGateway) => {
        let url: string;
        if (gw.type === 'path') url = `${gw.url}/ipfs/${cid}`;
        else url = gw.url.replace('{cid}', cid);
        const ctrl = new AbortController(); const tId = setTimeout(() => ctrl.abort(), 15000);
        try { const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(tId); if (!res.ok) throw new Error(`${url} fail: ${res.status}`); return await res.json(); } catch (e) { clearTimeout(tId); throw e; }
    });
    try { return await Promise.any(promises); } catch (e) { const msgs = e instanceof AggregateError ? e.errors.map(er => er instanceof Error ? er.message : String(er)).join(', ') : (e instanceof Error ? e.message : String(e)); console.error(`Fetch CID ${cid} failed. Errors: ${msgs}`); throw new Error(`Could not fetch CID ${cid}.`); }
}

export async function fetchUserState(cid: string, profileNameHint?: string): Promise<UserState> {
    let aggregatedState: Partial<UserState> = { postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], profile: undefined, updatedAt: 0, };
    let currentCid: string | null = cid; let isHead = true; let chunksProcessed = 0; const maxChunksToFetch = 100;
    console.log(`[fetchUserState] Starting aggregation from head CID: ${cid}`);

    while (currentCid && chunksProcessed < maxChunksToFetch) {
        if (currentCid === DEFAULT_USER_STATE_CID && isHead) { console.log(`[fetchUserState] Hit default CID on head, using profileNameHint: '${profileNameHint}'`); return createEmptyUserState({ name: profileNameHint || "Default User" }); }
        chunksProcessed++; console.log(`[fetchUserState] Processing chunk ${chunksProcessed}, CID: ${currentCid}`);

        try {
            const chunk = await fetchUserStateChunk(currentCid);
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

    return {
        profile: aggregatedState.profile || { name: profileNameHint || 'Unknown User' },
        postCIDs: aggregatedState.postCIDs ?? [],
        follows: Array.from(uniqueFollowsMap.values()),
        likedPostCIDs: aggregatedState.likedPostCIDs ?? [],
        dislikedPostCIDs: aggregatedState.dislikedPostCIDs ?? [],
        updatedAt: aggregatedState.updatedAt || 0,
        extendedUserState: null
    };
}

export async function fetchUserStateChunk(cid: string): Promise<Partial<UserState>> {
    if (cid === DEFAULT_USER_STATE_CID) {
         return { profile: { name: "Default User" }, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null };
    }
    try {
        const data = await fetchPost(cid);
        if (!data) throw new Error(`No data found for CID ${cid}`);
        return data as Partial<UserState>;
    } catch (error) { console.error(`Failed to fetch UserState chunk ${cid}:`, error); return {}; }
}

// fetchPost returns a value
export async function fetchPost(cid: string): Promise<Post | UserState | any > {
    const session = getSession(); if (session.sessionType === 'kubo' && session.rpcApiUrl) { try { return await fetchKubo(session.rpcApiUrl, '/api/v0/cat', { arg: cid }); } catch (e) { console.warn(`Kubo fetch ${cid} failed, falling back.`, e); } }
    try { return await fetchCidViaGateways(cid); } catch (e) { throw e; }
}
// --- REMOVED: updateIpnsRecord ---
// invalidateIpnsCache returns void (implicitly)
export const invalidateIpnsCache = () => { console.log("Invalidating IPNS cache."); ipnsResolutionCache.clear(); };

export const getMediaUrl = (cid: string): string => {
    if (!cid || cid.startsWith('blob:')) return cid;
    const session = getSession();
    if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        try { const rpcUrl = new URL(session.rpcApiUrl); return `${rpcUrl.protocol}//${rpcUrl.hostname}:8080/ipfs/${cid}`; } catch (e) { console.warn("Bad Kubo URL.", e); }
    }
    const isCidV0 = cid.startsWith('Qm');
    if (isCidV0) return `${PUBLIC_CONTENT_GATEWAYS[0].url}/ipfs/${cid}`;
    const gw = PUBLIC_CONTENT_GATEWAYS[1]; return gw.url.replace('{cid}', cid);
};

