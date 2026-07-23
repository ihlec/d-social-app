/**
 * IndexedDB read-cache for posts and user-state heads.
 * Source of truth remains IPFS/Helia; this only speeds cold starts.
 *
 * Eviction (see plan):
 * - Cap: 5000 posts, 500 state heads (LRU by lastAccessed)
 * - Age: posts 30d, state heads 7d soft TTL
 * - Unfollow: mark author evictable
 * - QuotaExceeded: aggressive GC
 */

import { Post, UserState } from '../types';

const DB_NAME = 'dsocial_content_cache';
const DB_VERSION = 1;
const POSTS_STORE = 'posts';
const STATES_STORE = 'userStates';

export const IDB_MAX_POSTS = 5000;
export const IDB_MAX_STATES = 500;
export const IDB_POST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IDB_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IDB_HYDRATE_WINDOW = 400;

interface CachedPost {
    id: string;
    post: Post;
    lastAccessed: number;
    authorKey: string;
    evictable?: boolean;
}

interface CachedUserState {
    ipnsKey: string;
    state: UserState;
    headCid?: string;
    lastAccessed: number;
    evictable?: boolean;
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
                if (!db.objectStoreNames.contains(POSTS_STORE)) {
                    const posts = db.createObjectStore(POSTS_STORE, { keyPath: 'id' });
                    posts.createIndex('lastAccessed', 'lastAccessed');
                    posts.createIndex('authorKey', 'authorKey');
                }
                if (!db.objectStoreNames.contains(STATES_STORE)) {
                    const states = db.createObjectStore(STATES_STORE, { keyPath: 'ipnsKey' });
                    states.createIndex('lastAccessed', 'lastAccessed');
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

async function withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>
): Promise<T | null> {
    try {
        const db = await openDb();
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        return await fn(store);
    } catch (e) {
        console.warn('[ContentCache]', e);
        return null;
    }
}

export async function putPost(post: Post): Promise<void> {
    if (!post?.id) return;
    const entry: CachedPost = {
        id: post.id,
        post,
        lastAccessed: Date.now(),
        authorKey: post.authorKey || '',
    };
    try {
        await withStore(POSTS_STORE, 'readwrite', async (store) => {
            await reqToPromise(store.put(entry));
            return null;
        });
    } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || String(e).includes('QuotaExceeded')) {
            await runGc(true);
            await withStore(POSTS_STORE, 'readwrite', async (store) => {
                await reqToPromise(store.put(entry));
                return null;
            });
        }
    }
    // Opportunistic soft GC (non-blocking)
    maybeGc().catch(() => {});
}

export async function putPosts(posts: Post[]): Promise<void> {
    for (const p of posts) {
        await putPost(p);
    }
}

export async function getPost(cid: string): Promise<Post | null> {
    const row = await withStore(POSTS_STORE, 'readwrite', async (store) => {
        const existing = await reqToPromise(store.get(cid)) as CachedPost | undefined;
        if (!existing) return null;
        existing.lastAccessed = Date.now();
        await reqToPromise(store.put(existing));
        return existing.post;
    });
    return row ?? null;
}

export async function getPosts(cids: string[]): Promise<Map<string, Post>> {
    const out = new Map<string, Post>();
    for (const cid of cids) {
        const p = await getPost(cid);
        if (p) out.set(cid, p);
    }
    return out;
}

export async function putUserState(ipnsKey: string, state: UserState, headCid?: string): Promise<void> {
    if (!ipnsKey || !state) return;
    const entry: CachedUserState = {
        ipnsKey,
        state,
        headCid,
        lastAccessed: Date.now(),
    };
    try {
        await withStore(STATES_STORE, 'readwrite', async (store) => {
            await reqToPromise(store.put(entry));
            return null;
        });
    } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || String(e).includes('QuotaExceeded')) {
            await runGc(true);
            await withStore(STATES_STORE, 'readwrite', async (store) => {
                await reqToPromise(store.put(entry));
                return null;
            });
        }
    }
}

export async function getUserState(ipnsKey: string): Promise<{ state: UserState; headCid?: string } | null> {
    return withStore(STATES_STORE, 'readwrite', async (store) => {
        const existing = await reqToPromise(store.get(ipnsKey)) as CachedUserState | undefined;
        if (!existing) return null;
        existing.lastAccessed = Date.now();
        await reqToPromise(store.put(existing));
        return { state: existing.state, headCid: existing.headCid };
    });
}

/** Mark an author's posts/state as preferred eviction targets (e.g. unfollow). */
export async function markAuthorEvictable(authorKey: string): Promise<void> {
    if (!authorKey) return;
    await withStore(POSTS_STORE, 'readwrite', async (store) => {
        const idx = store.index('authorKey');
        const all = await reqToPromise(idx.getAll(authorKey)) as CachedPost[];
        for (const row of all) {
            row.evictable = true;
            await reqToPromise(store.put(row));
        }
        return null;
    });
    await withStore(STATES_STORE, 'readwrite', async (store) => {
        const existing = await reqToPromise(store.get(authorKey)) as CachedUserState | undefined;
        if (existing) {
            existing.evictable = true;
            await reqToPromise(store.put(existing));
        }
        return null;
    });
    await runGc(false);
}

export async function clearContentCache(): Promise<void> {
    try {
        const db = await openDb();
        await Promise.all([
            reqToPromise(db.transaction(POSTS_STORE, 'readwrite').objectStore(POSTS_STORE).clear()),
            reqToPromise(db.transaction(STATES_STORE, 'readwrite').objectStore(STATES_STORE).clear()),
        ]);
    } catch (e) {
        console.warn('[ContentCache] clear failed', e);
    }
}

/** Load newest-by-access posts for React hydrate. */
export async function hydrateRecentPosts(limit: number = IDB_HYDRATE_WINDOW): Promise<Post[]> {
    const rows = await withStore(POSTS_STORE, 'readonly', async (store) => {
        const idx = store.index('lastAccessed');
        return new Promise<CachedPost[]>((resolve, reject) => {
            const results: CachedPost[] = [];
            const cursorReq = idx.openCursor(null, 'prev');
            cursorReq.onerror = () => reject(cursorReq.error);
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor || results.length >= limit) {
                    resolve(results);
                    return;
                }
                results.push(cursor.value as CachedPost);
                cursor.continue();
            };
        });
    });
    return (rows || []).map(r => r.post);
}

export async function hydrateRecentUserStates(limit: number = 100): Promise<Map<string, UserState>> {
    const map = new Map<string, UserState>();
    const rows = await withStore(STATES_STORE, 'readonly', async (store) => {
        const idx = store.index('lastAccessed');
        return new Promise<CachedUserState[]>((resolve, reject) => {
            const results: CachedUserState[] = [];
            const cursorReq = idx.openCursor(null, 'prev');
            cursorReq.onerror = () => reject(cursorReq.error);
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor || results.length >= limit) {
                    resolve(results);
                    return;
                }
                results.push(cursor.value as CachedUserState);
                cursor.continue();
            };
        });
    });
    (rows || []).forEach(r => {
        if (!r.evictable) map.set(r.ipnsKey, r.state);
    });
    return map;
}

let gcScheduled = false;
async function maybeGc() {
    if (gcScheduled) return;
    gcScheduled = true;
    setTimeout(async () => {
        gcScheduled = false;
        await runGc(false);
    }, 2000);
}

async function runGc(aggressive: boolean): Promise<void> {
    const now = Date.now();
    await withStore(POSTS_STORE, 'readwrite', async (store) => {
        const all = await reqToPromise(store.getAll()) as CachedPost[];
        // Delete expired / mark-evictable first
        for (const row of all) {
            const expired = now - row.lastAccessed > IDB_POST_TTL_MS;
            if (expired || (row.evictable && (aggressive || all.length > IDB_MAX_POSTS * 0.8))) {
                await reqToPromise(store.delete(row.id));
            }
        }
        let remaining = await reqToPromise(store.getAll()) as CachedPost[];
        if (remaining.length > IDB_MAX_POSTS || aggressive) {
            remaining.sort((a, b) => a.lastAccessed - b.lastAccessed);
            // Prefer deleting evictable, then LRU
            remaining.sort((a, b) => {
                if (!!a.evictable !== !!b.evictable) return a.evictable ? -1 : 1;
                return a.lastAccessed - b.lastAccessed;
            });
            const target = aggressive ? Math.floor(IDB_MAX_POSTS * 0.5) : IDB_MAX_POSTS;
            while (remaining.length > target) {
                const drop = remaining.shift()!;
                await reqToPromise(store.delete(drop.id));
            }
        }
        return null;
    });

    await withStore(STATES_STORE, 'readwrite', async (store) => {
        const all = await reqToPromise(store.getAll()) as CachedUserState[];
        for (const row of all) {
            const expired = now - row.lastAccessed > IDB_STATE_TTL_MS;
            if (expired || (row.evictable && aggressive)) {
                await reqToPromise(store.delete(row.ipnsKey));
            }
        }
        let remaining = await reqToPromise(store.getAll()) as CachedUserState[];
        if (remaining.length > IDB_MAX_STATES || aggressive) {
            remaining.sort((a, b) => {
                if (!!a.evictable !== !!b.evictable) return a.evictable ? -1 : 1;
                return a.lastAccessed - b.lastAccessed;
            });
            const target = aggressive ? Math.floor(IDB_MAX_STATES * 0.5) : IDB_MAX_STATES;
            while (remaining.length > target) {
                const drop = remaining.shift()!;
                await reqToPromise(store.delete(drop.ipnsKey));
            }
        }
        return null;
    });
}
