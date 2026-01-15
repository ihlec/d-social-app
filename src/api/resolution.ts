import { getSession } from './session';
import { fetchKubo } from './kuboClient';
import { toGatewayUrl, getRankedGateways, promoteGateway, demoteGateway } from './gatewayUtils';
import { IPNS_CACHE_TTL, LOCAL_IPNS_TIMEOUT_MS, PUBLIC_GATEWAY_TIMEOUT_MS } from '../constants';

// --- CACHE ---
const IPNS_STORAGE_PREFIX = 'dsocial_ipns_cache_';
interface PersistentIpnsEntry { cid: string; timestamp: number; }

const saveToPersistentCache = (ipnsKey: string, cid: string) => {
    if (!cid) return;
    try {
        const entry: PersistentIpnsEntry = { cid, timestamp: Date.now() };
        localStorage.setItem(`${IPNS_STORAGE_PREFIX}${ipnsKey}`, JSON.stringify(entry));
    } catch (e) { /* ignore */ }
};

const loadFromPersistentCache = (ipnsKey: string): PersistentIpnsEntry | null => {
    try {
        const raw = localStorage.getItem(`${IPNS_STORAGE_PREFIX}${ipnsKey}`);
        if (!raw) return null;
        return JSON.parse(raw) as PersistentIpnsEntry;
    } catch (e) { return null; }
};

const pendingRequests = new Map<string, Promise<string>>(); 
const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();

export const invalidateIpnsCache = () => { 
    ipnsResolutionCache.clear();
    pendingRequests.clear(); 
};

// --- HELPER: ROBUST HEADER & URL PARSING ---
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


export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    if (!ipnsIdentifier || ipnsIdentifier === 'Unknown') return ''; 
    if (!ipnsIdentifier.includes('.') && !ipnsIdentifier.match(/^(k|1|Q)/)) return ''; 

    const cached = ipnsResolutionCache.get(ipnsIdentifier);
    if (cached && (Date.now() - cached.timestamp < IPNS_CACHE_TTL)) return cached.cid;

    if (pendingRequests.has(ipnsIdentifier)) {
        return pendingRequests.get(ipnsIdentifier)!;
    }

    const session = getSession();
    
    const execution = async (): Promise<string> => {
        if (session.sessionType === 'kubo' && session.rpcApiUrl) {
            try {
                const res = await fetchKubo(
                    session.rpcApiUrl, 
                    '/api/v0/name/resolve', 
                    { arg: ipnsIdentifier }, 
                    undefined, 
                    { username: session.kuboUsername, password: session.kuboPassword }, 
                    2000, 
                    1     
                );
                
                // Handle both parsed JSON object and raw response
                let pathValue: string | null = null;
                
                if (res && typeof res === 'object') {
                    // If fetchKubo already parsed it
                    pathValue = res.Path || res.path || null;
                } else if (typeof res === 'string') {
                    // If it's a string, try to parse it
                    try {
                        const parsed = JSON.parse(res);
                        pathValue = parsed.Path || parsed.path || null;
                    } catch (e) {
                        // Not JSON, ignore
                    }
                }
                
                if (pathValue) {
                    // Extract CID from path (format: "/ipfs/Qm..." or "/ipfs/baf...")
                    const resolved = pathValue.replace(/^\/ipfs\//, '').split('/')[0];
                    if (resolved && (resolved.startsWith('Qm') || resolved.startsWith('baf'))) {
                        ipnsResolutionCache.set(ipnsIdentifier, { cid: resolved, timestamp: Date.now() });
                        saveToPersistentCache(ipnsIdentifier, resolved);
                        return resolved;
                    }
                }
            } catch (e) {
                // Fall through to gateway resolution
            }
        }

        const controllers: AbortController[] = [];
        const promises: Promise<string>[] = [];

        if (session.sessionType === 'kubo' && session.rpcApiUrl) {
            const ctrl = new AbortController();
            controllers.push(ctrl);
            const localGw = toGatewayUrl(session.rpcApiUrl);
            
            promises.push(new Promise<string>(async (resolve, reject) => {
                const id = setTimeout(() => { ctrl.abort(); reject(new Error("Local Timeout")); }, LOCAL_IPNS_TIMEOUT_MS);
                try {
                    const res = await fetch(`${localGw}/ipns/${ipnsIdentifier}`, { 
                        method: 'HEAD', signal: ctrl.signal, cache: 'no-store' 
                    });
                    clearTimeout(id);
                    
                    const cid = extractCidFromResponse(res);
                    if (cid) resolve(cid);
                    else reject(new Error("Local OK but no CID extracted"));
                } catch(e) { clearTimeout(id); reject(e); }
            }));
        }

        const ctrlPublic = new AbortController();
        controllers.push(ctrlPublic);
        promises.push(new Promise<string>(async (resolve, reject) => {
            const gateways = getRankedGateways('ipns');
            for (const base of gateways) {
                if (ctrlPublic.signal.aborted) break;
                try {
                    const reqCtrl = new AbortController();
                    const id = setTimeout(() => reqCtrl.abort(), PUBLIC_GATEWAY_TIMEOUT_MS);
                    const res = await fetch(`${base}${ipnsIdentifier}`, { method: 'HEAD', signal: reqCtrl.signal });
                    clearTimeout(id);

                    if (res.ok) {
                        const cid = extractCidFromResponse(res);
                        if (cid) {
                            promoteGateway(base, 'ipns');
                            resolve(cid);
                            return;
                        }
                    }
                    demoteGateway(base, 'ipns');
                } catch { demoteGateway(base, 'ipns'); }
            }
            reject(new Error("Public fail"));
        }));

        try {
            const resolvedCid = await Promise.any(promises);
            controllers.forEach(c => c.abort()); 
            ipnsResolutionCache.set(ipnsIdentifier, { cid: resolvedCid, timestamp: Date.now() });
            saveToPersistentCache(ipnsIdentifier, resolvedCid);
            return resolvedCid;
        } catch (error) {
            const p = loadFromPersistentCache(ipnsIdentifier);
            if (p) return p.cid;
            return '';
        }
    };

    const finalPromise = execution().finally(() => {
        pendingRequests.delete(ipnsIdentifier); 
    });

    pendingRequests.set(ipnsIdentifier, finalPromise);
    return finalPromise;
}
