/**
 * Durable local directory: IPNS key → display name (and optional bio).
 * Survives reloads without requiring the peer to be online again.
 */

import type { UserProfile } from '../types';

const DB_NAME = 'dsocial_names';
const DB_VERSION = 1;
const STORE = 'names';
const MAX_ENTRIES = 2000;

interface NameEntry {
    ipnsKey: string;
    name: string;
    bio?: string;
    updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('IndexedDB unavailable'));
    }
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'ipnsKey' });
                    store.createIndex('updatedAt', 'updatedAt');
                }
            };
        });
    }
    return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** True if `name` is worth showing / caching (not empty, not a raw k51 key). */
export function isUsefulDisplayName(name?: string | null): boolean {
    const n = (name || '').trim();
    if (!n) return false;
    if (n.startsWith('k51') && n.length > 20) return false;
    if (n.endsWith('…') && n.length <= 12) return false; // shortId-style placeholders
    return true;
}

export async function rememberName(
    ipnsKey: string,
    profile: UserProfile | string
): Promise<void> {
    const key = (ipnsKey || '').trim();
    if (!key) return;

    const name = typeof profile === 'string' ? profile : profile?.name;
    if (!isUsefulDisplayName(name)) return;

    const bio =
        typeof profile === 'string' ? undefined : (profile.bio || undefined);
    const entry: NameEntry = {
        ipnsKey: key,
        name: name!.trim(),
        ...(bio ? { bio } : {}),
        updatedAt: Date.now(),
    };

    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const existing = (await reqToPromise(store.get(key))) as NameEntry | undefined;
        if (
            existing &&
            existing.name === entry.name &&
            (existing.bio || '') === (entry.bio || '')
        ) {
            // Touch LRU without rewriting name
            existing.updatedAt = entry.updatedAt;
            await reqToPromise(store.put(existing));
            return;
        }
        await reqToPromise(store.put(entry));
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        void maybeTrim();
    } catch (e) {
        console.debug('[NameDirectory] remember failed', e);
    }
}

/** Persist any new/changed useful names when the in-memory profile map updates. */
export function rememberProfilesDiff(
    prev: Map<string, UserProfile>,
    next: Map<string, UserProfile>
): void {
    if (prev === next) return;
    for (const [key, profile] of next) {
        if (!isUsefulDisplayName(profile?.name)) continue;
        const old = prev.get(key);
        if (
            old &&
            old.name === profile.name &&
            (old.bio || '') === (profile.bio || '')
        ) {
            continue;
        }
        void rememberName(key, profile);
    }
}

/** Load all cached names as UserProfile map (for React hydrate). */
export async function hydrateNameDirectory(): Promise<Map<string, UserProfile>> {
    const map = new Map<string, UserProfile>();
    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const rows = (await reqToPromise(store.getAll())) as NameEntry[];
        for (const row of rows || []) {
            if (!row?.ipnsKey || !isUsefulDisplayName(row.name)) continue;
            map.set(row.ipnsKey, {
                name: row.name,
                ...(row.bio ? { bio: row.bio } : {}),
            });
        }
    } catch (e) {
        console.debug('[NameDirectory] hydrate failed', e);
    }
    return map;
}

async function maybeTrim(): Promise<void> {
    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const count = await reqToPromise(store.count());
        if (count <= MAX_ENTRIES) return;

        const idx = store.index('updatedAt');
        const toDelete = count - MAX_ENTRIES;
        let deleted = 0;
        await new Promise<void>((resolve, reject) => {
            const cursorReq = idx.openCursor(); // oldest first
            cursorReq.onerror = () => reject(cursorReq.error);
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor || deleted >= toDelete) {
                    resolve();
                    return;
                }
                cursor.delete();
                deleted += 1;
                cursor.continue();
            };
        });
    } catch {
        /* ignore */
    }
}
