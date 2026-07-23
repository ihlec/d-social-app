/**
 * After a tip sync, pull thumbnail/media CIDs from the author's Helia over Trystero.
 */

import { requestPeerMedia } from '../api/pubsub';
import { heliaHasBlock, isHeliaAvailable, startHelia } from '../api/heliaNode';
import { MAX_P2P_MEDIA_PER_SYNC } from '../constants';
import type { Post } from '../types';

const inFlight = new Set<string>();

function collectMediaCids(posts: Post[]): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();

    const push = (cid?: string) => {
        if (!cid || cid.startsWith('http') || seen.has(cid)) return;
        seen.add(cid);
        ordered.push(cid);
    };

    // Thumbnails first (feed preview). Skip full video bodies — pulling multi‑MB
    // files into RAM over Trystero crashes Chromium tabs.
    for (const p of posts) push(p.thumbnailCid);
    for (const p of posts) {
        if (p.mediaType === 'video') continue;
        push(p.mediaCid);
    }

    return ordered.slice(0, MAX_P2P_MEDIA_PER_SYNC);
}

/** Best-effort: fetch missing media from `fromIpnsKey` into local Helia. */
export async function prefetchPeerMedia(
    fromIpnsKey: string,
    posts: Post[]
): Promise<void> {
    if (!fromIpnsKey || posts.length === 0) return;

    const cids = collectMediaCids(posts);
    if (cids.length === 0) return;

    if (isHeliaAvailable()) {
        try {
            await startHelia();
        } catch {
            return;
        }
    }

    for (const cid of cids) {
        const key = `${fromIpnsKey}:${cid}`;
        if (inFlight.has(key)) continue;
        inFlight.add(key);
        try {
            if (isHeliaAvailable() && (await heliaHasBlock(cid))) continue;
            await requestPeerMedia(fromIpnsKey, cid); // thumbs / images only
        } catch (e) {
            console.debug(`[PrefetchMedia] ${cid.slice(0, 12)}…`, e);
        } finally {
            inFlight.delete(key);
        }
    }
}
