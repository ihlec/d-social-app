/**
 * Build keep-set per pin policy and delete unpinned / unneeded media DAGs.
 */

import type { Post, UserState } from '../types';
import { startHelia, isHeliaAvailable, wipeHeliaBlockstore } from '../api/heliaNode';
import { heliaSweepExcept } from '../api/heliaBlocks';
import { clearContentCache } from './contentCache';
import { cidsToKeepForPost } from './pinPolicy';
import { hasStorageHeadroom } from './storageQuota';

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export type MediaGcMode = 'normal' | 'aggressive';

export function buildMediaKeepSet(
    userState: UserState,
    postsMap: Map<string, Post>,
    _myPeerId: string,
    mode: MediaGcMode = 'normal',
    extraRoots: Iterable<string> = []
): Set<string> {
    const keep = new Set<string>();
    const saved = new Set(userState.savedPostCIDs || []);
    const liked = new Set(userState.likedPostCIDs || []);
    const own = new Set(userState.postCIDs || []);

    const addPost = (postId: string, keepMode: 'author' | 'like' | 'save') => {
        const post = postsMap.get(postId);
        if (!post) {
            keep.add(postId);
            return;
        }
        for (const cid of cidsToKeepForPost(post, keepMode)) {
            keep.add(cid);
        }
    };

    for (const id of own) addPost(id, 'author');
    for (const id of saved) addPost(id, 'save');
    // Aggressive reclaim drops liked holds to free space for uploads
    if (mode === 'normal') {
        for (const id of liked) {
            if (own.has(id) || saved.has(id)) continue;
            addPost(id, 'like');
        }
    }

    // Published identity / feed tip chunks must survive GC
    if (userState.extendedUserState) keep.add(userState.extendedUserState);
    for (const c of extraRoots) {
        if (c) keep.add(c);
    }

    return keep;
}

export type ClearMediaResult = {
    blocksDeleted: number;
    rootsUnpinned: number;
    wipedBlockstore?: boolean;
};

/**
 * Sweep Helia blockstore: keep only pin-policy roots (+ identity), delete the rest.
 * Also clears the lightweight IndexedDB content cache (post/state heads).
 * When `wipeIfStillFull` + `bytesNeeded` are set, deletes the whole media IDB if
 * headroom is still insufficient (Firefox often won't free space until DB delete).
 */
export async function clearUnneededMedia(
    userState: UserState,
    postsMap: Map<string, Post>,
    myPeerId: string,
    opts?: {
        mode?: MediaGcMode;
        extraRoots?: Iterable<string>;
        clearIdbCache?: boolean;
        wipeIfStillFull?: boolean;
        bytesNeeded?: number;
    }
): Promise<ClearMediaResult> {
    if (!isHeliaAvailable()) return { blocksDeleted: 0, rootsUnpinned: 0 };
    await startHelia();

    const mode = opts?.mode ?? 'normal';
    const keep = buildMediaKeepSet(
        userState,
        postsMap,
        myPeerId,
        mode,
        opts?.extraRoots
    );

    let blocksDeleted = 0;
    let rootsUnpinned = 0;
    try {
        const swept = await withTimeout(heliaSweepExcept(keep), 25_000, 'heliaSweepExcept');
        blocksDeleted = swept.blocksDeleted;
        rootsUnpinned = swept.rootsUnpinned;
    } catch (e) {
        console.warn('[MediaGc] Sweep failed/timed out — falling through to wipe if requested', e);
        if (opts?.wipeIfStillFull) {
            await wipeHeliaBlockstore();
            try {
                await clearContentCache();
            } catch { /* ignore */ }
            return { blocksDeleted: 0, rootsUnpinned: 0, wipedBlockstore: true };
        }
    }

    if (opts?.clearIdbCache !== false) {
        try {
            await clearContentCache();
        } catch { /* ignore */ }
    }

    if (opts?.wipeIfStillFull && opts.bytesNeeded != null) {
        const ok = await hasStorageHeadroom(opts.bytesNeeded);
        if (!ok) {
            console.warn('[MediaGc] Sweep left quota tight — wiping Helia blockstore IDB');
            await wipeHeliaBlockstore();
            try {
                await clearContentCache();
            } catch { /* ignore */ }
            return { blocksDeleted, rootsUnpinned, wipedBlockstore: true };
        }
    }

    return { blocksDeleted, rootsUnpinned };
}

/**
 * Fast path before upload: skip slow getAll() sweeps (can hang Firefox for minutes).
 * Wipe the media blockstore IDB when headroom is insufficient.
 */
export async function reclaimStorageForUpload(bytesNeeded: number): Promise<ClearMediaResult> {
    if (!isHeliaAvailable()) return { blocksDeleted: 0, rootsUnpinned: 0 };
    if (await hasStorageHeadroom(bytesNeeded)) {
        return { blocksDeleted: 0, rootsUnpinned: 0 };
    }
    console.warn('[MediaGc] Low headroom — wiping Helia blockstore before upload (skip slow sweep)');
    try {
        // No Promise.race timeout — abandoning wipe mid-flight re-opens IDB races.
        // deleteIndexedDb retries are bounded (~10s); restart is quick after close.
        await wipeHeliaBlockstore();
        try {
            await clearContentCache();
        } catch { /* ignore */ }
        return { blocksDeleted: 0, rootsUnpinned: 0, wipedBlockstore: true };
    } catch (e) {
        console.error('[MediaGc] wipe failed', e);
        throw e instanceof Error
            ? e
            : new Error('Failed to free local storage. Close other tabs on this app and retry.');
    }
}
