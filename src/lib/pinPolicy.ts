/**
 * Pin policy for browser Helia:
 * - Author: post + media + thumbnail
 * - Like: post + media + thumbnail (serve commitment — holder for want/content rooms)
 * - Save: same pin set as like (bookmark + full hold)
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
    // Author, like, and save all hold full media so peers can fetch after OP churn.
    if (mode === 'author' || mode === 'like' || mode === 'save') {
        if (post.mediaCid && !post.mediaCid.startsWith('http')) {
            out.push(post.mediaCid);
        }
    }
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

async function ensurePinnedMedia(
    cid: string | undefined,
    author: string,
    mimeHint?: string,
    sizeHint = 20 * 1024 * 1024
): Promise<{ ok: boolean; reason?: string }> {
    if (!cid || cid.startsWith('http')) return { ok: true };
    if (await pinIfLocal(cid)) return { ok: true };

    if (!(await hasStorageHeadroom(sizeHint))) {
        return { ok: false, reason: 'Browser storage is nearly full — free space or clear media cache.' };
    }
    if (!author) {
        return { ok: false, reason: 'Author unknown — cannot fetch media over P2P.' };
    }

    const url = await requestPeerMedia(author, cid, mimeHint);
    if (!url) {
        return { ok: false, reason: 'Author offline or media unavailable over P2P.' };
    }
    if (!(await pinIfLocal(cid))) {
        return { ok: false, reason: 'Media loaded for viewing but could not be pinned (storage full).' };
    }
    return { ok: true };
}

/**
 * Pin post JSON + thumbnail + full media (P2P from author when needed).
 * Used by both like (serve commitment) and explicit save.
 */
async function pinFullPost(post: Post): Promise<{ ok: boolean; reason?: string }> {
    if (!post?.id) return { ok: false, reason: 'missing post' };
    const author = post.authorKey || '';

    await pinIfLocal(post.id);

    const thumbResult = await ensurePinnedMedia(
        post.thumbnailCid,
        author,
        'image/jpeg',
        512 * 1024
    );
    if (!thumbResult.ok) {
        // Thumb miss is non-fatal when there is no thumb; warn only if present.
        if (post.thumbnailCid) {
            console.warn('[PinPolicy] thumbnail pin:', thumbResult.reason);
        }
    }

    const media = post.mediaCid;
    if (!media || media.startsWith('http')) return { ok: true };

    return ensurePinnedMedia(media, author);
}

/**
 * Like = serve commitment: pull and pin post + thumb + full media when possible.
 */
export async function pinForLike(post: Post): Promise<{ ok: boolean; reason?: string }> {
    return pinFullPost(post);
}

/**
 * Explicit Save: same full hold as like (bookmark semantics in UI).
 */
export async function pinForSave(post: Post): Promise<{ ok: boolean; reason?: string }> {
    return pinFullPost(post);
}

/** Remove a CID DAG from local Helia (unpin + delete blocks). */
export async function dropLocalCid(cid?: string): Promise<number> {
    if (!cid || cid.startsWith('http')) return 0;
    return heliaDeleteDag(cid);
}
