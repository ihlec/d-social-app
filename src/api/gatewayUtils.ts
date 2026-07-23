import { PUBLIC_CONTENT_GATEWAYS, PUBLIC_IPNS_GATEWAYS, LOCAL_GATEWAY_TIMEOUT_MS, PUBLIC_GATEWAY_TIMEOUT_MS } from '../constants';
import { getCookie, setCookie } from '../lib/utils';

const gatewayCooldowns = new Map<string, number>();
const COOLDOWN_DURATION = 60 * 1000; // 1 minute cooldown

// --- DYNAMIC RANKING SYSTEM ---
const GATEWAY_COOKIE_IPFS = 'dsocial_gateway_rank_ipfs_v6'; 
const GATEWAY_COOKIE_IPNS = 'dsocial_gateway_rank_ipns_v6';

export const getRankedGateways = (type: 'ipfs' | 'ipns'): string[] => {
    const cookieName = type === 'ipfs' ? GATEWAY_COOKIE_IPFS : GATEWAY_COOKIE_IPNS;
    
    // Check if we're running on localhost or local gateway
    const isLocalhost = typeof window !== 'undefined' && (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    );
    
    // If NOT on localhost, check if we're on a public gateway
    if (!isLocalhost && typeof window !== 'undefined') {
        const currentOrigin = window.location.origin;
        const isRunningOnPublicGateway = currentOrigin.includes('ipfs') || 
                                        currentOrigin.includes('dweb') || 
                                        currentOrigin.includes('pinata') ||
                                        currentOrigin.includes('filebase') ||
                                        currentOrigin.includes('4everland');
        
        // If on a public gateway, return ONLY that gateway (no ranking, no fallbacks)
        if (isRunningOnPublicGateway) {
            const suffix = type === 'ipfs' ? '/ipfs/' : '/ipns/';
            return [`${currentOrigin}${suffix}`];
        }
    }
    
    // If on localhost or not on a known gateway, use ranking logic
    // 1. Determine the base list
    let authoritativeList: string[] = [];
    if (type === 'ipfs') {
        const custom = localStorage.getItem('custom_gateways');
        authoritativeList = custom ? custom.split(',') : PUBLIC_CONTENT_GATEWAYS;
    } else {
        const custom = localStorage.getItem('custom_ipns_gateways');
        authoritativeList = custom ? custom.split(',') : PUBLIC_IPNS_GATEWAYS;
    }
    
    // Clean list
    authoritativeList = authoritativeList.map(u => u.trim()).filter(u => u.length > 0);

    // 2. Apply Ranking Persistence (only used on localhost)
    try {
        const stored = getCookie(cookieName);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                // Normalize URLs for comparison (handle trailing slashes)
                const normalize = (url: string) => url.trim().replace(/\/+$/, '') + '/';
                const normalizedAuthoritative = authoritativeList.map(normalize);
                
                // Filter to ensure we only keep gateways that are still in the allowed list
                const valid = parsed.filter(url => {
                    const normalized = normalize(url);
                    return normalizedAuthoritative.some(a => normalize(a) === normalized);
                });
                
                // Merge cookie rankings with authoritative list
                const allUrls = [...valid, ...authoritativeList];
                const merged = Array.from(new Set(allUrls.map(normalize)));
                
                // Return URLs with trailing slash for consistency
                return merged.map(url => url.replace(/\/+$/, '') + '/');
            }
        }
    } catch { /* ignore */ }
    
    // Default: Return deduplicated list
    return Array.from(new Set(authoritativeList));
};

export const promoteGateway = (url: string, type: 'ipfs' | 'ipns') => {
    // Only promote/demote when on localhost (ranking is only used on localhost)
    const isLocalhost = typeof window !== 'undefined' && (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    );
    
    if (!isLocalhost) {
        // On public gateway, ranking isn't used - skip cookie updates
        return;
    }
    
    const current = getRankedGateways(type);
    const updated = [url, ...current.filter(u => u !== url)].slice(0, 5); 
    setCookie(type === 'ipfs' ? GATEWAY_COOKIE_IPFS : GATEWAY_COOKIE_IPNS, JSON.stringify(updated), 7);
};

export const demoteGateway = (url: string, type: 'ipfs' | 'ipns') => {
    // Only promote/demote when on localhost (ranking is only used on localhost)
    const isLocalhost = typeof window !== 'undefined' && (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    );
    
    if (!isLocalhost) {
        // On public gateway, ranking isn't used - skip cookie updates
        return;
    }
    
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
    
    const publicUrls: string[] = [];
    const rankedGateways = getRankedGateways('ipfs');
    
    rankedGateways.forEach(gwUrl => {
        let fullUrl = '';

        if (gwUrl.includes('{cid}')) {
            if (cleanCid && !cleanCid.startsWith('Qm')) {
                 fullUrl = gwUrl.replace('{cid}', cleanCid);
            }
        } else {
            let baseUrl = gwUrl.trim().replace(/\/+$/, '');
            
            if (baseUrl.endsWith('/ipfs')) {
                fullUrl = `${baseUrl}/${cleanCid}`;
            } else if (baseUrl.endsWith('/ipns')) {
                fullUrl = `${baseUrl}/${cleanCid}`;
            } else {
                fullUrl = `${baseUrl}/ipfs/${cleanCid}`;
            }
        }

        if (fullUrl) {
            publicUrls.push(fullUrl);
        }
    });

    return [...new Set(publicUrls)].filter(u => 
        u && 
        (u.startsWith('http://') || u.startsWith('https://')) && 
        !u.includes('undefined') && 
        !u.includes('null') &&
        !isOnCooldown(u)
    );
};

// --- SHARED GATEWAY FETCHING UTILITY ---
export async function fetchFromGateways<T>(
    resourcePath: string, // e.g., "/ipfs/{cid}" or "/ipns/{key}"
    gatewayType: 'ipfs' | 'ipns',
    responseProcessor: (response: Response) => Promise<T>,
    _localTimeoutMs: number = LOCAL_GATEWAY_TIMEOUT_MS,
    publicTimeoutMs: number = PUBLIC_GATEWAY_TIMEOUT_MS
): Promise<T | null> {
    const gateways = getRankedGateways(gatewayType);
    const pathPrefix = gatewayType === 'ipfs' ? '/ipfs/' : '/ipns/';

    if (gateways.length === 0) return null;

    const ctrlPublic = new AbortController();

    try {
        for (let i = 0; i < gateways.length; i++) {
            if (ctrlPublic.signal.aborted) break;
            const base = gateways[i];

            try {
                const reqCtrl = new AbortController();
                const id = setTimeout(() => reqCtrl.abort(), publicTimeoutMs);

                let normalizedBase = base.trim().replace(/\/+$/, '');
                let url: string;
                if (normalizedBase.endsWith(pathPrefix.slice(0, -1))) {
                    const cidOrKey = resourcePath.replace(pathPrefix, '').replace(/^\/+/, '');
                    url = `${normalizedBase}/${cidOrKey}`;
                } else {
                    url = `${normalizedBase}${resourcePath}`;
                }

                const res = await fetch(url, { signal: reqCtrl.signal });
                clearTimeout(id);

                if (res.ok) {
                    promoteGateway(base, gatewayType);
                    return await responseProcessor(res);
                }
                demoteGateway(base, gatewayType);
            } catch {
                demoteGateway(base, gatewayType);
            }
        }
        return null;
    } finally {
        ctrlPublic.abort();
    }
}
