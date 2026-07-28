import { IPNS_CACHE_TTL } from '../constants';
import { isPeerId } from '../lib/utils';
import { heliaResolveIpnsOffline, getHeliaStatus, startHelia } from './heliaNode';

const IPNS_STORAGE_PREFIX = 'dsocial_ipns_cache_';
interface PersistentIpnsEntry { cid: string; timestamp: number; }

const saveToPersistentCache = (ipnsKey: string, cid: string) => {
    if (!cid) return;
    try {
        const entry: PersistentIpnsEntry = { cid, timestamp: Date.now() };
        localStorage.setItem(`${IPNS_STORAGE_PREFIX}${ipnsKey}`, JSON.stringify(entry));
    } catch { /* ignore */ }
};

/** Seed resolve caches after a local tip publish. */
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
    } catch {
        return null;
    }
};

const pendingRequests = new Map<string, Promise<string>>();
const ipnsResolutionCache = new Map<string, { cid: string; timestamp: number }>();

/**
 * Resolve a peer tip → state CID.
 * Local CAS tip + memory/persistent cache only (no public IPNS — fresh-start CAS).
 */
export async function resolveIpns(ipnsIdentifier: string): Promise<string> {
    if (!ipnsIdentifier || ipnsIdentifier === 'Unknown') return '';
    if (!isPeerId(ipnsIdentifier)) return '';

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

        try {
            if (getHeliaStatus().status !== 'ready') await startHelia();
            const localCid = await heliaResolveIpnsOffline(ipnsIdentifier);
            if (localCid) return cacheHit(localCid);
        } catch { /* ignore */ }

        const persistent = loadFromPersistentCache(ipnsIdentifier);
        if (persistent?.cid) return persistent.cid;

        return '';
    };

    const finalPromise = execution().finally(() => {
        pendingRequests.delete(ipnsIdentifier);
    });

    pendingRequests.set(ipnsIdentifier, finalPromise);
    return finalPromise;
}
