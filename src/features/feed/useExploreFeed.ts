import { useState, useCallback, useRef, useEffect } from 'react';
import { Post, UserProfile, UserState, OnlinePeer } from '../../types';
import { fetchPost, resolveIpns, fetchUserStateChunk, requestPeerFeed } from '../../api/ipfsIpns';
import { isLocalClusterPeer } from '../../lib/peerShards';
import { prefetchPeerMedia } from '../../lib/prefetchPeerMedia';

const EXPLORE_CONCURRENCY_LIMIT = 3;
const ONLINE_PEER_INGEST_LIMIT = 5;
const MAX_POSTS_PER_AUTHOR = 5;
const MAX_CRAWL_DEPTH = 2; // Friends of Friends only

/** Real IPNS/CID names only — skip display labels like "ccc" / "Tom". */
function isResolvableKey(key: string): boolean {
    return /^(k51|k2|Qm|bafy|bafk)/i.test(key);
}

function shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

interface UseAppExploreArgs {
    /** Resolved k51 identity — same key space as OnlinePeer / follow.ipnsKey. */
    myPeerId: string;
    userState: UserState | null;
    allPostsMap: Map<string, Post>;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    fetchMissingParentPost: (parentCID: string) => Promise<void>;
    otherUsers: OnlinePeer[];
    enabled: boolean;
}

export interface UseAppExploreReturn {
    isLoadingExplore: boolean;
    loadMoreExplore: () => Promise<void>;
    refreshExploreFeed: () => Promise<void>;
    canLoadMoreExplore: boolean;
}

export const useAppExplore = ({
    myPeerId,
    userState,
    allPostsMap,
    setAllPostsMap,
    setUserProfilesMap,
    fetchMissingParentPost,
    otherUsers,
    enabled
}: UseAppExploreArgs): UseAppExploreReturn => {

    const [isLoadingExplore, setIsLoadingExplore] = useState<boolean>(false);
    const [canLoadMoreExplore, setCanLoadMoreExplore] = useState<boolean>(true);

    // Traversal State
    const processedFollowFetchKeys = useRef<Set<string>>(new Set());
    const currentBatchKeys = useRef<string[]>([]);
    const nextLayerKeys = useRef<Set<string>>(new Set());
    const currentDepth = useRef<number>(0);
    const busyRef = useRef(false);
    const allPostsMapRef = useRef(allPostsMap);
    allPostsMapRef.current = allPostsMap;
    const otherUsersRef = useRef(otherUsers);
    otherUsersRef.current = otherUsers;
    const userStateRef = useRef(userState);
    userStateRef.current = userState;

    const processKeysBatch = useCallback(async (keys: string[]) => {
        const results = await Promise.allSettled(keys.map(async (key) => {
            if (!isResolvableKey(key)) {
                console.debug('[Explore] Skipping non-IPNS seed', key);
                return null;
            }
            // Own profile is already in local state — no gateway / P2P round-trip
            if (key === myPeerId) return null;

            let state: Partial<UserState> | null = null;
            let newPosts: Post[] = [];
            const isOnline = otherUsersRef.current.some(u => u.ipnsKey === key);

            // 1) WebRTC sync — required for browser-only peers (public IPNS won't have them)
            let p2p = await requestPeerFeed(key);
            if (!p2p?.ok && isOnline) {
                for (let attempt = 0; attempt < 4 && !p2p?.ok; attempt++) {
                    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                    p2p = await requestPeerFeed(key);
                }
            }

            if (p2p?.ok && p2p.state) {
                state = p2p.state;
                newPosts = (p2p.posts || [])
                    .filter(p => p?.id && !allPostsMapRef.current.has(p.id))
                    .map(p => ({
                        ...p,
                        authorKey: p.authorKey || key,
                    }));
                console.debug(`[Explore] P2P sync from ${key.slice(0, 12)}… — ${newPosts.length} post(s)`);
                if (newPosts.length > 0) {
                    void prefetchPeerMedia(key, newPosts);
                }
            } else if (isOnline) {
                // Online via Trystero but sync failed — do NOT hammer public gateways.
                console.warn(`[Explore] P2P sync failed for online peer ${key.slice(0, 12)}… — skipping gateway`);
                return null;
            } else {
                // 2) Offline follows / crawl: public resolve + gateway/local Helia
                const stateCid = await resolveIpns(key);
                if (!stateCid) return null;

                state = await fetchUserStateChunk(stateCid, key);
                if (!state) return null;

                if (state.postCIDs && state.postCIDs.length > 0) {
                    const candidateCids = state.postCIDs.slice(0, MAX_POSTS_PER_AUTHOR);
                    const cidsToFetch = candidateCids.filter(cid => !allPostsMapRef.current.has(cid));
                    if (cidsToFetch.length > 0) {
                        const fetchedPosts = await Promise.all(cidsToFetch.map(async (cid) => {
                            try {
                                const postData = await fetchPost(cid, key);
                                if (postData && postData.id) {
                                    if (!postData.authorKey) postData.authorKey = key;
                                    return postData as Post;
                                }
                            } catch { /* ignore */ }
                            return null;
                        }));
                        fetchedPosts.forEach(p => { if (p) newPosts.push(p); });
                    }
                }
            }

            if (!state) return null;

            if (state.profile) {
                setUserProfilesMap(prev => new Map(prev).set(key, state!.profile!));
            }

            // Only queue new users if we haven't hit the depth limit and they are NOT blocked
            if (currentDepth.current < MAX_CRAWL_DEPTH && state.follows) {
                const blockedSet = new Set(userStateRef.current?.blockedUsers || []);
                state.follows.forEach(f => {
                    if (f.ipnsKey && !processedFollowFetchKeys.current.has(f.ipnsKey) && !blockedSet.has(f.ipnsKey)) {
                        nextLayerKeys.current.add(f.ipnsKey);
                    }
                });
            }

            newPosts.forEach(p => {
                if (p.referenceCID) fetchMissingParentPost(p.referenceCID);
            });

            return { key, state, newPosts };
        }));

        const fetchedPostsMap = new Map<string, Post>();
        results.forEach(res => {
            if (res.status === 'fulfilled' && res.value) {
                res.value.newPosts.forEach(p => fetchedPostsMap.set(p.id, p));
            }
        });

        if (fetchedPostsMap.size > 0) {
            setAllPostsMap(prev => new Map([...prev, ...fetchedPostsMap]));
            console.debug(`[Explore] Ingested ${fetchedPostsMap.size} post(s) from ${keys.length} author(s)`);
        }
    }, [setAllPostsMap, setUserProfilesMap, fetchMissingParentPost, myPeerId]);

    const collectSeedKeys = useCallback((): string[] => {
        const blockedSet = new Set(userStateRef.current?.blockedUsers || []);
        const myFollowKeys = (userStateRef.current?.follows || []).map(f => f?.ipnsKey).filter((k): k is string => !!k);
        // otherUsers is already room-local (shards/circles/legacy we joined) — do not
        // re-filter by home shard or peers on shared rooms (e.g. v1 bridge) are dropped.
        const onlinePeerKeys = otherUsersRef.current
            .map(u => u.ipnsKey)
            .filter((k): k is string => !!k);
        const seedKeys = new Set([...myFollowKeys, ...onlinePeerKeys]);
        if (myPeerId) seedKeys.add(myPeerId);
        return Array.from(seedKeys).filter(
            k => isResolvableKey(k)
                && k !== myPeerId
                && !processedFollowFetchKeys.current.has(k)
                && !blockedSet.has(k)
        );
    }, [myPeerId]);

    const loadMoreExplore = useCallback(async () => {
        if (!enabled || busyRef.current) return;

        busyRef.current = true;
        setIsLoadingExplore(true);

        try {
            // Drain a few batches so peer injections mid-run still get processed.
            for (let step = 0; step < 4; step++) {
                if (currentBatchKeys.current.length === 0 && nextLayerKeys.current.size === 0) {
                    console.debug('[Explore] Queue empty. Auto-seeding from network...');
                    currentDepth.current = 0;

                    const seeds = collectSeedKeys();
                    if (seeds.length === 0) {
                        if (step === 0) console.debug('[Explore] No new seeds available.');
                        break;
                    }

                    seeds.forEach(k => processedFollowFetchKeys.current.add(k));
                    // Prefer: local-cluster online → other online → follows/offline
                    const onlineSet = new Set(otherUsersRef.current.map(u => u.ipnsKey));
                    const rank = (k: string) => {
                        const online = onlineSet.has(k);
                        const local = myPeerId ? isLocalClusterPeer(myPeerId, k) : false;
                        if (online && local) return 0;
                        if (online) return 1;
                        return 2;
                    };
                    currentBatchKeys.current = shuffleArray(seeds).sort((a, b) => rank(a) - rank(b));
                }

                if (currentBatchKeys.current.length === 0) {
                    if (nextLayerKeys.current.size > 0) {
                        currentDepth.current += 1;
                        console.debug(`[Explore] Advancing to Depth ${currentDepth.current}`);

                        const nextBatch = Array.from(nextLayerKeys.current);
                        nextBatch.forEach(k => processedFollowFetchKeys.current.add(k));
                        currentBatchKeys.current = shuffleArray(nextBatch);
                        nextLayerKeys.current.clear();
                    } else {
                        break;
                    }
                }

                const batch = currentBatchKeys.current.splice(0, EXPLORE_CONCURRENCY_LIMIT);
                if (batch.length === 0) break;
                await processKeysBatch(batch);
            }

            setCanLoadMoreExplore(
                currentBatchKeys.current.length > 0
                || nextLayerKeys.current.size > 0
                || collectSeedKeys().length > 0
            );
        } finally {
            busyRef.current = false;
            setIsLoadingExplore(false);
        }
    }, [enabled, processKeysBatch, collectSeedKeys]);

    /**
     * When Trystero peers appear after the first explore pass, pull their
     * recent posts into Explore (not My Feed).
     */
    useEffect(() => {
        if (!enabled || otherUsers.length === 0) return;

        const blockedSet = new Set(userState?.blockedUsers || []);
        const fresh = otherUsers
            .map(u => u.ipnsKey)
            .filter((k): k is string =>
                !!k
                && isResolvableKey(k)
                && k !== myPeerId
                && !blockedSet.has(k)
                && !processedFollowFetchKeys.current.has(k)
            );

        if (fresh.length === 0) return;

        const batch = shuffleArray(fresh).slice(0, ONLINE_PEER_INGEST_LIMIT);
        console.debug(`[Explore] Online peers joined — fetching latest from ${batch.length}:`, batch.map(k => k.slice(0, 12) + '…'));
        batch.forEach(k => processedFollowFetchKeys.current.add(k));
        currentBatchKeys.current.push(...batch);
        setCanLoadMoreExplore(true);

        let cancelled = false;
        const kick = async () => {
            // Wait out an in-flight explore pass, then drain the injected keys.
            for (let i = 0; i < 50 && busyRef.current; i++) {
                await new Promise(r => setTimeout(r, 100));
                if (cancelled) return;
            }
            if (!cancelled) await loadMoreExplore();
        };
        void kick();

        return () => { cancelled = true; };
    }, [otherUsers, enabled, myPeerId, userState?.blockedUsers, loadMoreExplore]);

    const refreshExploreFeed = useCallback(async () => {
        if (!enabled) return;
        processedFollowFetchKeys.current.clear();
        currentBatchKeys.current = [];
        nextLayerKeys.current.clear();
        currentDepth.current = 0;
        setCanLoadMoreExplore(true);
        await loadMoreExplore();
    }, [loadMoreExplore, enabled]);

    return {
        isLoadingExplore,
        loadMoreExplore,
        refreshExploreFeed,
        canLoadMoreExplore
    };
};