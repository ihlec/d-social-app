import { DEFAULT_USER_STATE_CID } from '../constants';
import { UserState, Post, Follow } from '../types';
import { isPeerId } from '../lib/utils';
import { fetchFromGateways } from './gatewayUtils';
import { heliaCatJson, getHeliaStatus } from './heliaNode';
import { isGatewayFallbackEnabled } from '../lib/gatewayFallback';

export async function fetchPost<T = Post | UserState | any>(
    cid: string,
    authorHint?: string
): Promise<T | null> {
    // Local CAS first — content we just wrote is not on public gateways.
    if (getHeliaStatus().status === 'ready') {
        try {
            const local = await heliaCatJson<T>(cid);
            if (local && typeof local === 'object') {
                return { ...(local as object), id: cid } as T;
            }
        } catch { /* fall through */ }
    }

    // Author home-shard P2P (profile / feed) when we know who holds the CID
    const author = (authorHint || '').trim();
    if (isPeerId(author)) {
        try {
            const { requestPeerPost } = await import('./pubsub');
            const p2p = await requestPeerPost(author, cid);
            if (p2p && typeof p2p === 'object') {
                return { ...(p2p as object), id: cid } as T;
            }
        } catch { /* fall through */ }
    }

    // Content-room P2P only when already joined (PostPage sticky) — avoids explore stalls
    try {
        const { isContentRoomJoined, requestContentPost } = await import('./pubsub');
        if (isContentRoomJoined(cid)) {
            const p2p = await requestContentPost(cid);
            if (p2p && typeof p2p === 'object') {
                return { ...(p2p as object), id: cid } as T;
            }
        }
    } catch { /* fall through */ }

    if (!isGatewayFallbackEnabled()) return null;

    const result = await fetchFromGateways(
        `/ipfs/${cid}`,
        'ipfs',
        async (res) => {
            const data = await res.json();
            return { ...data, id: cid } as T;
        }
    );
    return result;
}

/**
 * Fetch a post for feed/profile. Returns null on miss — never inserts
 * "[Content Unavailable]" placeholders into the post map.
 */
export async function fetchPostLocal(cid: string, authorHint: string): Promise<Post | null> {
    const data = await fetchPost<Post>(cid, authorHint);
    if (data && typeof data === 'object' && data.id) {
        if (!data.authorKey && authorHint) data.authorKey = authorHint;
        // Reject legacy / accidental placeholders
        if (data.timestamp === 0 && typeof data.content === 'string' && data.content.includes('Content Unavailable')) {
            return null;
        }
        return data;
    }
    return null;
}

export const createEmptyUserState = (profile: { name: string }): UserState => ({
    profile: profile,
    postCIDs: [],
    follows: [],
    likedPostCIDs: [],
    dislikedPostCIDs: [],
    savedPostCIDs: [],
    blockedUsers: [],
    updatedAt: 0,
    extendedUserState: null,
});

export async function fetchUserStateChunk(
    cid: string,
    authorHint?: string
): Promise<Partial<UserState>> {
    try {
        const author = isPeerId(authorHint) ? authorHint : undefined;
        const data = await fetchPost(cid, author);
        if (!data) {
            throw new Error(`Failed to fetch state chunk: ${cid}`);
        }
        return data as Partial<UserState>;
    } catch (e: any) {
        // Re-throw with more context for backoff handling
        const error = e instanceof Error ? e : new Error(String(e));
        if (error.message.includes('504') || error.message.includes('Gateway Timeout') || error.message.includes('timeout')) {
            error.message = `Gateway timeout: ${cid}`;
        }
        throw error;
    }
}

export async function fetchUserState(cid: string, profileNameHint?: string): Promise<UserState> {
    let aggregatedState: Partial<UserState> = {
        postCIDs: [],
        follows: [],
        likedPostCIDs: [],
        dislikedPostCIDs: [],
        savedPostCIDs: [],
        blockedUsers: [],
        profile: undefined,
        updatedAt: 0,
    };
    let currentCid: string | null = cid; 
    let isHead = true; 
    let chunksProcessed = 0;
    /** Callers often pass peer id as the second arg — use it for home-shard P2P. */
    const authorHint = isPeerId(profileNameHint) ? profileNameHint : undefined;

    while (currentCid && chunksProcessed < 50) {
        if (currentCid === DEFAULT_USER_STATE_CID) return createEmptyUserState({ name: profileNameHint || "User" });
        chunksProcessed++; 
        try {
            const chunk = await fetchUserStateChunk(currentCid, authorHint); 
            if (!chunk) throw new Error("Empty chunk");
            if (isHead) { 
                aggregatedState.profile = chunk.profile; 
                aggregatedState.updatedAt = chunk.updatedAt || 0; 
                isHead = false; 
            }
            aggregatedState.postCIDs = [...(aggregatedState.postCIDs || []), ...(chunk.postCIDs || [])];
            aggregatedState.follows = [...(aggregatedState.follows || []), ...(chunk.follows || [])];
            aggregatedState.likedPostCIDs = [...(aggregatedState.likedPostCIDs || []), ...(chunk.likedPostCIDs || [])];
            aggregatedState.dislikedPostCIDs = [...(aggregatedState.dislikedPostCIDs || []), ...(chunk.dislikedPostCIDs || [])];
            aggregatedState.savedPostCIDs = [...(aggregatedState.savedPostCIDs || []), ...(chunk.savedPostCIDs || [])];
            aggregatedState.blockedUsers = [...(aggregatedState.blockedUsers || []), ...(chunk.blockedUsers || [])];
            currentCid = chunk.extendedUserState || null;
        } catch (error) { if (isHead) throw error; else currentCid = null; }
    }
    const uniqueFollows = new Map<string, Follow>();
    (aggregatedState.follows || []).forEach(f => uniqueFollows.set(f.ipnsKey, f));
    return {
        profile: aggregatedState.profile || { name: profileNameHint || 'Unknown' },
        postCIDs: [...new Set(aggregatedState.postCIDs)],
        follows: Array.from(uniqueFollows.values()),
        likedPostCIDs: [...new Set(aggregatedState.likedPostCIDs)],
        dislikedPostCIDs: [...new Set(aggregatedState.dislikedPostCIDs)],
        savedPostCIDs: [...new Set(aggregatedState.savedPostCIDs)],
        blockedUsers: [...new Set(aggregatedState.blockedUsers)],
        updatedAt: aggregatedState.updatedAt || 0,
        extendedUserState: null 
    };
}

export async function fetchCidsBatched<T>(
    cids: string[], 
    fetcher: (cid: string) => Promise<T>, 
    batchSize: number = 4
): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(cids.length).fill(null);
    let index = 0;

    async function worker() {
        while (index < cids.length) {
            const i = index++;
            try {
                results[i] = await fetcher(cids[i]);
            } catch (e) {
                console.warn(`[Batch] Failed ${cids[i]}`);
                results[i] = null;
            }
        }
    }

    const workers = Array(Math.min(cids.length, batchSize)).fill(null).map(() => worker());
    await Promise.all(workers);
    return results;
}

