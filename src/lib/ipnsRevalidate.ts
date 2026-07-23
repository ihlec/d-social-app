import { IPNS_REVALIDATE_TTL_MS } from '../constants';

const STORAGE_KEY = 'dsocial_ipns_revalidate';

interface RevalidateMap {
    [ipnsKey: string]: number; // last check timestamp
}

function load(): RevalidateMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function save(map: RevalidateMap) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
        // ignore quota
    }
}

/** Returns true if we should skip resolveIpns for this key (checked recently). */
export function shouldSkipIpnsRevalidate(ipnsKey: string): boolean {
    if (!ipnsKey) return true;
    const map = load();
    const last = map[ipnsKey];
    if (!last) return false;
    return Date.now() - last < IPNS_REVALIDATE_TTL_MS;
}

export function markIpnsRevalidated(ipnsKey: string): void {
    if (!ipnsKey) return;
    const map = load();
    map[ipnsKey] = Date.now();
    // Prune stale entries older than 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const key of Object.keys(map)) {
        if (map[key] < cutoff) delete map[key];
    }
    save(map);
}
