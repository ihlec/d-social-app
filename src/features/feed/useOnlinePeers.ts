import { useEffect, useRef, useState } from 'react';
import { UserState, OnlinePeer, Post } from '../../types';
import {
    getSession,
    publishToPubsub,
    subscribeToPubsub,
    getDiscoveryTopics,
    setPeerFeedProvider,
    setSelfPresenceKey,
    heliaCatJson,
    publishIpns,
    getHeliaStatus,
} from '../../api/ipfsIpns';
import { getLatestLocalCid } from '../../lib/utils';
import {
    DEV_LOCAL_RENDEZVOUS_TOPIC,
    MAX_MAPPED_ONLINE_PEERS,
    PEER_DISCOVERY_TOPIC,
} from '../../constants';
import type { PresencePayload, PeerFeedSnapshot } from '../../api/pubsub';
import { circleTopic, homeShard, shardTopic } from '../../lib/peerShards';

const HEARTBEAT_INTERVAL_MS = 30000;
/** Social/circle rooms: lower announce rate. */
const CIRCLE_HEARTBEAT_EVERY_N = 2;
const PRUNE_INTERVAL_MS = 5000;
const PEER_TIMEOUT_MS = 90000;
/** Posts bundled in syncFeed — enough for a profile first screen without N round-trips. */
const MAX_SYNC_POSTS = 20;
/** App-level nudge so multi-hour tabs re-advertise IPNS while visible. */
const IPNS_KEEPALIVE_MS = 18 * 60 * 1000;

interface UseAppPeersArgs {
    isLoggedIn: boolean | null;
    myPeerId: string;
    userState: UserState | null;
}

export const useAppPeers = ({
    isLoggedIn,
    myPeerId,
    userState,
}: UseAppPeersArgs) => {
    const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    const peersMapRef = useRef<Map<string, { peer: OnlinePeer, lastSeen: number }>>(new Map());
    const profileNameRef = useRef(userState?.profile?.name || '');
    profileNameRef.current = userState?.profile?.name || '';
    const userStateRef = useRef(userState);
    userStateRef.current = userState;

    // Serve our local Helia feed to peers over Trystero (gateways won't have it yet).
    useEffect(() => {
        if (isLoggedIn !== true || !myPeerId) {
            setPeerFeedProvider(null);
            return;
        }

        setPeerFeedProvider(async (): Promise<PeerFeedSnapshot> => {
            const state = userStateRef.current;
            const session = getSession();
            const label = session.ipnsKeyName || '';
            const stateCid =
                (label && getLatestLocalCid(label)) ||
                (myPeerId && getLatestLocalCid(myPeerId)) ||
                '';

            if (!state) {
                return { ok: false, ipnsKey: myPeerId, stateCid, state: null, posts: [] };
            }

            const posts: Post[] = [];
            for (const cid of (state.postCIDs || []).slice(0, MAX_SYNC_POSTS)) {
                try {
                    const post = await heliaCatJson<Post>(cid);
                    if (post && typeof post === 'object') {
                        posts.push({
                            ...post,
                            id: post.id || cid,
                            authorKey: post.authorKey || myPeerId,
                        });
                    }
                } catch { /* skip missing local blocks */ }
            }

            return {
                ok: true,
                ipnsKey: myPeerId,
                stateCid,
                state,
                posts,
            };
        });

        return () => setPeerFeedProvider(null);
    }, [isLoggedIn, myPeerId]);

    const followKeysKey = (userState?.follows || [])
        .map((f) => f?.ipnsKey)
        .filter(Boolean)
        .join(',');

    useEffect(() => {
        if (isLoggedIn !== true || !myPeerId) return;

        const session = getSession();
        if (session.sessionType !== 'helia') {
            return;
        }

        setSelfPresenceKey(myPeerId);

        const abortController = new AbortController();
        const keyLabel = session.ipnsKeyName || '';
        const followKeys = followKeysKey
            ? followKeysKey.split(',').filter(Boolean)
            : [];

        const handleMessage = (msg: PresencePayload, trysteroPeerId?: string) => {
            if (!msg?.ipnsKey || !msg.name || !msg.timestamp) return;
            if (msg.ipnsKey === myPeerId) return;

            peersMapRef.current.set(msg.ipnsKey, {
                peer: {
                    ipnsKey: msg.ipnsKey,
                    name: msg.name,
                    stateCid: msg.stateCid,
                    trysteroPeerId,
                },
                lastSeen: Date.now(),
            });

            // Cap local UI peer map (same order of magnitude as pubsub LRU).
            if (peersMapRef.current.size > MAX_MAPPED_ONLINE_PEERS) {
                let oldestKey: string | null = null;
                let oldest = Infinity;
                peersMapRef.current.forEach((val, key) => {
                    if (val.lastSeen < oldest) {
                        oldest = val.lastSeen;
                        oldestKey = key;
                    }
                });
                if (oldestKey) peersMapRef.current.delete(oldestKey);
            }
        };

        // Hash shards + circle rooms + custom (+ legacy only if Settings opts in).
        // Prefer home / ego circle first; legacy last so it never starves shard ICE.
        const topics = getDiscoveryTopics(myPeerId, followKeys);
        const circleTopics = new Set(topics.filter((t) => t.startsWith('dsocial-circle/')));
        const homeTopic = shardTopic(homeShard(myPeerId));
        const egoCircle = circleTopic(myPeerId);
        const joinOrder = [...topics].sort((a, b) => {
            const rank = (t: string) => {
                if (t === homeTopic) return 0;
                if (t === egoCircle) return 1;
                if (t === DEV_LOCAL_RENDEZVOUS_TOPIC) return 2;
                if (t.startsWith('dsocial-peers-v2/')) return 3;
                if (t.startsWith('dsocial-circle/')) return 4;
                if (t === PEER_DISCOVERY_TOPIC) return 6;
                return 5;
            };
            return rank(a) - rank(b);
        });

        // Stagger joins — parallel room joins cause ICE storms / failed SDP.
        const JOIN_STAGGER_MS = 400;
        void (async () => {
            for (let i = 0; i < joinOrder.length; i++) {
                if (abortController.signal.aborted) return;
                void subscribeToPubsub(joinOrder[i], handleMessage, abortController.signal);
                if (i < joinOrder.length - 1) {
                    await new Promise((r) => setTimeout(r, JOIN_STAGGER_MS));
                }
            }
        })();

        let beat = 0;
        const heartbeat = () => {
            const name = profileNameRef.current;
            if (!name) return;
            const stateCid =
                (keyLabel && getLatestLocalCid(keyLabel)) ||
                getLatestLocalCid(myPeerId) ||
                undefined;
            const presence: PresencePayload = {
                ipnsKey: myPeerId,
                name,
                timestamp: Date.now(),
                ...(stateCid ? { stateCid } : {}),
            };
            beat += 1;
            for (const topic of topics) {
                // Circle rooms: every Nth beat to cut announce traffic
                if (circleTopics.has(topic) && beat % CIRCLE_HEARTBEAT_EVERY_N !== 0) {
                    continue;
                }
                publishToPubsub(topic, presence)
                    .catch((e: any) => console.warn('[useAppPeers] Heartbeat failed:', e));
            }
        };

        const heartbeatInterval = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
        heartbeat();

        const republishIpnsKeepalive = () => {
            if (typeof document !== 'undefined' && document.hidden) return;
            if (getHeliaStatus().status !== 'ready') return;
            if (!keyLabel) return;
            const stateCid =
                getLatestLocalCid(keyLabel) ||
                getLatestLocalCid(myPeerId) ||
                '';
            if (!stateCid) return;
            publishIpns(keyLabel, stateCid).catch((e: unknown) => {
                console.warn('[useAppPeers] IPNS keepalive failed:', e);
            });
        };
        const keepaliveInterval = setInterval(republishIpnsKeepalive, IPNS_KEEPALIVE_MS);

        const updatePeersState = () => {
            const now = Date.now();
            const activePeers: OnlinePeer[] = [];

            peersMapRef.current.forEach((val, key) => {
                if (now - val.lastSeen < PEER_TIMEOUT_MS) {
                    activePeers.push(val.peer);
                } else {
                    peersMapRef.current.delete(key);
                }
            });
            setOtherUsers(activePeers);
        };
        const pruneInterval = setInterval(updatePeersState, PRUNE_INTERVAL_MS);

        return () => {
            abortController.abort();
            clearInterval(heartbeatInterval);
            clearInterval(keepaliveInterval);
            clearInterval(pruneInterval);
        };
    }, [isLoggedIn, myPeerId, followKeysKey]);

    useEffect(() => {
        if (isLoggedIn !== true) {
            peersMapRef.current.clear();
            setOtherUsers([]);
            setSelfPresenceKey('');
        }
    }, [isLoggedIn]);

    return { otherUsers };
};
