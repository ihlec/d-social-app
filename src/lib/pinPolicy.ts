/**
 * Pin policy for browser Helia:
 * - Author: post + media + thumbnail
 * - Like: post + thumbnail only (not full video)
 * - Save: post + media + thumbnail (quota-gated P2P fetch)
 */

import type { Post } from '../types';
import { pinCid } from '../api/admin';
import { heliaHasBlock, startHelia, isHeliaAvailable, isStorageQuotaError } from '../api/heliaNode';
import { heliaDeleteDag } from '../api/heliaBlocks';
import { requestPeerMedia } from '../api/pubsub';
import { hasStorageHeadroom } from './storageQuota';

export type PinKeepMode = 'author' | 'like' | 'save';

/** CIDs that should stay pinned for a post under the given mode. */
export function cidsToKeepForPost(post: Post, mode: PinKeepMode): string[] {
    const out: string[] = [];
    if (post.id && !post.id.startsWith('http') && !post.id.startsWith('temp-')) {
        out.push(post.id);
    }
    if (post.thumbnailCid && !post.thumbnailCid.startsWith('http')) {
        out.push(post.thumbnailCid);
    }
    if (mode === 'author' || mode === 'save') {
        if (post.mediaCid && !post.mediaCid.startsWith('http')) {
            out.push(post.mediaCid);
        }
    }
    // like: intentionally omit full mediaCid for videos/images (thumb is enough for feed)
    return out;
}

async function pinIfLocal(cid: string): Promise<boolean> {
    if (!isHeliaAvailable()) return false;
    try {
        await startHelia();
        if (!(await heliaHasBlock(cid))) return false;
        await pinCid(cid);
        return true;
    } catch (e) {
        if (isStorageQuotaError(e) || String(e).includes('storage is full')) return false;
        console.debug('[PinPolicy] pin failed', cid.slice(0, 12), e);
        return false;
    }
}

/**
 * After like: ensure post JSON + thumbnail are local (P2P from author) and pinned.
 * Does not pin full video/media bodies.
 */
export async function pinForLike(post: Post): Promise<void> {
    if (!post?.id) return;
    const author = post.authorKey || '';

    // Post JSON — usually already in memory; pin if local
    await pinIfLocal(post.id);

    const thumb = post.thumbnailCid;
    if (!thumb || thumb.startsWith('http')) return;

    if (await pinIfLocal(thumb)) return;

    if (!author) return;
    const sizeHint = 512 * 1024; // thumbs are small
    if (!(await hasStorageHeadroom(sizeHint))) {
        console.warn('[PinPolicy] skip thumb pin — low storage headroom');
        return;
    }

    const url = await requestPeerMedia(author, thumb, 'image/jpeg');
    if (url) await pinIfLocal(thumb);
}

/**
 * Explicit Save: pull full media from author over P2P and pin when quota allows.
 */
export async function pinForSave(post: Post): Promise<{ ok: boolean; reason?: string }> {
    if (!post?.id) return { ok: false, reason: 'missing post' };
    const author = post.authorKey || '';

    await pinIfLocal(post.id);
    if (post.thumbnailCid) {
        await pinForLike(post);
    }

    const media = post.mediaCid;
    if (!media || media.startsWith('http')) return { ok: true };

    if (await pinIfLocal(media)) return { ok: true };

    // Need bytes — check headroom (assume up to 20MB if unknown)
    const need = 20 * 1024 * 1024;
    if (!(await hasStorageHeadroom(need))) {
        return { ok: false, reason: 'Browser storage is nearly full — free space or clear media cache.' };
    }

    if (!author) {
        return { ok: false, reason: 'Author unknown — cannot fetch media over P2P.' };
    }

    const url = await requestPeerMedia(author, media);
    if (!url) {
        return { ok: false, reason: 'Author offline or media unavailable over P2P.' };
    }
    const pinned = await pinIfLocal(media);
    if (!pinned) {
        // Ephemeral blob may still play; pin failed (quota)
        return { ok: false, reason: 'Media loaded for viewing but could not be pinned (storage full).' };
    }
    return { ok: true };
}

/** Remove a CID DAG from local Helia (unpin + delete blocks). */
export async function dropLocalCid(cid?: string): Promise<number> {
    if (!cid || cid.startsWith('http')) return 0;
    return heliaDeleteDag(cid);
}
