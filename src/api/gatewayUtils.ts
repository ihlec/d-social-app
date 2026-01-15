import { PUBLIC_CONTENT_GATEWAYS, PUBLIC_IPNS_GATEWAYS, LOCAL_GATEWAY_TIMEOUT_MS, PUBLIC_GATEWAY_TIMEOUT_MS } from '../constants';
import { getSession } from '../api/ipfsIpns';
import { getCookie, setCookie } from '../lib/utils';

const gatewayCooldowns = new Map<string, number>();
const COOLDOWN_DURATION = 60 * 1000; // 1 minute cooldown

// --- DYNAMIC RANKING SYSTEM ---
const GATEWAY_COOKIE_IPFS = 'dsocial_gateway_rank_ipfs_v6'; 
const GATEWAY_COOKIE_IPNS = 'dsocial_gateway_rank_ipns_v6';

export const getRankedGateways = (type: 'ipfs' | 'ipns'): string[] => {
    const cookieName = type === 'ipfs' ? GATEWAY_COOKIE_IPFS : GATEWAY_COOKIE_IPNS;
    
    // 1. Determine the "Authoritative List" based on Settings OR Constants
    let authoritativeList: string[] = [];
    if (type === 'ipfs') {
        const custom = localStorage.getItem('custom_gateways');
        authoritativeList = custom ? custom.split(',') : PUBLIC_CONTENT_GATEWAYS;
    } else {
        const custom = localStorage.getItem('custom_ipns_gateways');
        authoritativeList = custom ? custom.split(',') : PUBLIC_IPNS_GATEWAYS;
    }
    
    // Clean whitespace and empty entries
    authoritativeList = authoritativeList.map(u => u.trim()).filter(u => u.length > 0);

    // 2. Apply Ranking Persistence
    try {
        const stored = getCookie(cookieName);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                // Filter to ensure we only keep gateways that are still in the allowed list
                // (in case user settings changed)
                const valid = parsed.filter(url => authoritativeList.includes(url));
                // Add any new allowed gateways that weren't in the cookie
                return [...new Set([...valid, ...authoritativeList])];
            }
        }
    } catch { /* ignore */ }
    
    // Default: Return deduplicated authoritative list
    return [...new Set(authoritativeList)];
};

export const promoteGateway = (url: string, type: 'ipfs' | 'ipns') => {
    const current = getRankedGateways(type);
    const updated = [url, ...current.filter(u => u !== url)].slice(0, 5); 
    setCookie(type === 'ipfs' ? GATEWAY_COOKIE_IPFS : GATEWAY_COOKIE_IPNS, JSON.stringify(updated), 7);
};

export const demoteGateway = (url: string, type: 'ipfs' | 'ipns') => {
    const current = getRankedGateways(type);
    const updated = [...current.filter(u => u !== url), url].slice(0, 5);
    setCookie(type === 'ipfs' ? GATEWAY_COOKIE_IPFS : GATEWAY_COOKIE_IPNS, JSON.stringify(updated), 7);
};

export const reportGatewayError = (fullUrl: string) => {
    try {
        const urlObj = new URL(fullUrl);
        const origin = urlObj.origin; // e.g. https://ipfs.4everland.io
        // Only set cooldown if not already on cooldown (avoid resetting timer)
        if (!gatewayCooldowns.has(origin) || gatewayCooldowns.get(origin)! < Date.now()) {
            gatewayCooldowns.set(origin, Date.now() + COOLDOWN_DURATION);
            console.warn(`[Gateway] ${origin} marked as unhealthy/rate-limited for 1m.`);
            
            // Also demote it
            // Determine type by checking if it's in the IPFS or IPNS list (heuristic)
            // But simplify: just demote from IPFS list as that's most common
             demoteGateway(urlObj.origin + '/', 'ipfs');
        }
    } catch (e) {
        // ignore
    }
};

const isOnCooldown = (fullUrl: string) => {
    try {
        const urlObj = new URL(fullUrl);
        const origin = urlObj.origin;
        const expiry = gatewayCooldowns.get(origin);
        if (expiry) {
            if (Date.now() < expiry) {
                return true;
            } else {
                gatewayCooldowns.delete(origin); // Clean up expired
                return false;
            }
        }
        return false;
    } catch {
        return false;
    }
};

export const toGatewayUrl = (rpcUrl: string): string => {
    let url = rpcUrl.replace('5001', '8080');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `http://${url}`;
    }
    return url;
};

export const getAllGatewayUrls = (cid?: string): string[] => {
    if (!cid) return [];
    
    // Clean the CID to avoid DNS errors from invisible whitespace
    const cleanCid = cid.trim();
    
    const localUrls: string[] = [];
    const publicUrls: string[] = [];

    // 1. Process Local Gateway (Priority)
    const session = getSession();
    if (session && session.sessionType === 'kubo' && session.rpcApiUrl && session.rpcApiUrl.startsWith('http')) {
        const gatewayUrl = toGatewayUrl(session.rpcApiUrl);
        localUrls.push(`${gatewayUrl}/ipfs/${cleanCid}`);
    }

    // 2. Process Public Gateways (Ranked & Custom Unified)
    const rankedGateways = getRankedGateways('ipfs');
    
    rankedGateways.forEach(gwUrl => {
        let fullUrl = '';

        if (gwUrl.includes('{cid}')) {
            // Subdomain Gateway Pattern
            if (cleanCid && !cleanCid.startsWith('Qm')) {
                 fullUrl = gwUrl.replace('{cid}', cleanCid);
            }
        } else {
            // Path Gateway Pattern
            let baseUrl = gwUrl;
            
            // Normalize: Ensure we handle trailing slashes and 'ipfs' path
            if (baseUrl.endsWith('/')) {
                baseUrl = baseUrl.slice(0, -1);
            }
            
            if (baseUrl.endsWith('/ipfs')) {
                 fullUrl = `${baseUrl}/${cleanCid}`;
            } else {
                 // Assume if /ipfs/ is missing, we need to add it (common for user-entered domains)
                 fullUrl = `${baseUrl}/ipfs/${cleanCid}`;
            }
        }

        if (fullUrl) {
            publicUrls.push(fullUrl);
        }
    });

    // 3. Construct Final Priority List
    const allUrls = [
        ...localUrls,      
        ...publicUrls        
    ];

    return [...new Set(allUrls)].filter(u => 
        u && 
        (u.startsWith('http://') || u.startsWith('https://')) && 
        !u.includes('undefined') && 
        !u.includes('null') &&
        !isOnCooldown(u)
    );
};

// --- SHARED GATEWAY FETCHING UTILITY ---
// Common pattern for racing local vs public gateways
export async function fetchFromGateways<T>(
    resourcePath: string, // e.g., "/ipfs/{cid}" or "/ipns/{key}"
    gatewayType: 'ipfs' | 'ipns',
    responseProcessor: (response: Response) => Promise<T>,
    localTimeoutMs: number = LOCAL_GATEWAY_TIMEOUT_MS,
    publicTimeoutMs: number = PUBLIC_GATEWAY_TIMEOUT_MS
): Promise<T | null> {
    const session = getSession();
    const controllers: AbortController[] = [];
    const promises: Promise<T>[] = [];

    // Local Gateway Promise
    if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const localGw = toGatewayUrl(session.rpcApiUrl);
        
        promises.push(new Promise<T>(async (resolve, reject) => {
            const id = setTimeout(() => { ctrl.abort(); reject(new Error("Local Timeout")); }, localTimeoutMs);
            try {
                const res = await fetch(`${localGw}${resourcePath}`, { signal: ctrl.signal });
                clearTimeout(id);
                if (res.ok) {
                    const result = await responseProcessor(res);
                    resolve(result);
                } else if (res.status === 504) {
                    // Gateway Timeout from Kubo - fail fast to allow public gateways to try
                    reject(new Error("Local Gateway Timeout (504)"));
                } else {
                    reject(new Error(`Local ${res.status}`));
                }
            } catch(e) { 
                clearTimeout(id); 
                reject(e); 
            }
        }));
    }

    // Public Gateway Promise (Starts 600ms after local to give it a headstart, then sequential fallback)
    const gateways = getRankedGateways(gatewayType);
    const pathPrefix = gatewayType === 'ipfs' ? '/ipfs/' : '/ipns/';
    const LOCAL_HEADSTART_MS = 400;
    
    if (gateways.length > 0) {
        const ctrlPublic = new AbortController();
        controllers.push(ctrlPublic);
        
        promises.push(new Promise<T>(async (resolve, reject) => {
            // Give local gateway a 600ms headstart before trying public gateways
            await new Promise(resolve => setTimeout(resolve, LOCAL_HEADSTART_MS));
            
            // If local already succeeded, abort public attempts
            if (ctrlPublic.signal.aborted) {
                reject(new Error("Aborted - local succeeded"));
                return;
            }
            
            // Try gateways sequentially
            for (let i = 0; i < gateways.length; i++) {
                if (ctrlPublic.signal.aborted) break;
                const base = gateways[i];
                
                try {
                    const reqCtrl = new AbortController();
                    const id = setTimeout(() => reqCtrl.abort(), publicTimeoutMs);
                    
                    // Construct URL correctly:
                    // - If base already ends with /ipfs/ or /ipns/, use resourcePath as-is (after removing leading /)
                    // - Otherwise, strip /ipfs/ or /ipns/ from resourcePath to avoid duplication
                    let url: string;
                    if (base.endsWith(pathPrefix)) {
                        // Base already has the prefix, just append the CID/key
                        url = `${base}${resourcePath.replace(pathPrefix, '')}`;
                    } else {
                        // Base doesn't have the prefix, strip it from resourcePath
                        url = `${base}${resourcePath.replace(pathPrefix, '/')}`;
                    }
                    
                    const res = await fetch(url, { signal: reqCtrl.signal });
                    clearTimeout(id);
                    
                    if (res.ok) {
                        promoteGateway(base, gatewayType);
                        const result = await responseProcessor(res);
                        resolve(result);
                        return;
                    } else {
                        demoteGateway(base, gatewayType);
                    }
                } catch (e) {
                    demoteGateway(base, gatewayType);
                    // Continue to next gateway if this one failed
                }
            }
            reject(new Error("All public gateways failed"));
        }));
    }

    try {
        const result = await Promise.any(promises);
        controllers.forEach(c => c.abort());
        return result;
    } catch {
        return null;
    }
}
