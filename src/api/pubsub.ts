/**
 * Presence + peer feed sync via Trystero (WebRTC + Nostr signaling).
 *
 * Public IPNS/gateways rarely see browser-only Helia publishes, so Explore
 * pulls recent state/posts over the Trystero data channel instead.
 */

import { joinRoom } from 'trystero';
import type { Room } from 'trystero';
import { PEER_DISCOVERY_TOPIC } from '../constants';
import type { Post, UserState } from '../types';

const APP_ID = 'd-social-app-v1';
const ACTION_PRESENCE = 'presence';
const ACTION_SYNC = 'syncFeed';
const LEAVE_DEBOUNCE_MS = 4000;
const SYNC_TIMEOUT_MS = 15000;

const NOSTR_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://nostr.mom',
    'wss://relay.snort.social',
];

export type PresencePayload = {
    ipnsKey: string;
    name: string;
    timestamp: number;
    stateCid?: string;
};

export type PeerFeedSnapshot = {
    ok: boolean;
    ipnsKey: string;
    stateCid: string;
    state: UserState | null;
    posts: Post[];
};

type SyncRequest = { ipnsKey: string };
type Listener = (msg: PresencePayload, trysteroPeerId: string) => void;
type FeedProvider = () => Promise<PeerFeedSnapshot>;

interface RoomEntry {
    room: Room;
    sendPresence: (data: PresencePayload) => Promise<void>;
    requestFeed: (ipnsKey: string, targetPeerId: string) => Promise<PeerFeedSnapshot>;
    listeners: Set<Listener>;
    refCount: number;
    lastPayload: PresencePayload | null;
    leaveTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, RoomEntry>();
const pendingRooms = new Map<string, Promise<RoomEntry>>();
/** ipnsKey → latest Trystero peer id + room topic */
const ipnsToPeer = new Map<string, { peerId: string; topic: string }>();

let feedProvider: FeedProvider | null = null;

/** App registers how to serve our local Helia feed to remote peers. */
export function setPeerFeedProvider(provider: FeedProvider | null): void {
    feedProvider = provider;
}

function emptySnapshot(ipnsKey: string): PeerFeedSnapshot {
    return { ok: false, ipnsKey, stateCid: '', state: null, posts: [] };
}

async function serveLocalFeed(req: SyncRequest): Promise<PeerFeedSnapshot> {
    if (!feedProvider) return emptySnapshot(req.ipnsKey || '');
    try {
        const snap = await feedProvider();
        return {
            ok: !!snap.ok && !!snap.state,
            ipnsKey: snap.ipnsKey || req.ipnsKey,
            stateCid: snap.stateCid || '',
            state: snap.state,
            posts: Array.isArray(snap.posts) ? snap.posts : [],
        };
    } catch (e) {
        console.warn('[Trystero] feed provider failed', e);
        return emptySnapshot(req.ipnsKey || '');
    }
}

async function ensureRoom(topic: string): Promise<RoomEntry> {
    const existing = rooms.get(topic);
    if (existing) {
        if (existing.leaveTimer) {
            clearTimeout(existing.leaveTimer);
            existing.leaveTimer = null;
        }
        return existing;
    }

    const inflight = pendingRooms.get(topic);
    if (inflight) return inflight;

    const create = (async (): Promise<RoomEntry> => {
        const room = joinRoom(
            {
                appId: APP_ID,
                relayConfig: {
                    urls: NOSTR_RELAYS,
                    redundancy: 2,
                    warnOnRelayFailure: false,
                },
            },
            topic,
            {
                onJoinError: ({ error, roomId }) => {
                    console.warn(`[Trystero] join error room=${roomId}:`, error);
                },
            }
        );

        const presence = room.makeAction<PresencePayload>(ACTION_PRESENCE);
        // Trystero JsonValue types don't accept app interfaces — cast the request action.
        const sync = room.makeAction(ACTION_SYNC, {
            kind: 'request',
            onRequest: async (req: SyncRequest) => serveLocalFeed(req) as any,
        }) as {
            request: (data: SyncRequest, options: { target: string; timeoutMs?: number }) => Promise<PeerFeedSnapshot>;
            onRequest: ((data: SyncRequest) => Promise<PeerFeedSnapshot>) | null;
        };

        const listeners = new Set<Listener>();
        const entry: RoomEntry = {
            room,
            sendPresence: (data) => presence.send(data),
            requestFeed: (ipnsKey, targetPeerId) =>
                sync.request({ ipnsKey }, { target: targetPeerId, timeoutMs: SYNC_TIMEOUT_MS }),
            listeners,
            refCount: 0,
            lastPayload: null,
            leaveTimer: null,
        };

        sync.onRequest = async (req) => serveLocalFeed(req);

        presence.onMessage = (data, context) => {
            if (data?.ipnsKey && context?.peerId) {
                ipnsToPeer.set(data.ipnsKey, { peerId: context.peerId, topic });
            }
            for (const listener of listeners) {
                try {
                    listener(data, context.peerId);
                } catch (e) {
                    console.warn('[Trystero] listener error', e);
                }
            }
        };

        room.onPeerJoin = (peerId) => {
            if (!entry.lastPayload) return;
            entry.sendPresence(entry.lastPayload).catch((e) => {
                console.debug('[Trystero] replay presence failed', peerId, e);
            });
        };

        rooms.set(topic, entry);
        return entry;
    })();

    pendingRooms.set(topic, create);
    try {
        return await create;
    } finally {
        pendingRooms.delete(topic);
    }
}

function scheduleLeave(topic: string, entry: RoomEntry): void {
    if (entry.leaveTimer) clearTimeout(entry.leaveTimer);
    entry.leaveTimer = setTimeout(() => {
        entry.leaveTimer = null;
        if (entry.refCount > 0 || entry.listeners.size > 0) return;
        rooms.delete(topic);
        entry.room.leave().catch(() => {});
    }, LEAVE_DEBOUNCE_MS);
}

export function getDiscoveryTopics(): string[] {
    const topics = new Set<string>([PEER_DISCOVERY_TOPIC]);
    try {
        const custom = localStorage.getItem('custom_channels') || '';
        for (const part of custom.split(',')) {
            const t = part.trim();
            if (t) topics.add(t);
        }
    } catch { /* ignore */ }
    return [...topics];
}

function asPresencePayload(data: unknown): PresencePayload | null {
    if (!data || typeof data !== 'object') return null;
    const o = data as Record<string, unknown>;
    if (typeof o.ipnsKey !== 'string' || typeof o.name !== 'string' || typeof o.timestamp !== 'number') {
        return null;
    }
    const payload: PresencePayload = {
        ipnsKey: o.ipnsKey,
        name: o.name,
        timestamp: o.timestamp,
    };
    if (typeof o.stateCid === 'string' && o.stateCid) payload.stateCid = o.stateCid;
    return payload;
}

export async function publishToPubsub(topic: string, data: unknown): Promise<void> {
    if (!topic) return;
    const payload = asPresencePayload(data);
    if (!payload) {
        console.warn('[Trystero] Ignoring non-presence pubsub payload');
        return;
    }

    const entry = await ensureRoom(topic);
    entry.lastPayload = payload;
    await entry.sendPresence(payload);
}

export async function subscribeToPubsub(
    topic: string,
    onMessage: (msg: PresencePayload, trysteroPeerId?: string) => void,
    abortSignal: AbortSignal
): Promise<void> {
    if (!topic) return;

    const entry = await ensureRoom(topic);
    if (entry.leaveTimer) {
        clearTimeout(entry.leaveTimer);
        entry.leaveTimer = null;
    }

    const listener: Listener = (msg, peerId) => onMessage(msg, peerId);
    entry.listeners.add(listener);
    entry.refCount += 1;

    await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
            resolve();
            return;
        }
        abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });

    entry.listeners.delete(listener);
    entry.refCount -= 1;

    if (entry.refCount <= 0 && entry.listeners.size === 0) {
        scheduleLeave(topic, entry);
    }
}

/** Ask an online peer (by IPNS key) for their recent UserState + posts over WebRTC. */
export async function requestPeerFeed(ipnsKey: string): Promise<PeerFeedSnapshot | null> {
    if (!ipnsKey) return null;
    const loc = ipnsToPeer.get(ipnsKey);
    if (!loc) {
        console.debug('[Trystero] No WebRTC peer mapped for', ipnsKey.slice(0, 16));
        return null;
    }
    try {
        const entry = await ensureRoom(loc.topic);
        const snap = await entry.requestFeed(ipnsKey, loc.peerId);
        if (snap?.ok && snap.state) return snap;
        return null;
    } catch (e) {
        console.warn('[Trystero] requestPeerFeed failed', ipnsKey.slice(0, 16), e);
        return null;
    }
}
