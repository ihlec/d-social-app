// src/hooks/useOnlinePeers.ts
import { useEffect, useRef } from 'react';
import { UserState, OnlinePeer } from '../../types';
import { getSession, publishToPubsub, subscribeToPubsub } from '../../api/ipfsIpns';

const PEER_DISCOVERY_TOPIC = 'dsocial-peers-v1';
const HEARTBEAT_INTERVAL_MS = 60000; // Broadcast every 1 minute
const PRUNE_INTERVAL_MS = 5000;      // Check for stale peers every 5s
const PEER_TIMEOUT_MS = 90000;       // Consider offline if no signal for 90s

interface UseAppPeersArgs {
	isLoggedIn: boolean | null;
	myIpnsKey: string;
	userState: UserState | null;
	setOtherUsers: React.Dispatch<React.SetStateAction<OnlinePeer[]>>;
}

interface PeerPresenceMessage {
    ipnsKey: string;
    name: string;
    timestamp: number;
}

export const useAppPeers = ({
	isLoggedIn,
	myIpnsKey,
	userState,
	setOtherUsers,
}: UseAppPeersArgs) => {
    // We use a ref to track the latest peers to avoid stale closures in intervals
    const peersMapRef = useRef<Map<string, { peer: OnlinePeer, lastSeen: number }>>(new Map());

	useEffect(() => {
		if (isLoggedIn !== true || !myIpnsKey) return;

        const session = getSession();
        if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
            console.warn("[useAppPeers] Not using Kubo session, PubSub unavailable.");
            return;
        }

        const auth = { username: session.kuboUsername, password: session.kuboPassword };
        const rpcUrl = session.rpcApiUrl;
        const abortController = new AbortController();

        // 1. Subscribe to Topic
        const handleMessage = (msg: any) => {
            // DEBUG: Log everything coming in so we know it's working
            // console.log("[useAppPeers] Raw message received:", msg);

            if (msg && msg.ipnsKey && msg.name) {
                // Ignore self
                if (msg.ipnsKey === myIpnsKey) {
                    // console.log("[useAppPeers] Received own heartbeat (ignoring).");
                    return;
                }

                console.log(`[useAppPeers] Peer Seen: ${msg.name} (${msg.ipnsKey.substring(0,6)}...)`);

                const now = Date.now();
                peersMapRef.current.set(msg.ipnsKey, {
                    peer: { ipnsKey: msg.ipnsKey, name: msg.name },
                    lastSeen: now
                });
                // Update state immediately on new peer
                updatePeersState();
            } else {
                console.warn("[useAppPeers] Received invalid peer message format:", msg);
            }
        };

        console.log(`[useAppPeers] Subscribing to ${PEER_DISCOVERY_TOPIC}...`);
        subscribeToPubsub(rpcUrl, PEER_DISCOVERY_TOPIC, handleMessage, abortController.signal, auth)
            .catch((e: any) => console.error("[useAppPeers] Subscription error:", e));

        // 2. Publish Heartbeat
        const heartbeat = () => {
            const userName = userState?.profile?.name || sessionStorage.getItem("currentUserLabel") || "Unknown";
            
            const presence: PeerPresenceMessage = {
                ipnsKey: myIpnsKey,
                name: userName,
                timestamp: Date.now()
            };
            
            console.log("[useAppPeers] Sending Heartbeat...", presence);
            
            publishToPubsub(rpcUrl, PEER_DISCOVERY_TOPIC, presence, auth)
                .catch((e: any) => console.warn("[useAppPeers] Heartbeat failed:", e));
        };

        const heartbeatInterval = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
        heartbeat(); // Initial beat immediately upon login/mount

        // 3. Prune Stale Peers
        const updatePeersState = () => {
            const now = Date.now();
            const activePeers: OnlinePeer[] = [];
            
            peersMapRef.current.forEach((val, key) => {
                if (now - val.lastSeen < PEER_TIMEOUT_MS) {
                    activePeers.push(val.peer);
                } else {
                    console.log(`[useAppPeers] Pruning stale peer: ${val.peer.name}`);
                    peersMapRef.current.delete(key);
                }
            });
            
            // Only update state if count changes to avoid re-renders, or deep compare if needed
            // For now, simple set is fine
            setOtherUsers(activePeers);
        };
        const pruneInterval = setInterval(updatePeersState, PRUNE_INTERVAL_MS);


        return () => {
            console.log("[useAppPeers] Cleaning up subscription.");
            abortController.abort();
            clearInterval(heartbeatInterval);
            clearInterval(pruneInterval);
            peersMapRef.current.clear();
            setOtherUsers([]);
        };
	}, [isLoggedIn, myIpnsKey, userState?.profile?.name, setOtherUsers]);
};