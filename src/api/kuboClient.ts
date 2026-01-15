// fileName: src/api/kuboClient.ts
import { 
    KUBO_RPC_TIMEOUT_MS, 
    KUBO_PUBLISH_TIMEOUT_MS, 
    PUBLIC_IPNS_GATEWAYS, 
    PUBLIC_CONTENT_GATEWAYS, 
    GATEWAY_TIMEOUT_MS,
    IPNS_RESOLVE_TIMEOUT_MS 
} from '../constants';

// --- Types ---
export interface KuboAuth {
    username?: string;
    password?: string;
}

// --- Helper: Mutex for Heavy Operations ---
class Mutex {
    private mutex = Promise.resolve();

    lock(): PromiseLike<() => void> {
        let begin: (unlock: () => void) => void = () => {};

        this.mutex = this.mutex.then(() => {
            return new Promise(begin);
        });

        return new Promise(res => {
            begin = res;
        });
    }

    async dispatch<T>(fn: (() => T) | (() => PromiseLike<T>)): Promise<T> {
        const unlock = await this.lock();
        try {
            return await Promise.resolve(fn());
        } finally {
            unlock();
        }
    }
}

// Global lock for heavy writes
const heavyRpcLock = new Mutex();

// --- Helper: Multibase Encoding ---
export function toMultibase(str: string): string {
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

// --- Helper: Auth Headers ---
export const getAuthHeaders = (auth?: KuboAuth): Headers => {
    const headers = new Headers();
    if (auth?.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers.append('Authorization', `Basic ${credentials}`);
    }
    return headers;
};

// --- Helper: Sleep ---
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- Core RPC Fetcher with Retry ---
export async function fetchKubo(
    apiUrl: string,
    path: string,
    params?: Record<string, string>,
    body?: FormData | string,
    auth?: KuboAuth,
    timeoutMs: number = KUBO_RPC_TIMEOUT_MS,
    retries: number = 3
): Promise<any> {
    // --- DEBUG: TRACE RPC ORIGIN ---
    if (path === '/api/v0/cat' || path === '/api/v0/name/resolve') {
    }
    // ------------------------------

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
    if (params) {
         Object.entries(params).forEach(([k, v]) => { url.searchParams.append(k, v); });
    }

    const headers = getAuthHeaders(auth);
    let fetchBody: BodyInit | null = null;
    
    if (body instanceof FormData) {
        fetchBody = body;
    } else if (typeof body === 'string') {
        fetchBody = body;
        headers.append('Content-Type', 'application/json');
    }

    const heavyOps = [
        '/api/v0/pin/add',
        '/api/v0/block/put',
        '/api/v0/name/publish',
        '/api/v0/add'
    ];
    const isHeavy = heavyOps.includes(actualPath);

    const performRequest = async () => {
        let lastError: any;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => {
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
                    if (response.status >= 500 || response.status === 429) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const txt = await response.text();
                    let jsn; try { jsn = JSON.parse(txt); } catch { /* ignore */ }
                    const msg = jsn?.Message || txt || `HTTP ${response.status}`;
                    if (actualPath === '/api/v0/name/resolve' && msg.includes('could not resolve name')) {
                         throw new Error(`Kubo IPNS failed: ${msg}`);
                    }
                    throw new Error(`Kubo RPC error ${actualPath}: ${msg}`);
                }

                if (actualPath === "/api/v0/add") {
                    const txt = await response.text();
                    if (!txt || txt.trim() === '') throw new Error("Bad 'add' response: Empty body.");
                    const lines = txt.trim().split('\n');
                    for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                            const p = JSON.parse(lines[i]);
                            if (p?.Hash) return p; 
                        } catch (e) { /* ignore */ }
                    }
                    throw new Error("Bad 'add' response: No valid JSON object with 'Hash' found.");
                }

                if (actualPath === "/api/v0/cat") {
                    try { return await response.json(); } catch (e) { throw new Error("Bad 'cat' response."); }
                }

                const genericPaths = [
                    "/api/v0/name/resolve", "/api/v0/name/publish", "/api/v0/key/list", 
                    "/api/v0/id", "/api/v0/key/gen", "/api/v0/pin/rm", "/api/v0/files/rm", 
                    "/api/v0/repo/gc", "/api/v0/files/cp", "/api/v0/pubsub/pub",
                    "/api/v0/pin/add", "/api/v0/block/put"
                ];

                if (genericPaths.includes(actualPath)) {
                     if (['/api/v0/files/cp', '/api/v0/pubsub/pub', '/api/v0/pin/add'].includes(actualPath)) {
                         const text = await response.text();
                         try { return text ? JSON.parse(text) : { Success: true }; } 
                         catch { return { Success: true }; }
                     }
                     return response.json();
                }
                return response.json();

            } catch (e) {
                clearTimeout(timeoutId);
                lastError = e;
                const isTimeout = e instanceof Error && e.name === 'AbortError';
                
                if (attempt === retries) break;
                
                const delay = 500 * Math.pow(2, attempt);
                
                if (!isHeavy || attempt > 0) {
                    console.warn(`[fetchKubo] Failed ${actualPath} (Attempt ${attempt + 1}/${retries + 1}). Retrying in ${delay}ms...`, isTimeout ? "Timeout" : e);
                }
                await sleep(delay);
            }
        }

        if (lastError instanceof Error && lastError.name === 'AbortError') {
             throw new Error(`Kubo RPC error ${actualPath}: Request timed out after ${timeoutMs/1000}s.`);
        }
        throw lastError;
    };

    if (isHeavy) {
        return heavyRpcLock.dispatch(performRequest);
    } else {
        return performRequest();
    }
}

// --- Generic IPFS Actions ---

export async function uploadJsonToIpfs(apiUrl: string, data: any, auth?: KuboAuth): Promise<string> {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); 
    const fd = new FormData(); 
    fd.append('file', blob, `data-${Date.now()}.json`);
    
    const res = await fetchKubo(apiUrl, '/api/v0/add', { pin: 'true', 'cid-version': '1' }, fd, auth, 60000, 3);
    if (!res?.Hash) throw new Error("Upload failed (JSON)."); 
    return res.Hash;
}

export async function seedBlock(apiUrl: string, blob: Blob, auth?: KuboAuth): Promise<string> {
    const fd = new FormData();
    fd.append('file', blob);

    const res = await fetchKubo(
        apiUrl, 
        '/api/v0/block/put', 
        { 'cid-codec': 'raw', 'mhtype': 'sha2-256', 'pin': 'true' }, 
        fd, 
        auth, 
        60000, 
        3
    );
    
    if (!res?.Key) throw new Error("Block put failed.");
    return res.Key;
}

export async function publishToIpns(
    apiUrl: string, 
    cid: string, 
    keyName: string, 
    auth?: KuboAuth,
    timeout: number = KUBO_PUBLISH_TIMEOUT_MS 
): Promise<string> {
    const res = await fetchKubo(
        apiUrl, 
        '/api/v0/name/publish', 
        { arg: `/ipfs/${cid}`, key: keyName, lifetime: '720h', resolve: 'false' }, 
        undefined, 
        auth,
        timeout,
        2 
    );
    if (!res?.Name) throw new Error("Publish failed (IPNS)."); 
    return res.Name;
}

// --- STAGGERED GATEWAY FETCHING (UPDATED FOR STRING ARRAYS) ---

async function staggeredGatewayFetch(
    resourceId: string, 
    gateways: readonly string[], // Changed from object array to string array
    isIpns: boolean,
    timeoutMs: number = GATEWAY_TIMEOUT_MS
): Promise<Response> {
    const masterController = new AbortController(); 
    const STAGGER_DELAY_MS = 2500; 
    
    return new Promise((resolve, reject) => {
        let activeRequests = 0;
        let rejectedCount = 0;
        let isResolved = false;

        const tryGateway = async (index: number) => {
            if (isResolved || index >= gateways.length) return;

            const gw = gateways[index];
            activeRequests++;

            // Handle Subdomain vs Path Gateways
            let url = '';
            if (gw.includes('{cid}')) {
                 // Subdomain style
                 url = gw.replace('{cid}', resourceId);
            } else {
                 // Path style: append ID
                 url = `${gw}${resourceId}`;
            }

            const requestController = new AbortController();
            const timeoutId = setTimeout(() => requestController.abort(), timeoutMs);

            const onMasterAbort = () => requestController.abort();
            masterController.signal.addEventListener('abort', onMasterAbort);

            try {
                // Use 'no-store' for IPNS to prevent stale cache, 'default' for IPFS
                const cachePolicy = isIpns ? 'no-store' : 'default';

                const response = await fetch(url, { 
                    signal: requestController.signal,
                    cache: cachePolicy 
                });
                
                clearTimeout(timeoutId);

                if (response.ok) {
                    if (!isResolved) {
                        isResolved = true;
                        masterController.abort();
                        resolve(response);
                    }
                } else {
                    throw new Error(`Status ${response.status}`);
                }
            } catch (e: any) {
                // Ignore failure
            } finally {
                clearTimeout(timeoutId);
                masterController.signal.removeEventListener('abort', onMasterAbort);
                
                activeRequests--;
                rejectedCount++;
                if (rejectedCount === gateways.length && !isResolved) {
                    reject(new Error(`All ${gateways.length} gateways failed for ${resourceId}`));
                }
            }
        };

        const startWaterfall = async () => {
            for (let i = 0; i < gateways.length; i++) {
                if (isResolved) break;
                tryGateway(i); 
                if (i < gateways.length - 1) {
                    await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
                }
            }
        };

        startWaterfall();
    });
}

// --- EXPORTED GATEWAY FUNCTIONS ---

export async function resolveIpnsViaGateways(ipnsKey: string): Promise<string> {
    // No filtering needed, just pass the list
    const gateways = PUBLIC_IPNS_GATEWAYS;
    
    try {
        const response = await staggeredGatewayFetch(ipnsKey, gateways, true, IPNS_RESOLVE_TIMEOUT_MS);
        
        // 1. Check X-Ipfs-Roots Header
        const rootsHeader = response.headers.get('x-ipfs-roots');
        if (rootsHeader) {
             const parts = rootsHeader.split(',');
             const root = parts[0].trim();
             if (root.startsWith('Qm') || root.startsWith('baf')) {
                 return root;
             }
        }

        // 2. Check Etag Header (Handle Weak/Quoted)
        const etag = response.headers.get('etag');
        if (etag) {
            const cleanEtag = etag.replace(/^W\//, '').replace(/"/g, '');
            if (cleanEtag.startsWith('Qm') || cleanEtag.startsWith('baf')) {
                return cleanEtag;
            }
        }

        // 3. Check X-Ipfs-Path
        const pathHeader = response.headers.get('x-ipfs-path');
        if (pathHeader?.startsWith('/ipfs/')) {
            return pathHeader.replace('/ipfs/', '');
        }

        // 4. URL Redirection
        if (response.url.includes('/ipfs/')) {
             const parts = response.url.split('/ipfs/');
             if (parts.length > 1) return parts[1].split('/')[0];
        }

        return '';
    } catch {
        return '';
    }
}

export async function fetchCidViaGateways(cid: string): Promise<any> {
    // No CID type check needed for Path Gateways
    const gatewaysToTry = PUBLIC_CONTENT_GATEWAYS;
    if (gatewaysToTry.length === 0) throw new Error(`No suitable public gateway found for CID: ${cid}`);

    try {
        const response = await staggeredGatewayFetch(cid, gatewaysToTry, false, GATEWAY_TIMEOUT_MS);
        return await response.json();
    } catch (e) {
        throw e;
    }
}
