// src/lib/ipfs.ts
// --- FIX: Remove unused UserProfile import ---
import { UserState, Post, Session } from '../types';
import { getCookie, setCookie, eraseCookie } from '../lib/utils';
// --- FIX 1: Add S3Client import ---
import { S3Client } from "@aws-sdk/client-s3";
// --- ADD TOAST IMPORT ---
import toast from 'react-hot-toast';

// --- FIX: Use a cookie prefix instead of a static name ---
const SESSION_COOKIE_PREFIX = 'dSocialSession';
// --- End Fix ---

const DEFAULT_USER_STATE_CID = "QmRh23Gd4AJLBH82CN9wz2MAe6sY95AqDSDBMFW1qnheny"; // Used

// --- NEW HELPER: Get user-specific cookie name ---
/**
 * Gets the session cookie name based on the user label.
 * --- FIX: Reads from sessionStorage (tab-specific) ---
 */
function getDynamicSessionCookieName(label?: string | null): string | null {
    const userLabel = label || sessionStorage.getItem("currentUserLabel"); // <-- FIX: Use sessionStorage
    if (!userLabel) {
        console.warn("getDynamicSessionCookieName: No user label found.");
        return null;
    }
    // Simple sanitization to prevent invalid cookie characters (e.g., spaces, semicolons)
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${SESSION_COOKIE_PREFIX}_${sanitizedLabel}`;
}
// --- End New Helper ---


// --- Filebase API Functions ---

async function getIpnsKeyFromFilebaseLabel(label: string, apiKey: string, apiSecret: string): Promise<string> {
    console.log(`Attempting Filebase API lookup for label: ${label}`);
    const auth = btoa(`${apiKey}:${apiSecret}`);
    const url = `https://api.filebase.io/v1/names/${label}`;
    try {
        // --- FIX 6: Use 'Bearer' instead of 'Basic' ---
        const response = await fetch(url, { headers: { 'Authorization': `Bearer ${auth}` } });
        if (!response.ok) throw new Error(`Filebase API error (${response.status}) fetching name: ${await response.text()}`);
        const data = await response.json();
        if (!data?.network_key) throw new Error("IPNS Key (network_key) not found.");
        console.log(`Resolved Filebase label ${label} to IPNS Key ${data.network_key}`);
        return data.network_key;
    } catch (error) { console.error(`Failed get IPNS Key for ${label}:`, error); throw error; }
}

export async function resolveCidViaFilebaseApi(label: string, apiKey: string, apiSecret: string): Promise<string> {
    console.log(`Attempting Filebase API CID resolution for label: ${label}`);
    const auth = btoa(`${apiKey}:${apiSecret}`);
    const url = `https://api.filebase.io/v1/names/${label}`;
    try {
        // --- FIX 6: Use 'Bearer' instead of 'Basic' ---
        const response = await fetch(url, { headers: { 'Authorization': `Bearer ${auth}` } });
        if (!response.ok) throw new Error(`Filebase API error (${response.status}) resolving CID: ${await response.text()}`);
        const data = await response.json();
        if (!data?.cid) throw new Error("CID not found for label.");
        console.log(`Resolved Filebase label ${label} to CID ${data.cid} via API.`);
        return data.cid;
    } catch (error) { console.error(`Failed resolve CID for ${label}:`, error); throw error; }
}

async function updateIpnsRecordViaFilebaseApi(label: string, cid: string, apiKey: string, apiSecret: string): Promise<boolean> {
    console.log(`Attempting Filebase API IPNS update for ${label} to ${cid}`);
    const auth = btoa(`${apiKey}:${apiSecret}`);
    const url = `https://api.filebase.io/v1/names/${label}`;
    const body = JSON.stringify({ cid });
    try {
        // --- FIX 6: Use 'Bearer' instead of 'Basic' ---
        const response = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${auth}`, 'Content-Type': 'application/json' }, body });
        if (!response.ok) throw new Error(`Failed update IPNS via Filebase API (${response.status}): ${await response.text()}`);
        console.log(`Successfully updated Filebase IPNS for ${label} to ${cid} via API.`);
        return true;
    } catch (error) { console.error(`Error updating Filebase IPNS for ${label}:`, error); throw error; }
}
// --- End Filebase API ---

// --- FIX: Export createEmptyUserState ---
export const createEmptyUserState = (profile: { name: string }): UserState => ({
    profile: profile, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null,
});

// --- FIX 2: S3 Client Helper ---

/**
 * Creates an S3Client instance for Filebase.
 */
function createFilebaseS3Client(apiKey: string, apiSecret: string): S3Client {
  return new S3Client({
    endpoint: "https://s3.filebase.com",
    region: "us-east-1", // This is standard for Filebase
    credentials: {
      accessKeyId: apiKey,
      secretAccessKey: apiSecret,
    },
  });
}

// --- Session Management ---

/**
 * Loads the current session from the cookie.
 * FIX 3: This now re-creates the S3 client if the session is Filebase.
 * --- FIX: This now uses a dynamic cookie name based on sessionStorage ---
 */
export function getSession(): Session {
    // --- FIX: Use dynamic cookie name ---
    const cookieName = getDynamicSessionCookieName(); // <-- Reads from sessionStorage
    if (!cookieName) {
        console.log("[getSession] No dynamic cookie name, returning null session.");
        return { sessionType: null };
    }
    // --- End Fix ---

    const sessionCookie = loadSessionCookie<Session>(cookieName); // Modified

    if (sessionCookie?.sessionType === 'filebase' &&
        sessionCookie.bucketName &&
        sessionCookie.ipnsNameLabel &&
        sessionCookie.resolvedIpnsKey &&
        sessionCookie.filebaseKey && // Check for credentials
        sessionCookie.filebaseSecret) // Check for credentials
    {
        // Re-create the S3 client from stored credentials
        const s3Client = createFilebaseS3Client(sessionCookie.filebaseKey, sessionCookie.filebaseSecret);

        // Return the full session, including the newly created client
        return { ...sessionCookie, s3Client: s3Client };
    }

    if (sessionCookie?.sessionType === 'kubo' && sessionCookie.rpcApiUrl && sessionCookie.ipnsKeyName && sessionCookie.resolvedIpnsKey) {
        return sessionCookie;
    }

    console.log(`[getSession] No valid session found in cookie '${cookieName}'.`);
    return { sessionType: null };
 }

// Fix: saveSessionCookie only takes 2 args, days is internal default
export function saveSessionCookie<T>(name: string, value: T): void {
    const days = 7; // Internal default
    try {
        const stringValue = JSON.stringify(value);
        setCookie(name, stringValue, days);
    } catch (e) { console.error("Failed save cookie:", e); }
}
export function loadSessionCookie<T>(name: string): T | null {
  const cookieValue = getCookie(name); if (cookieValue) { try { return JSON.parse(cookieValue) as T; } catch (e) { console.error("Failed parse cookie:", e); eraseCookie(name); return null; } } return null;
}

// --- FIX: logoutSession now uses dynamic cookie name and sessionStorage ---
export function logoutSession(): void {
    const cookieName = getDynamicSessionCookieName(); // Get name *before* removing label
    if (cookieName) {
        eraseCookie(cookieName);
        console.log(`[logoutSession] Erased cookie: ${cookieName}`);
    } else {
        console.warn("[logoutSession] No cookie name found to erase.");
    }
    sessionStorage.removeItem("currentUserLabel"); // <-- FIX: Use sessionStorage
}
// --- End Fix ---

// --- FIX: loginToKubo now fetches state and returns { session, state, cid } ---
export async function loginToKubo(apiUrl: string, keyName: string): Promise<{ session: Session, state: UserState, cid: string }> {
     try { 
         await fetchKubo(apiUrl, '/api/v0/id'); 
         const keys = await fetchKubo(apiUrl, '/api/v0/key/list'); 
         const keyInfo = Array.isArray(keys?.Keys) ? keys.Keys.find((k: any) => k.Name === keyName) : undefined; 
         if (!keyInfo?.Id) throw new Error(`IPNS key "${keyName}" not found.`); 
         
         const resolvedIpnsKey = keyInfo.Id; 
         const session: Session = { sessionType: 'kubo', rpcApiUrl: apiUrl, ipnsKeyName: keyName, resolvedIpnsKey }; 

         // --- FIX: Use dynamic cookie name ---
         // Note: sessionStorage is set in useAuth, but we pass keyName to the helper
         const cookieName = getDynamicSessionCookieName(keyName);
         if (!cookieName) throw new Error("Could not create session cookie name.");
         saveSessionCookie(cookieName, session); 
         // --- End Fix ---

         // Fetch the user state
         let cid = '';
         let state: UserState;
         try {
             cid = await resolveIpns(resolvedIpnsKey);
             // --- FIX: Pass profile name hint ---
             state = await fetchUserState(cid, keyName);
             // --- End Fix ---
         } catch (e) {
             console.warn(`Could not resolve initial state for ${keyName}, using default.`);
             cid = DEFAULT_USER_STATE_CID;
             state = createEmptyUserState({ name: keyName });
         }

         return { session, state, cid };

     } catch (error) { 
         console.error("Kubo login failed:", error); 
         logoutSession(); // This will clear the label and any old cookie
         throw error; 
     }
}

/**
 * Logs into Filebase using a 3-part credential string.
 * --- FIX: loginToFilebase now fetches state and returns { session, state, cid } ---
 */
export async function loginToFilebase(nameLabel: string, bucketCredential?: string): Promise<{ session: Session, state: UserState, cid: string }> {
     if (!bucketCredential) throw new Error("Filebase credential required.");

     let decoded: string;
     try {
        decoded = atob(bucketCredential);
     } catch (e) {
        throw new Error("Invalid Bucket Credential. String is not valid Base64.");
     }

     const parts = decoded.split(':');
     if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
         throw new Error("Invalid decoded credential. Expected 'AccessKeyID:SecretAccessKey:BucketName'");
     }
     const [apiKey, apiSecret, bucketName] = parts;

     const s3Client = createFilebaseS3Client(apiKey, apiSecret);
     const resolvedIpnsKey = await getIpnsKeyFromFilebaseLabel(nameLabel, apiKey, apiSecret);

     const sessionToSave: Session = {
        sessionType: 'filebase',
        ipnsNameLabel: nameLabel,
        bucketName: bucketName,
        resolvedIpnsKey: resolvedIpnsKey,
        filebaseKey: apiKey,
        filebaseSecret: apiSecret
     };

     // --- FIX: Use dynamic cookie name ---
     // Note: sessionStorage is set in useAuth, but we pass nameLabel to the helper
     const cookieName = getDynamicSessionCookieName(nameLabel);
     if (!cookieName) throw new Error("Could not create session cookie name.");
     saveSessionCookie(cookieName, sessionToSave);
     // --- End Fix ---
     
     const session = { ...sessionToSave, s3Client: s3Client };

     // Fetch the user state
     let cid = '';
     let state: UserState;
     try {
         cid = await resolveIpns(nameLabel); // Use the label for the first resolve
         // --- FIX: Pass profile name hint ---
         state = await fetchUserState(cid, nameLabel);
         // --- End Fix ---
     } catch (e) {
         console.warn(`Could not resolve initial state for ${nameLabel}, using default.`);
         cid = DEFAULT_USER_STATE_CID;
         state = createEmptyUserState({ name: nameLabel });
     }

     return { session, state, cid };
}


// --- IPFS/IPNS Operations ---

// fetchKubo uses its parameters
async function fetchKubo(apiUrl: string, path: string, params?: Record<string, string>, body?: FormData | string): Promise<any> {
    const url = new URL(`${apiUrl}${path}`); if (params) Object.entries(params).forEach(([k, v]) => { url.searchParams.append(k, v); }); try { const response = await fetch(url.toString(), { method: "POST", body: body }); if (!response.ok) { const txt = await response.text(); let jsn; try { jsn = JSON.parse(txt); } catch { /* ignore */ } const msg = jsn?.Message || txt || `HTTP ${response.status}`; if (path === '/api/v0/name/resolve' && msg.includes('could not resolve name')) throw new Error(`Kubo IPNS failed: ${msg}`); throw new Error(`Kubo RPC error ${path}: ${msg}`); } if (path === "/api/v0/add") { const txt = await response.text(); const lines = txt.trim().split('\n'); for (let i = lines.length - 1; i >= 0; i--) { try { const p = JSON.parse(lines[i]); if (p?.Hash) return p; } catch { /* ignore */ } } throw new Error("Bad 'add' response."); } if (path === "/api/v0/cat") { try { return await response.json(); } catch (e) { throw new Error("Bad 'cat' response."); } } if (["/api/v0/name/resolve", "/api/v0/name/publish", "/api/v0/key/list", "/api/v0/id"].includes(path)) return response.json(); return response.json(); } catch (e) { console.error(`Kubo call failed: ${path}`, e); throw e; }
}
// uploadJsonToIpfs uses its parameters
export async function uploadJsonToIpfs(apiUrl: string, data: any): Promise<string> {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); const fd = new FormData(); fd.append('file', blob, `data-${Date.now()}.json`); const res = await fetchKubo(apiUrl, '/api/v0/add', { pin: 'true', 'cid-version': '1' }, fd); if (!res?.Hash) throw new Error("Upload failed."); return res.Hash;
}
// publishToIpns uses its parameters
export async function publishToIpns(apiUrl: string, cid: string, keyName: string): Promise<string> {
    const res = await fetchKubo(apiUrl, '/api/v0/name/publish', { arg: `/ipfs/${cid}`, key: keyName, lifetime: '720h' }); if (!res?.Name) throw new Error("Publish failed."); return res.Name;
}

const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();
const IPNS_CACHE_TTL = 5 * 60 * 1000;

// --- FIX 10: Use gateway objects and only ipfs.io and dweb.link ---
const PUBLIC_IPNS_GATEWAYS = [
    { type: 'path', url: 'https://ipfs.io' },
    { type: 'subdomain', url: 'https://{ipnsKey}.ipns.dweb.link' }
] as const;
type IpnsGateway = typeof PUBLIC_IPNS_GATEWAYS[number];

// --- FIX 16: More robust header checking ---
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
            // --- FIX 21: Add cache: 'no-store' to bypass browser cache ---
            const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(tId);

            // Allow OK (200) or Redirect (302) statuses
            if (!res.ok && res.status !== 302) {
                throw new Error(`${url} failed: ${res.status}`);
            }

            // 1. Check for x-ipfs-roots (preferred, used by dweb.link)
            const rootsHeader = res.headers.get('x-ipfs-roots');
            if (rootsHeader) {
                return rootsHeader;
            }

            // 2. Check for location header (used by ipfs.io for redirects)
            const locationHeader = res.headers.get('location');
            if (locationHeader?.startsWith('/ipfs/')) {
                return locationHeader.replace('/ipfs/', '');
            }

            // 3. Check for x-ipfs-path (fallback)
            const pathHeader = res.headers.get('x-ipfs-path');
            if (pathHeader?.startsWith('/ipfs/')) {
                return pathHeader.replace('/ipfs/', '');
            }

            throw new Error(`${url} no valid header (roots, location, or path).`);
        } catch (e) {
            clearTimeout(tId);
            throw e;
        }
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
// --- End Fix 16 & 21 ---

// resolveIpns returns a value
export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    const cached = ipnsResolutionCache.get(ipnsIdentifier); if (cached && (Date.now() - cached.timestamp < IPNS_CACHE_TTL)) return cached.cid;
    const session = getSession();
    if (session.sessionType === 'filebase' && session.ipnsNameLabel === ipnsIdentifier && session.filebaseKey && session.filebaseSecret) { try { const cid = await resolveCidViaFilebaseApi(ipnsIdentifier, session.filebaseKey, session.filebaseSecret); ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() }); if (session.resolvedIpnsKey) ipnsResolutionCache.set(session.resolvedIpnsKey, { cid, timestamp: Date.now() }); return cid; } catch (e) { console.warn(`Filebase API failed for ${ipnsIdentifier}, falling back.`, e); } }
    let keyToResolve: string | null = ipnsIdentifier;
    if (session.sessionType === 'kubo' && session.rpcApiUrl && session.resolvedIpnsKey && (ipnsIdentifier === session.ipnsKeyName || ipnsIdentifier === session.resolvedIpnsKey)) { keyToResolve = session.resolvedIpnsKey; try { const res = await fetchKubo(session.rpcApiUrl, '/api/v0/name/resolve', { arg: keyToResolve, nocache: 'true' }); if (res?.Path?.startsWith('/ipfs/')) { const cid = res.Path.replace('/ipfs/', ''); ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() }); ipnsResolutionCache.set(keyToResolve, { cid, timestamp: Date.now() }); return cid; } throw new Error("Kubo invalid path."); } catch (e) { console.warn(`Kubo resolve failed for ${ipnsIdentifier}, falling back.`, e); } }
    else if (session.sessionType === 'filebase' && ipnsIdentifier === session.ipnsNameLabel && session.resolvedIpnsKey) { keyToResolve = session.resolvedIpnsKey; }
    else if (!ipnsIdentifier.startsWith('k51')) { keyToResolve = null; }
    if (!keyToResolve) { if (cached) { console.warn(`Could not resolve ${ipnsIdentifier}, returning expired cache.`); return cached.cid; } throw new Error(`Cannot resolve identifier "${ipnsIdentifier}" without a Peer ID.`); }
    try { return await resolveIpnsViaGateways(keyToResolve); } // This now uses the updated function
    catch (e) { if (cached) return cached.cid; throw e; }
}

// --- FIX 17: Update PUBLIC_CONTENT_GATEWAYS to use object structure ---
const PUBLIC_CONTENT_GATEWAYS = [
    { type: 'path', url: 'https://ipfs.io' },
    { type: 'subdomain', url: 'https://{cid}.ipfs.dweb.link' }
] as const;
type ContentGateway = typeof PUBLIC_CONTENT_GATEWAYS[number];
// --- End Fix 17 ---

// fetchCidViaGateways returns a value
async function fetchCidViaGateways(cid: string): Promise<any> {
    // --- FIX 20: Add CID v0/v1 logic to content fetching ---
    const isCidV0 = cid.startsWith('Qm');

    const gatewaysToTry = PUBLIC_CONTENT_GATEWAYS
        .filter(gw => {
            // If CID is v0, ONLY use 'path' gateways.
            if (isCidV0) {
                return gw.type === 'path';
            }
            // If CID is v1, we can use both.
            return true;
        });

    if (gatewaysToTry.length === 0) {
        // This case should only happen if a v0 CID is present and no 'path' gateways are defined.
        throw new Error(`No suitable public gateway found for CID: ${cid}`);
    }
    // --- End Fix 20 ---

    const promises = gatewaysToTry.map(async (gw: ContentGateway) => { // Use gatewaysToTry
        let url: string;
        if (gw.type === 'path') {
            url = `${gw.url}/ipfs/${cid}`;
        } else {
            // We only get here if CID is v1 (or user provided a v1 CID), so this is safe.
            url = gw.url.replace('{cid}', cid);
        }

        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 15000);
        try {
            const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(tId);
            if (!res.ok) throw new Error(`${url} fail: ${res.status}`);
            return await res.json();
        } catch (e) {
            clearTimeout(tId);
            throw e;
        }
    });

    try { return await Promise.any(promises); } catch (e) {
        const msgs = e instanceof AggregateError ? e.errors.map(er => er instanceof Error ? er.message : String(er)).join(', ') : (e instanceof Error ? e.message : String(e));
        console.error(`Fetch CID ${cid} failed. Errors: ${msgs}`);
        throw new Error(`Could not fetch CID ${cid}.`);
    }
}

// --- FIX: fetchUserState with detailed logging and robust error handling ---
// --- FIX: Added profileNameHint argument ---
export async function fetchUserState(cid: string, profileNameHint?: string): Promise<UserState> {
    let aggregatedState: Partial<UserState> = {
        postCIDs: [],
        follows: [],
        likedPostCIDs: [],
        dislikedPostCIDs: [],
        profile: undefined,
        updatedAt: 0,
    };

    let currentCid: string | null = cid;
    let isHead = true; 
    let chunksProcessed = 0; 
    const maxChunksToFetch = 100;

    console.log(`[fetchUserState] Starting aggregation from head CID: ${cid}`);

    while (currentCid && chunksProcessed < maxChunksToFetch) {
        // --- FIX: Use profileNameHint if we hit the default CID ---
        if (currentCid === DEFAULT_USER_STATE_CID && isHead) {
            console.log(`[fetchUserState] Hit default CID on head, using profileNameHint: '${profileNameHint}'`);
            return createEmptyUserState({ name: profileNameHint || "Default User" }); 
        }
        // --- End Fix ---

        chunksProcessed++;
        console.log(`[fetchUserState] Processing chunk ${chunksProcessed}, CID: ${currentCid}`);

        try {
            // *** 🔑 CHANGE 1: Use the correct low-level fetch function ***
            // Assuming `fetchUserStateChunk(cid)` exists and fetches a UserState object,
            // or if not, use the existing post-fetcher which needs renaming/correction.
            // For now, let's rename the call for clarity:
            const chunk = await fetchUserStateChunk(currentCid); 
            // -----------------------------------------------------------------

            // Validate this chunk (now strongly typed as Partial<UserState>)
            if (!chunk || (isHead && !chunk.profile)) {
                console.error(`[fetchUserState] Fetched data for chunk ${chunksProcessed} (CID: ${currentCid}) is not a valid UserState chunk. Stopping traversal.`);
                if (isHead) {
                     console.error(`[fetchUserState] Head chunk ${currentCid} failed validation.`);
                     throw new Error(`Head state chunk ${currentCid} is invalid or missing profile.`);
                } else {
                     // *** FIX: Changed toast.error from the prompt to toast.warn/error for consistency ***
                     toast.error(`Could not load older state (CID: ${currentCid.substring(0, 8)}...). Some history may be missing.`);
                     currentCid = null;
                     continue;
                }
            }

            // const chunk = data as Partial<UserState>; // Removed unnecessary casting
            console.log(`[fetchUserState] Successfully fetched and validated chunk ${chunksProcessed}`, chunk); 

            if (isHead) {
                // Keep the head profile and timestamp
                aggregatedState.profile = chunk.profile;
                aggregatedState.updatedAt = typeof chunk.updatedAt === 'number' ? chunk.updatedAt : 0;
                isHead = false;
            }

            // Append arrays, ensuring they exist and are arrays
            aggregatedState.postCIDs = [...(aggregatedState.postCIDs ?? []), ...(Array.isArray(chunk.postCIDs) ? chunk.postCIDs : [])];
            aggregatedState.follows = [...(aggregatedState.follows ?? []), ...(Array.isArray(chunk.follows) ? chunk.follows : [])];
            aggregatedState.likedPostCIDs = [...(aggregatedState.likedPostCIDs ?? []), ...(Array.isArray(chunk.likedPostCIDs) ? chunk.likedPostCIDs : [])];
            aggregatedState.dislikedPostCIDs = [...(aggregatedState.dislikedPostCIDs ?? []), ...(Array.isArray(chunk.dislikedPostCIDs) ? chunk.dislikedPostCIDs : [])];

            // *** 🔑 CHANGE 2: Follow the chain using extendedUserState ***
            currentCid = chunk.extendedUserState || null;
            // ----------------------------------------------------------
            
            console.log(`[fetchUserState] Next chunk CID: ${currentCid}`);

        } catch (error) { // Catch fetch errors 
            console.error(`[fetchUserState] Failed to fetch or process chunk ${chunksProcessed} (CID: ${currentCid}):`, error);
            const shortCid = currentCid ? currentCid.substring(0, 8) : 'unknown';

            if (isHead) {
                 toast.error(`Failed to load primary user state (CID: ${shortCid}...).`);
                 throw new Error(`Failed to fetch head state chunk ${currentCid}: ${error instanceof Error ? error.message : String(error)}`);
            } else {
                 toast.error(`Failed to load part of the state history (CID: ${shortCid}...).`);
                 currentCid = null; 
            }
        }
    }

    if (chunksProcessed >= maxChunksToFetch) {
        console.warn(`[fetchUserState] Stopped aggregation after reaching max chunks limit (${maxChunksToFetch}). State might be incomplete.`);
        // --- FIX: Change toast.warn to toast.error ---
        toast.error("Reached maximum state history depth. Older data may be missing.");
        // --- End Fix ---
    }

    console.log(`[fetchUserState] Aggregation finished after ${chunksProcessed} chunks. Final state:`, aggregatedState); // Debug log

    // Now, normalize the final aggregated state (ensure all arrays exist, profile defaults)
    return {
        // --- FIX: Use hint as fallback if aggregation resulted in no profile ---
        profile: aggregatedState.profile || { name: profileNameHint || 'Unknown User' },
        // --- End Fix ---
        postCIDs: aggregatedState.postCIDs ?? [],
        follows: aggregatedState.follows ?? [],
        likedPostCIDs: aggregatedState.likedPostCIDs ?? [],
        dislikedPostCIDs: aggregatedState.dislikedPostCIDs ?? [],
        updatedAt: aggregatedState.updatedAt || 0,
        extendedUserState: null // The final aggregated object has no extended state
    };
}
// --- End Fix ---


// --- NEW FUNCTION: fetchUserStateChunk ---
/**
 * Fetches only a single UserState object (chunk) without traversing the linked list.
 * Used for quickly getting the 'follows' array when seeding the explore feed.
 */
export async function fetchUserStateChunk(cid: string): Promise<Partial<UserState>> {
    if (cid === DEFAULT_USER_STATE_CID) {
         // --- FIX: Return the *actual* default state, not a new one ---
         // The caller (`fetchUserState`) will now handle the profile logic.
         return {
            profile: { name: "Default User" },
            postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [],
            updatedAt: 0, extendedUserState: null
         };
         // --- End Fix ---
    }
    try {
        const data = await fetchPost(cid); // fetchPost handles gateways/kubo
        if (!data) { // Basic check, could be more robust
            throw new Error(`No data found for CID ${cid}`);
        }
        // Return as partial, expecting the caller to handle missing fields
        return data as Partial<UserState>;
    } catch (error) {
         console.error(`Failed to fetch UserState chunk ${cid}:`, error);
         // Return an empty object or throw, depending on desired error handling
         return {}; // Return empty on error
    }
}
// --- End NEW FUNCTION ---


// fetchPost returns a value
export async function fetchPost(cid: string): Promise<Post | UserState | any > {
    const session = getSession(); if (session.sessionType === 'kubo' && session.rpcApiUrl) { try { return await fetchKubo(session.rpcApiUrl, '/api/v0/cat', { arg: cid }); } catch (e) { console.warn(`Kubo fetch ${cid} failed, falling back.`, e); } }
    try {
        // This will now use the CID-version-aware logic
        return await fetchCidViaGateways(cid);
    } catch (e) {
        throw e;
    }
}
// updateIpnsRecord returns a value
export async function updateIpnsRecord(nameLabel: string, cid: string): Promise<boolean> {
    const session = getSession(); if (session.sessionType === 'filebase' && session.filebaseKey && session.filebaseSecret) { return updateIpnsRecordViaFilebaseApi(nameLabel, cid, session.filebaseKey, session.filebaseSecret); } else { throw new Error("Cannot update Filebase IPNS without credentials."); }
}
// invalidateIpnsCache returns void (implicitly)
export const invalidateIpnsCache = () => { console.log("Invalidating IPNS cache."); ipnsResolutionCache.clear(); };

// --- FIX 19: Update getMediaUrl to use new gateway logic ---
export const getMediaUrl = (cid: string): string => {
    if (!cid || cid.startsWith('blob:')) return cid;
    const session = getSession();
    if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        try {
            const rpcUrl = new URL(session.rpcApiUrl);
            return `${rpcUrl.protocol}//${rpcUrl.hostname}:8080/ipfs/${cid}`;
        } catch (e) { console.warn("Bad Kubo URL.", e); }
    }

    const isCidV0 = cid.startsWith('Qm');

    if (isCidV0) {
        // v0 CIDs *must* use path-style. Use ipfs.io (index 0).
        return `${PUBLIC_CONTENT_GATEWAYS[0].url}/ipfs/${cid}`;
    }

    // For v1 CIDs (bafy...), prefer subdomain (index 1).
    const gw = PUBLIC_CONTENT_GATEWAYS[1]; // { type: 'subdomain', url: 'https://{cid}.ipfs.dweb.link' }
    return gw.url.replace('{cid}', cid);
};
// --- End Fix 19 ---