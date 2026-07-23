import { getRankedGateways, promoteGateway, demoteGateway } from './gatewayUtils';
import { IPNS_CACHE_TTL, PUBLIC_GATEWAY_TIMEOUT_MS } from '../constants';
import { heliaResolveIpnsOffline, getHeliaStatus } from './heliaNode';
import { isGatewayFallbackEnabled } from '../lib/gatewayFallback';

const IPNS_STORAGE_PREFIX = 'dsocial_ipns_cache_';
interface PersistentIpnsEntry { cid: string; timestamp: number; }

const saveToPersistentCache = (ipnsKey: string, cid: string) => {
    if (!cid) return;
    try {
        const entry: PersistentIpnsEntry = { cid, timestamp: Date.now() };
        localStorage.setItem(`${IPNS_STORAGE_PREFIX}${ipnsKey}`, JSON.stringify(entry));
    } catch (e) { /* ignore */ }
};

/** Seed resolve caches after a local Helia publish (avoids public-gateway probes). */
export function rememberIpnsResolution(ipnsKey: string, cid: string): void {
    if (!ipnsKey || !cid) return;
    const key = ipnsKey.startsWith('/ipns/') ? ipnsKey.slice(6) : ipnsKey;
    ipnsResolutionCache.set(key, { cid, timestamp: Date.now() });
    saveToPersistentCache(key, cid);
}

const loadFromPersistentCache = (ipnsKey: string): PersistentIpnsEntry | null => {
    try {
        const raw = localStorage.getItem(`${IPNS_STORAGE_PREFIX}${ipnsKey}`);
        if (!raw) return null;
        return JSON.parse(raw) as PersistentIpnsEntry;
    } catch (e) { return null; }
};

const pendingRequests = new Map<string, Promise<string>>(); 
const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();

const extractCidFromResponse = (res: Response): string | null => {
    if (res.url && res.url.includes('/ipfs/')) {
        const parts = res.url.split('/ipfs/');
        if (parts.length > 1) {
            const potentialCid = parts[1].split(/[?#]/)[0]; 
            if (potentialCid.startsWith('Qm') || potentialCid.startsWith('baf')) {
                return potentialCid;
            }
        }
    }
    const ipfsPath = res.headers.get('x-ipfs-path');
    if (ipfsPath && ipfsPath.startsWith('/ipfs/')) {
        return ipfsPath.replace('/ipfs/', '');
    }
    const etag = res.headers.get('etag');
    if (etag) {
        const cleanEtag = etag.replace(/^W\//, '').replace(/"/g, '');
        if (cleanEtag.startsWith('Qm') || cleanEtag.startsWith('baf')) {
            return cleanEtag;
        }
    }
    const ipfsRoots = res.headers.get('x-ipfs-roots');
    if (ipfsRoots) {
        const roots = ipfsRoots.split(',');
        for (const root of roots) {
            const cleanRoot = root.trim();
            if (cleanRoot.startsWith('Qm') || cleanRoot.startsWith('baf')) {
                return cleanRoot;
            }
        }
    }
    return null;
};


// Parse IPNS record to extract CID
// IPNS records are protobuf-encoded, but we can extract the CID from the Value field
// The Value field typically contains "/ipfs/{cid}"
const parseIpnsRecord = async (recordData: ArrayBuffer | Blob): Promise<string | null> => {
    try {
        const data = recordData instanceof Blob ? await recordData.arrayBuffer() : recordData;
        const uint8Array = new Uint8Array(data);
        
        // Try to decode as text to find the "/ipfs/" pattern
        // IPNS records contain the Value field which has the format "/ipfs/{cid}"
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const dataStr = decoder.decode(uint8Array);
        
        // Look for "/ipfs/" followed by a CID (Qm... or baf...)
        const ipfsMatch = dataStr.match(/\/ipfs\/([Qmbaf][A-Za-z0-9]{43,})/);
        if (ipfsMatch && ipfsMatch[1]) {
            return ipfsMatch[1];
        }
        
        // Alternative: Look for CID pattern directly (less reliable but might work)
        const cidMatch = dataStr.match(/\b([Qmbaf][A-Za-z0-9]{43,})\b/);
        if (cidMatch && cidMatch[1]) {
            // Validate it looks like a CID
            const potentialCid = cidMatch[1];
            if (potentialCid.startsWith('Qm') || potentialCid.startsWith('baf')) {
                return potentialCid;
            }
        }
        
        return null;
    } catch (e) {
        console.warn('[IPNS] Failed to parse IPNS record', e);
        return null;
    }
};

export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    if (!ipnsIdentifier || ipnsIdentifier === 'Unknown') return ''; 
    if (!ipnsIdentifier.includes('.') && !ipnsIdentifier.match(/^(k|1|Q)/)) return ''; 

    const cached = ipnsResolutionCache.get(ipnsIdentifier);
    if (cached && (Date.now() - cached.timestamp < IPNS_CACHE_TTL)) return cached.cid;

    if (pendingRequests.has(ipnsIdentifier)) {
        return pendingRequests.get(ipnsIdentifier)!;
    }

    const execution = async (): Promise<string> => {
        const cacheHit = (cid: string) => {
            ipnsResolutionCache.set(ipnsIdentifier, { cid, timestamp: Date.now() });
            saveToPersistentCache(ipnsIdentifier, cid);
            return cid;
        };

        // 0) Local Helia — records this browser just published
        if (getHeliaStatus().status === 'ready') {
            try {
                const localCid = await heliaResolveIpnsOffline(ipnsIdentifier);
                if (localCid) return cacheHit(localCid);
            } catch { /* ignore */ }
        }

        // 1) Delegated IPFS routing (CORS-friendly, no HEAD spam)
        try {
            const delegatedUrl = `https://delegated-ipfs.dev/routing/v1/ipns/${ipnsIdentifier}`;
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => ctrl.abort(), 10000);
            
            const res = await fetch(delegatedUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/vnd.ipfs.ipns-record'
                },
                signal: ctrl.signal
            });
            clearTimeout(timeoutId);
            
            if (res.ok) {
                const recordData = await res.blob();
                const cid = await parseIpnsRecord(recordData);
                if (cid) return cacheHit(cid);
            }
        } catch (e) {
            console.debug('[IPNS] Delegated service failed, trying fallback methods', e);
        }

        // Prefer stale local/persistent cache before noisy public IPNS gateways
        // (unpublished / not-yet-propagated names produce 500/CORS in the console).
        const persistent = loadFromPersistentCache(ipnsIdentifier);
        if (persistent?.cid) return persistent.cid;

        if (!isGatewayFallbackEnabled()) return '';

        // 2) Public gateways — opt-in only; try at most two
        const gateways = getRankedGateways('ipns').slice(0, 2);
        for (const base of gateways) {
            try {
                const reqCtrl = new AbortController();
                const id = setTimeout(() => reqCtrl.abort(), PUBLIC_GATEWAY_TIMEOUT_MS);
                const res = await fetch(`${base}${ipnsIdentifier}`, { method: 'HEAD', signal: reqCtrl.signal });
                clearTimeout(id);

                if (res.ok) {
                    const cid = extractCidFromResponse(res);
                    if (cid) {
                        promoteGateway(base, 'ipns');
                        return cacheHit(cid);
                    }
                }
                demoteGateway(base, 'ipns');
            } catch { demoteGateway(base, 'ipns'); }
        }

        return '';
    };

    const finalPromise = execution().finally(() => {
        pendingRequests.delete(ipnsIdentifier); 
    });

    pendingRequests.set(ipnsIdentifier, finalPromise);
    return finalPromise;
}
