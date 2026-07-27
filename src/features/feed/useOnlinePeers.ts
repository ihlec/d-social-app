import { useEffect, useRef, useState } from 'react';
import { UserState, OnlinePeer, Post, UserProfile } from '../../types';
import { isUsefulDisplayName } from '../../lib/nameDirectory';
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
import { getLatestLocalCid, shortId } from '../../lib/utils';
import {
    BOOTSTRAP_TOPIC,
    DEV_LOCAL_RENDEZVOUS_TOPIC,
    MAX_MAPPED_ONLINE_PEERS,
    PEER_DISCOVERY_TOPIC,
} from '../../constants';
import type { PresencePayload, PeerFeedSnapshot, SyncRequest } from '../../api/pubsub';
import { circleTopic, homeShard, shardTopic } from '../../lib/peerShards';
import { libraryPage } from '../../lib/peerLibrary';

const HEARTBEAT_INTERVAL_MS = 30000;
const PRUNE_INTERVAL_MS = 5000;
/** Generous vs background-tab timer throttle — was 90s and peers vanished. */
const PEER_TIMEOUT_MS = 300_000;
/** App-level nudge so multi-hour tabs re-advertise IPNS while visible. */
const IPNS_KEEPALIVE_MS = 18 * 60 * 1000;
const JOIN_STAGGER_MS = 400;

interface UseAppPeersArgs {
    isLoggedIn: boolean | null;
    myPeerId: string;
    userState: UserState | null;
    setUserProfilesMap?: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
}

function rankDiscoveryTopics(topics: string[], myPeerId: string): string[] {
    const homeTopic = shardTopic(homeShard(myPeerId));
    const egoCircle = circleTopic(myPeerId);
    return [...topics].sort((a, b) => {
        const rank = (t: string) => {
            if (t === homeTopic) return 0;
            if (t === egoCircle) return 1;
            if (t === BOOTSTRAP_TOPIC) return 2;
            if (t === DEV_LOCAL_RENDEZVOUS_TOPIC) return 3;
            if (t.startsWith('dsocial-peers-v2/')) return 4;
            if (t.startsWith('dsocial-circle/')) return 5;
            if (t === PEER_DISCOVERY_TOPIC) return 7;
            return 6;
        };
        return rank(a) - rank(b);
    });
}

export const useAppPeers = ({
    isLoggedIn,
    myPeerId,
    userState,
    setUserProfilesMap,
}: UseAppPeersArgs) => {
    const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    const peersMapRef = useRef<Map<string, { peer: OnlinePeer; lastSeen: number }>>(new Map());
    const profileNameRef = useRef(userState?.profile?.name || '');
    profileNameRef.current = userState?.profile?.name || '';
    const userStateRef = useRef(userState);
    userStateRef.current = userState;
    const setProfilesRef = useRef(setUserProfilesMap);
    setProfilesRef.current = setUserProfilesMap;

    const stableTopicsRef = useRef<string[]>([]);
    const followTopicsRef = useRef<string[]>([]);
    /** Per-topic abort controllers for follow circles — survive follow-list diffs. */
    const followControllersRef = useRef<Map<string, AbortController>>(new Map());
    const heartbeatFnRef = useRef<() => void>(() => {});
    const pruneFnRef = useRef<() => void>(() => {});

    const followKeysKey = (userState?.follows || [])
        .map((f) => f?.ipnsKey)
        .filter(Boolean)
        .join(',');

    // Serve our local Helia feed to peers over Trystero (gateways won't have it yet).
    useEffect(() => {
        if (isLoggedIn !== true || !myPeerId) {
            setPeerFeedProvider(null);
            return;
        }

        setPeerFeedProvider(async (req: SyncRequest): Promise<PeerFeedSnapshot> => {
            const state = userStateRef.current;
            const session = getSession();
            const label = session.ipnsKeyName || '';
            const stateCid =
                (label && getLatestLocalCid(label)) ||
                (myPeerId && getLatestLocalCid(myPeerId)) ||
                '';

            if (!state) {
                return {
                    ok: false,
                    ipnsKey: myPeerId,
                    stateCid,
                    state: null,
                    posts: [],
                    nextOffset: null,
                };
            }

            // Snowball library: own + liked + saved posts we still hold locally
            const { cids, nextOffset } = libraryPage(state, req?.offset || 0);
            const posts: Post[] = [];
            for (const cid of cids) {
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
                nextOffset,
            };
        });

        return () => setPeerFeedProvider(null);
    }, [isLoggedIn, myPeerId]);

    const handlePresenceRef = useRef<(msg: PresencePayload, trysteroPeerId?: string) => void>(() => {});
    handlePresenceRef.current = (msg: PresencePayload, trysteroPeerId?: string) => {
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

        if (isUsefulDisplayName(msg.name) && setProfilesRef.current) {
            const key = msg.ipnsKey;
            const name = msg.name.trim();
            setProfilesRef.current((prev) => {
                const existing = prev.get(key);
                if (existing?.name === name) return prev;
                return new Map(prev).set(key, {
                    name,
                    bio: existing?.bio,
                });
            });
        }

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

    // Stable discovery rooms — never tear down when the follow list changes
    useEffect(() => {
        if (isLoggedIn !== true || !myPeerId) return;

        const session = getSession();
        if (session.sessionType !== 'helia') {
            return;
        }

        setSelfPresenceKey(myPeerId);

        const abortController = new AbortController();
        const keyLabel = session.ipnsKeyName || '';
        const topics = rankDiscoveryTopics(getDiscoveryTopics(myPeerId, []), myPeerId);
        stableTopicsRef.current = topics;

        const onMessage = (msg: PresencePayload, peerId?: string) => {
            handlePresenceRef.current(msg, peerId);
        };

        void (async () => {
            for (let i = 0; i < topics.length; i++) {
                if (abortController.signal.aborted) return;
                void subscribeToPubsub(topics[i], onMessage, abortController.signal);
                if (i < topics.length - 1) {
                    await new Promise((r) => setTimeout(r, JOIN_STAGGER_MS));
                }
            }
        })();

        const allTopics = () => {
            const seen = new Set<string>();
            const out: string[] = [];
            for (const t of [...stableTopicsRef.current, ...followTopicsRef.current]) {
                if (!t || seen.has(t)) continue;
                seen.add(t);
                out.push(t);
            }
            return out;
        };

        const heartbeat = () => {
            const name =
                (profileNameRef.current || '').trim() || shortId(myPeerId) || myPeerId;
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
            for (const topic of allTopics()) {
                publishToPubsub(topic, presence).catch((e: unknown) =>
                    console.warn('[useAppPeers] Heartbeat failed:', e)
                );
            }
        };
        heartbeatFnRef.current = heartbeat;

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
        pruneFnRef.current = updatePeersState;

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
        const pruneInterval = setInterval(updatePeersState, PRUNE_INTERVAL_MS);

        const onVisibility = () => {
            if (typeof document === 'undefined' || document.hidden) return;
            heartbeatFnRef.current();
            pruneFnRef.current();
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility);
        }

        return () => {
            abortController.abort();
            clearInterval(heartbeatInterval);
            clearInterval(keepaliveInterval);
            clearInterval(pruneInterval);
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibility);
            }
            stableTopicsRef.current = [];
            heartbeatFnRef.current = () => {};
            pruneFnRef.current = () => {};
        };
    }, [isLoggedIn, myPeerId]);

    // Follow-circle rooms — incremental join/leave only (no bootstrap remount)
    useEffect(() => {
        if (isLoggedIn !== true || !myPeerId) {
            return;
        }

        const session = getSession();
        if (session.sessionType !== 'helia') {
            return;
        }

        let cancelled = false;
        const followKeys = followKeysKey ? followKeysKey.split(',').filter(Boolean) : [];
        const stableSet = new Set(getDiscoveryTopics(myPeerId, []));
        const fullTopics = getDiscoveryTopics(myPeerId, followKeys);
        const nextFollowTopics = rankDiscoveryTopics(
            fullTopics.filter((t) => !stableSet.has(t)),
            myPeerId
        );
        const nextFollow = new Set(nextFollowTopics);

        // Leave circles no longer in the capped set
        for (const topic of [...followControllersRef.current.keys()]) {
            if (!nextFollow.has(topic)) {
                followControllersRef.current.get(topic)?.abort();
                followControllersRef.current.delete(topic);
            }
        }

        const toJoin = nextFollowTopics.filter((t) => !followControllersRef.current.has(t));
        followTopicsRef.current = nextFollowTopics;

        const onMessage = (msg: PresencePayload, peerId?: string) => {
            handlePresenceRef.current(msg, peerId);
        };

        void (async () => {
            for (let i = 0; i < toJoin.length; i++) {
                if (cancelled) return;
                const topic = toJoin[i];
                // Another sync may have joined already
                if (followControllersRef.current.has(topic)) continue;
                const ac = new AbortController();
                followControllersRef.current.set(topic, ac);
                void subscribeToPubsub(topic, onMessage, ac.signal);
                if (i < toJoin.length - 1) {
                    await new Promise((r) => setTimeout(r, JOIN_STAGGER_MS));
                }
            }
            if (!cancelled && toJoin.length > 0) {
                heartbeatFnRef.current();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [isLoggedIn, myPeerId, followKeysKey]);

    // Tear down follow-circle rooms only on logout / identity change (not follow churn)
    useEffect(() => {
        return () => {
            for (const ac of followControllersRef.current.values()) {
                ac.abort();
            }
            followControllersRef.current.clear();
            followTopicsRef.current = [];
        };
    }, [isLoggedIn, myPeerId]);

    useEffect(() => {
        if (isLoggedIn !== true) {
            peersMapRef.current.clear();
            setOtherUsers([]);
            setSelfPresenceKey('');
            stableTopicsRef.current = [];
            followTopicsRef.current = [];
            for (const ac of followControllersRef.current.values()) {
                ac.abort();
            }
            followControllersRef.current.clear();
        }
    }, [isLoggedIn]);

    return { otherUsers };
};
