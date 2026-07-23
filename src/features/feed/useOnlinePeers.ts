// fileName: src/features/feed/useOnlinePeers.ts
import { useEffect, useRef, useState } from 'react';
import { UserState, OnlinePeer, Post } from '../../types';
import {
    getSession,
    publishToPubsub,
    subscribeToPubsub,
    getDiscoveryTopics,
    setPeerFeedProvider,
    heliaCatJson,
} from '../../api/ipfsIpns';
import { getLatestLocalCid } from '../../lib/utils';
import type { PresencePayload, PeerFeedSnapshot } from '../../api/pubsub';

const HEARTBEAT_INTERVAL_MS = 30000;
const PRUNE_INTERVAL_MS = 5000;
const PEER_TIMEOUT_MS = 90000;
const MAX_SYNC_POSTS = 5;

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

    useEffect(() => {
        if (isLoggedIn !== true || !myPeerId) return;

        const session = getSession();
        if (session.sessionType !== 'helia') {
            return;
        }

        const abortController = new AbortController();
        const keyLabel = session.ipnsKeyName || '';

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
        };

        const topics = getDiscoveryTopics();
        for (const topic of topics) {
            void subscribeToPubsub(topic, handleMessage, abortController.signal);
        }

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
            for (const topic of topics) {
                publishToPubsub(topic, presence)
                    .catch((e: any) => console.warn('[useAppPeers] Heartbeat failed:', e));
            }
        };

        const heartbeatInterval = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
        heartbeat();

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
            clearInterval(pruneInterval);
        };
    }, [isLoggedIn, myPeerId]);

    useEffect(() => {
        if (isLoggedIn !== true) {
            peersMapRef.current.clear();
            setOtherUsers([]);
        }
    }, [isLoggedIn]);

    return { otherUsers };
};
