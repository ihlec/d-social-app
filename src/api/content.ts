import { DEFAULT_USER_STATE_CID } from '../constants';
import { UserState, Post, Follow } from '../types';
import { fetchFromGateways, toGatewayUrl, getRankedGateways } from './gatewayUtils';
import { getSession } from './session';

export async function fetchPost<T = Post | UserState | any>(cid: string): Promise<T | null> {
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

export async function fetchPostLocal(cid: string, authorHint: string): Promise<Post | UserState | any> {
    const data = await fetchPost(cid);
    if (data) return data;
    return { id: cid, authorKey: authorHint, content: `[Content Unavailable]`, timestamp: 0, replies: [] };
}

export const createEmptyUserState = (profile: { name: string }): UserState => ({
    profile: profile, postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], updatedAt: 0, extendedUserState: null,
});

export async function fetchUserStateChunk(cid: string): Promise<Partial<UserState>> {
    try {
        const data = await fetchPost(cid);
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
    let aggregatedState: Partial<UserState> = { postCIDs: [], follows: [], likedPostCIDs: [], dislikedPostCIDs: [], profile: undefined, updatedAt: 0 };
    let currentCid: string | null = cid; 
    let isHead = true; 
    let chunksProcessed = 0; 

    while (currentCid && chunksProcessed < 50) {
        if (currentCid === DEFAULT_USER_STATE_CID) return createEmptyUserState({ name: profileNameHint || "User" });
        chunksProcessed++; 
        try {
            const chunk = await fetchUserStateChunk(currentCid); 
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

export const getMediaUrl = (cidOrUrl: string): string => {
    if (!cidOrUrl) return '';
    let cid = cidOrUrl;
    const cidMatch = cidOrUrl.match(/(baf[a-z0-9]{50,}|Qm[a-zA-Z0-9]{44,})/);
    if (cidMatch) {
        cid = cidMatch[0]; 
    } else if (cidOrUrl.startsWith('http') || cidOrUrl.startsWith('blob:')) {
        return cidOrUrl;
    }
    
    const session = getSession();
    if (session.sessionType === 'kubo' && session.rpcApiUrl) {
         return `${toGatewayUrl(session.rpcApiUrl)}/ipfs/${cid}`;
    }

    const gateways = getRankedGateways('ipfs');
    const bestGateway = gateways.length > 0 ? gateways[0] : 'https://ipfs.io/ipfs/';
    return `${bestGateway}${cid}`;
};
