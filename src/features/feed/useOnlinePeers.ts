// fileName: src/features/feed/useOnlinePeers.ts
import { useEffect, useRef, useState } from 'react';
import { UserState, OnlinePeer } from '../../types';
import { getSession, publishToPubsub, subscribeToPubsub } from '../../api/ipfsIpns';
import { PEER_DISCOVERY_TOPIC } from '../../constants';

const HEARTBEAT_INTERVAL_MS = 30000; // Broadcast every 1 minute
const PRUNE_INTERVAL_MS = 5000;      // Check for stale peers every 5s
const PEER_TIMEOUT_MS = 90000;       // Consider offline if no signal for 90s

interface UseAppPeersArgs {
	isLoggedIn: boolean | null;
	myPeerId: string; // FIX: Use Peer ID, not Label
	userState: UserState | null;
}

interface PeerPresenceMessage {
    ipnsKey: string; // This should be the Peer ID (k51...)
    name: string;
    timestamp: number;
}

export const useAppPeers = ({
	isLoggedIn,
	myPeerId,
	userState,
}: UseAppPeersArgs) => {
    const [otherUsers, setOtherUsers] = useState<OnlinePeer[]>([]);
    const peersMapRef = useRef<Map<string, { peer: OnlinePeer, lastSeen: number }>>(new Map());

	useEffect(() => {
		if (isLoggedIn !== true || !myPeerId) return;

        const session = getSession();
        if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
            return;
        }

        const rpcUrl = session.rpcApiUrl;
        const auth = { username: session.kuboUsername, password: session.kuboPassword };
        const abortController = new AbortController();

        const handleMessage = (msg: PeerPresenceMessage) => {
            if (msg && msg.ipnsKey && msg.name && msg.timestamp) {
                // Ignore self (using strict ID comparison)
                if (msg.ipnsKey === myPeerId) return; 
                
                peersMapRef.current.set(msg.ipnsKey, {
                    peer: { ipnsKey: msg.ipnsKey, name: msg.name },
                    lastSeen: Date.now()
                });
            }
        };

        // 1. Subscribe
        subscribeToPubsub(rpcUrl, PEER_DISCOVERY_TOPIC, handleMessage, abortController.signal, auth);

        // 2. Heartbeat (Publish presence)
        const heartbeat = () => {
            if (!userState?.profile?.name) return;
            const presence: PeerPresenceMessage = {
                ipnsKey: myPeerId, // FIX: Broadcast actual Peer ID
                name: userState.profile.name,
                timestamp: Date.now()
            };
            publishToPubsub(rpcUrl, PEER_DISCOVERY_TOPIC, presence, auth)
                .catch((e: any) => console.warn("[useAppPeers] Heartbeat failed:", e));
        };

        const heartbeatInterval = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
        
        // Trigger immediate heartbeat
        heartbeat();

        // 3. Prune Stale Peers
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
            peersMapRef.current.clear();
            setOtherUsers([]);
        };
	}, [isLoggedIn, myPeerId, userState?.profile?.name]);

    return { otherUsers };
};