/**
 * Local post library a peer can snowball to others over syncFeed:
 * own posts (newest first) + liked (newest first) + saved.
 */

import type { Post, UserState } from '../types';

/** Max posts returned in one syncFeed page (own + library mix). */
export const SYNC_FEED_PAGE_SIZE = 24;

/** Build ordered CID list for P2P library sync. */
export function libraryCidsFromState(state: UserState | null | undefined): string[] {
    if (!state) return [];
    const own = state.postCIDs || [];
    const likedNewestFirst = [...(state.likedPostCIDs || [])].reverse();
    const saved = state.savedPostCIDs || [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const cid of [...own, ...likedNewestFirst, ...saved]) {
        const c = (cid || '').trim();
        if (!c || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
    }
    return out;
}

export function libraryPage(
    state: UserState | null | undefined,
    offset = 0,
    pageSize = SYNC_FEED_PAGE_SIZE
): { cids: string[]; nextOffset: number | null } {
    const all = libraryCidsFromState(state);
    const start = Math.max(0, offset | 0);
    const cids = all.slice(start, start + pageSize);
    const end = start + cids.length;
    const nextOffset = end < all.length ? end : null;
    return { cids, nextOffset };
}

/** Authors of posts that aren't the serving peer — snowball crawl seeds. */
export function foreignAuthorsFromPosts(
    posts: Post[],
    selfIpnsKey: string
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of posts) {
        const a = (p.authorKey || '').trim();
        if (!a || a === selfIpnsKey || seen.has(a)) continue;
        seen.add(a);
        out.push(a);
    }
    return out;
}
