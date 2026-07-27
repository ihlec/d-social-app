/**
 * Presence + peer feed sync via Trystero (WebRTC + Nostr signaling).
 *
 * Rooms are hash-sharded (cluster of clusters). Public IPNS/gateways rarely
 * see browser-only Helia publishes, so Explore pulls recent state/posts over
 * the Trystero data channel instead.
 */

import { joinRoom } from 'trystero';
import type { Room } from 'trystero';
import {
    CONTENT_ROOM_IDLE_MS,
    CONTENT_ROOM_JOINS_PER_MINUTE,
    CONTENT_ROOM_PEER_WAIT_MS,
    CONTENT_ROOM_FETCH_ROUNDS,
    CONTENT_TOPIC_PREFIX,
    DEFAULT_NOSTR_RELAYS,
    MAX_MAPPED_ONLINE_PEERS,
    MAX_P2P_MEDIA_BYTES,
    MEDIA_SYNC_TIMEOUT_MS,
    MESH_PEER_CAP,
    WANT_PUBLISH_MIN_INTERVAL_MS,
    WANT_TOPIC_PREFIX,
} from '../constants';
import { heliaCatBytes, heliaCatJson, heliaHasBlock, isHeliaAvailable, startHelia } from './heliaNode';
import { ingestMediaBytes } from '../lib/heliaMediaUrl';
import {
    bumpJoinError,
    bumpPresenceReceived,
    bumpRoomsJoined,
    bumpRoomsLeft,
    bumpSyncFail,
    bumpSyncOk,
    isMeshDebugEnabled,
    updateMeshGauges,
} from '../lib/meshMetrics';
import {
    contentTopic,
    homeShard,
    hashIpnsKey,
    isBootstrapRoomEnabled,
    isLegacyPeerBridgeEnabled,
    isMeetupTopic,
    parseCustomChannels,
    topicForPeer,
    topicsForSelf,
    wantTopic,
    wantTopicsForServeSet,
} from '../lib/peerShards';
import type { Post, UserState } from '../types';

const APP_ID = 'd-social-app-v1';
const ACTION_PRESENCE = 'presence';
const ACTION_SYNC = 'syncFeed';
/** Short name — Trystero action types are capped at 32 bytes. */
const ACTION_MEDIA = 'syncMedia';
const ACTION_POST = 'syncPost';
const ACTION_WANT = 'wantCid';
const LEAVE_DEBOUNCE_MS = 4000;
const ON_DEMAND_IDLE_MS = 30000;
const SYNC_TIMEOUT_MS = 15000;
const PEER_WAIT_MS = 8000;
/** Max non-sticky content rooms before LRU eviction. */
const MAX_EPHEMERAL_CONTENT_ROOMS = 4;
const RELAYS_STORAGE_KEY = 'custom_nostr_relays';
const TURN_STORAGE_KEY = 'custom_turn_servers';

/**
 * Lean TURN list — Firefox warns that ≥5 STUN/TURN servers slow ICE discovery
 * (Trystero already adds its own STUN defaults alongside turnConfig).
 */
const DEFAULT_TURN_CONFIG: RTCIceServer[] = [
    {
        urls: 'turns:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
    },
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
    /** Next offset into the peer's local library (own+liked+saved); null if exhausted. */
    nextOffset?: number | null;
};

export type PeerLocation = {
    peerId: string;
    topic: string;
    shard: number;
    lastSeen: number;
};

export type SyncRequest = {
    ipnsKey: string;
    /** Offset into the peer's local library (own + liked + saved). */
    offset?: number;
};
type MediaRequest = { cid: string };
type PostRequest = { cid: string };
type PostSyncResult = { ok: boolean; post?: Post };
export type WantPayload = { cid: string; timestamp: number };
type Listener = (msg: PresencePayload, trysteroPeerId: string) => void;
type WantListener = (msg: WantPayload, trysteroPeerId: string) => void;
type FeedProvider = (req: SyncRequest) => Promise<PeerFeedSnapshot>;
type ContentWantHandler = (cid: string) => void;

interface RoomEntry {
    room: Room;
    topic: string;
    sendPresence: (data: PresencePayload) => Promise<void>;
    sendWant: (data: WantPayload) => Promise<void>;
    requestFeed: (
        ipnsKey: string,
        targetPeerId: string,
        offset?: number
    ) => Promise<PeerFeedSnapshot>;
    requestMedia: (cid: string, targetPeerId: string) => Promise<Uint8Array>;
    requestPost: (cid: string, targetPeerId: string) => Promise<PostSyncResult>;
    listeners: Set<Listener>;
    wantListeners: Set<WantListener>;
    refCount: number;
    lastPayload: PresencePayload | null;
    leaveTimer: ReturnType<typeof setTimeout> | null;
    /** Sticky = discovery subscription; ephemeral = on-demand sync only. */
    sticky: boolean;
    /** Last activity for content-room LRU. */
    lastActive: number;
}

const rooms = new Map<string, RoomEntry>();
const pendingRooms = new Map<string, Promise<RoomEntry>>();
/** ipnsKey → latest Trystero peer id + room topic (local sample, not global truth) */
const ipnsToPeer = new Map<string, PeerLocation>();
/** Rolling timestamps of content-room joins (rate limit). */
const contentJoinTimes: number[] = [];
/** At most one sticky content CID (currently viewed post). */
let stickyContentCid: string | null = null;
/** Bumped on leave so in-flight ensureContentRoom does not re-sticky after unmount. */
const contentLeaveGen = new Map<string, number>();

let feedProvider: FeedProvider | null = null;
let selfIpnsKey = '';
/** Logged-in holder: summon into content room when a want matches local blocks. */
let contentWantHandler: ContentWantHandler | null = null;
const lastWantPublish = new Map<string, number>();
/** Want-shard topics currently sticky for this tab's serve set. */
const activeWantTopics = new Set<string>();

/** App registers how to serve our local Helia feed to remote peers. */
export function setPeerFeedProvider(provider: FeedProvider | null): void {
    feedProvider = provider;
}

/** Holder callback when a guest wants a CID (own/liked/saved serve path). */
export function setContentWantHandler(handler: ContentWantHandler | null): void {
    contentWantHandler = handler;
}

/** Used for mesh subsample distance — call when session IPNS is known. */
export function setSelfPresenceKey(ipnsKey: string): void {
    selfIpnsKey = ipnsKey || '';
}

export function getNostrRelays(): string[] {
    try {
        const raw = localStorage.getItem(RELAYS_STORAGE_KEY);
        if (raw) {
            const parsed = raw
                .split(',')
                .map((u) => u.trim())
                .filter((u) => /^wss?:\/\//i.test(u));
            if (parsed.length > 0) return parsed;
        }
    } catch { /* ignore */ }
    return [...DEFAULT_NOSTR_RELAYS];
}

/**
 * TURN servers for WebRTC when host/STUN ICE fails (common behind CGNAT / strict NAT).
 * localStorage `custom_turn_servers`: JSON array of RTCIceServer, or empty string to disable defaults.
 */
export function getTurnConfig(): RTCIceServer[] {
    try {
        const raw = localStorage.getItem(TURN_STORAGE_KEY);
        if (raw === '') return [];
        if (raw) {
            const parsed = JSON.parse(raw) as RTCIceServer[];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch { /* ignore */ }
    return DEFAULT_TURN_CONFIG.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }));
}

function emptySnapshot(ipnsKey: string): PeerFeedSnapshot {
    return { ok: false, ipnsKey, stateCid: '', state: null, posts: [], nextOffset: null };
}

async function serveLocalFeed(req: SyncRequest): Promise<PeerFeedSnapshot> {
    if (!feedProvider) return emptySnapshot(req.ipnsKey || '');
    try {
        const snap = await feedProvider(req || { ipnsKey: '' });
        return {
            ok: !!snap.ok && !!snap.state,
            ipnsKey: snap.ipnsKey || req.ipnsKey,
            stateCid: snap.stateCid || '',
            state: snap.state,
            posts: Array.isArray(snap.posts) ? snap.posts : [],
            nextOffset: snap.nextOffset ?? null,
        };
    } catch (e) {
        console.warn('[Trystero] feed provider failed', e);
        return emptySnapshot(req.ipnsKey || '');
    }
}

async function serveLocalMedia(req: MediaRequest): Promise<Uint8Array> {
    const cid = req?.cid;
    if (!cid || typeof cid !== 'string') {
        throw new Error('missing cid');
    }
    if (!isHeliaAvailable()) throw new Error('Helia unavailable');
    await startHelia();
    if (!(await heliaHasBlock(cid))) throw new Error('not local');
    const bytes = await heliaCatBytes(cid);
    if (!bytes || bytes.length === 0) throw new Error('empty');
    if (bytes.length > MAX_P2P_MEDIA_BYTES) {
        throw new Error(`too large (${bytes.length})`);
    }
    return bytes;
}

async function serveLocalPost(req: PostRequest): Promise<PostSyncResult> {
    const cid = req?.cid;
    if (!cid || typeof cid !== 'string') return { ok: false };
    try {
        if (!isHeliaAvailable()) return { ok: false };
        await startHelia();
        if (!(await heliaHasBlock(cid))) return { ok: false };
        const data = await heliaCatJson<Post>(cid);
        if (!data || typeof data !== 'object') return { ok: false };
        return { ok: true, post: { ...(data as Post), id: cid } };
    } catch (e) {
        console.debug('[Trystero] serveLocalPost failed', cid.slice(0, 12), e);
        return { ok: false };
    }
}

function isContentTopic(topic: string): boolean {
    return topic.startsWith(`${CONTENT_TOPIC_PREFIX}/`);
}

function isWantTopic(topic: string): boolean {
    return topic.startsWith(`${WANT_TOPIC_PREFIX}/`);
}

function noteContentJoinAllowed(): boolean {
    const now = Date.now();
    while (contentJoinTimes.length > 0 && now - contentJoinTimes[0]! > 60_000) {
        contentJoinTimes.shift();
    }
    if (contentJoinTimes.length >= CONTENT_ROOM_JOINS_PER_MINUTE) return false;
    contentJoinTimes.push(now);
    return true;
}

function leaveRoomNow(topic: string, entry: RoomEntry): void {
    if (entry.leaveTimer) {
        clearTimeout(entry.leaveTimer);
        entry.leaveTimer = null;
    }
    rooms.delete(topic);
    if (isWantTopic(topic)) activeWantTopics.delete(topic);
    entry.room.leave().catch(() => {});
    bumpRoomsLeft();
    refreshMeshGauges();
}

/** Evict oldest non-sticky content rooms when over ephemeral budget. */
function evictOldestContentRooms(keepTopic?: string): void {
    const ephemeral = [...rooms.entries()]
        .filter(([t, e]) => isContentTopic(t) && !e.sticky && t !== keepTopic)
        .sort((a, b) => a[1].lastActive - b[1].lastActive);
    while (ephemeral.length >= MAX_EPHEMERAL_CONTENT_ROOMS) {
        const next = ephemeral.shift();
        if (!next) break;
        leaveRoomNow(next[0], next[1]);
    }
}

function peerDistance(a: string, b: string): number {
    const ha = hashIpnsKey(a);
    const hb = hashIpnsKey(b);
    return Math.min(ha ^ hb, 0xffffffff - (ha ^ hb));
}

function peersInTopic(topic: string): [string, PeerLocation][] {
    const out: [string, PeerLocation][] = [];
    for (const [key, loc] of ipnsToPeer) {
        if (loc.topic === topic) out.push([key, loc]);
    }
    return out;
}

function evictOldestMapped(): void {
    if (ipnsToPeer.size <= MAX_MAPPED_ONLINE_PEERS) return;
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of ipnsToPeer) {
        if (v.lastSeen < oldest) {
            oldest = v.lastSeen;
            oldestKey = k;
        }
    }
    if (oldestKey) ipnsToPeer.delete(oldestKey);
}

/**
 * Remember a peer if under mesh cap for the room (deterministic subsample).
 * Returns false if rejected as too far from self when room is full.
 */
function rememberPeer(ipnsKey: string, peerId: string, topic: string): boolean {
    if (!ipnsKey || !peerId) return false;
    const shard = homeShard(ipnsKey);
    const now = Date.now();
    const existing = ipnsToPeer.get(ipnsKey);
    if (existing && existing.peerId === peerId && existing.topic === topic) {
        existing.lastSeen = now;
        return true;
    }

    const inRoom = peersInTopic(topic).filter(([k]) => k !== ipnsKey);
    if (inRoom.length >= MESH_PEER_CAP) {
        // Distance is over IPNS keys (shard affinity), not Trystero peer ids
        const selfKey = selfIpnsKey || ipnsKey;
        const newDist = peerDistance(selfKey, ipnsKey);
        let farthestKey: string | null = null;
        let farthestDist = -1;
        for (const [key] of inRoom) {
            const d = peerDistance(selfKey, key);
            if (d > farthestDist) {
                farthestDist = d;
                farthestKey = key;
            }
        }
        if (newDist >= farthestDist) {
            return false;
        }
        if (farthestKey) ipnsToPeer.delete(farthestKey);
    }

    ipnsToPeer.set(ipnsKey, { peerId, topic, shard, lastSeen: now });
    evictOldestMapped();
    refreshMeshGauges();
    return true;
}

function refreshMeshGauges(): void {
    if (!isMeshDebugEnabled()) return;
    const peersByTopic: Record<string, number> = {};
    const stickyTopics: string[] = [];
    const contentTopics: string[] = [];
    const meetupTopics: string[] = [];
    let stickyRooms = 0;
    for (const [topic, entry] of rooms) {
        try {
            const peers = entry.room.getPeers?.() ?? {};
            peersByTopic[topic] = Object.keys(peers).length;
        } catch {
            peersByTopic[topic] = peersInTopic(topic).length;
        }
        if (entry.sticky) {
            stickyRooms += 1;
            stickyTopics.push(topic);
        }
        if (isContentTopic(topic)) contentTopics.push(topic);
        if (isMeetupTopic(topic)) meetupTopics.push(topic);
    }
    updateMeshGauges({
        stickyRooms,
        mappedPeers: ipnsToPeer.size,
        peersByTopic,
        stickyTopics,
        contentTopics,
        meetupTopics,
    });
}

async function ensureRoom(topic: string, sticky = false): Promise<RoomEntry> {
    const existing = rooms.get(topic);
    if (existing) {
        if (existing.leaveTimer) {
            clearTimeout(existing.leaveTimer);
            existing.leaveTimer = null;
        }
        if (sticky) existing.sticky = true;
        existing.lastActive = Date.now();
        return existing;
    }

    const inflight = pendingRooms.get(topic);
    if (inflight) {
        const entry = await inflight;
        if (sticky) entry.sticky = true;
        entry.lastActive = Date.now();
        return entry;
    }

    const create = (async (): Promise<RoomEntry> => {
        const relays = getNostrRelays();
        const turnConfig = getTurnConfig();
        const room = joinRoom(
            {
                appId: APP_ID,
                relayConfig: {
                    urls: relays,
                    redundancy: Math.min(2, relays.length),
                    warnOnRelayFailure: false,
                },
                ...(turnConfig.length > 0 ? { turnConfig } : {}),
            },
            topic,
            {
                onJoinError: ({ error, roomId }) => {
                    bumpJoinError();
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

        const media = room.makeAction(ACTION_MEDIA, {
            kind: 'request',
            onRequest: async (req: MediaRequest) => serveLocalMedia(req) as any,
        }) as {
            request: (
                data: MediaRequest,
                options: { target: string; timeoutMs?: number }
            ) => Promise<Uint8Array | ArrayBuffer>;
            onRequest: ((data: MediaRequest) => Promise<Uint8Array>) | null;
        };

        const postSync = room.makeAction(ACTION_POST, {
            kind: 'request',
            onRequest: async (req: PostRequest) => serveLocalPost(req) as any,
        }) as {
            request: (
                data: PostRequest,
                options: { target: string; timeoutMs?: number }
            ) => Promise<PostSyncResult>;
            onRequest: ((data: PostRequest) => Promise<PostSyncResult>) | null;
        };

        const want = room.makeAction<WantPayload>(ACTION_WANT);

        const listeners = new Set<Listener>();
        const wantListeners = new Set<WantListener>();
        const entry: RoomEntry = {
            room,
            topic,
            sendPresence: (data) => presence.send(data),
            sendWant: (data) => want.send(data),
            requestFeed: (ipnsKey, targetPeerId, offset) =>
                sync.request(
                    { ipnsKey, ...(typeof offset === 'number' ? { offset } : {}) },
                    { target: targetPeerId, timeoutMs: SYNC_TIMEOUT_MS }
                ),
            requestMedia: async (cid, targetPeerId) => {
                const raw = await media.request(
                    { cid },
                    { target: targetPeerId, timeoutMs: MEDIA_SYNC_TIMEOUT_MS }
                );
                if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
                if (raw instanceof Uint8Array) return raw;
                throw new Error('unexpected media response');
            },
            requestPost: (cid, targetPeerId) =>
                postSync.request({ cid }, { target: targetPeerId, timeoutMs: SYNC_TIMEOUT_MS }),
            listeners,
            wantListeners,
            refCount: 0,
            lastPayload: null,
            leaveTimer: null,
            sticky,
            lastActive: Date.now(),
        };

        sync.onRequest = async (req) => serveLocalFeed(req);
        media.onRequest = async (req) => serveLocalMedia(req);
        postSync.onRequest = async (req) => serveLocalPost(req);

        presence.onMessage = (data, context) => {
            bumpPresenceReceived();
            if (data?.ipnsKey && context?.peerId) {
                rememberPeer(data.ipnsKey, context.peerId, topic);
            }
            for (const listener of listeners) {
                try {
                    listener(data, context.peerId);
                } catch (e) {
                    console.warn('[Trystero] listener error', e);
                }
            }
        };

        want.onMessage = (data, context) => {
            if (!data?.cid || typeof data.cid !== 'string') return;
            for (const listener of wantListeners) {
                try {
                    listener(data, context?.peerId || '');
                } catch (e) {
                    console.warn('[Trystero] want listener error', e);
                }
            }
            if (isWantTopic(topic) && contentWantHandler) {
                try {
                    contentWantHandler(data.cid);
                } catch (e) {
                    console.warn('[Trystero] want handler error', e);
                }
            }
        };

        room.onPeerJoin = (peerId) => {
            refreshMeshGauges();
            if (!entry.lastPayload) return;
            entry.sendPresence(entry.lastPayload).catch((e) => {
                console.debug('[Trystero] replay presence failed', peerId, e);
            });
        };

        rooms.set(topic, entry);
        bumpRoomsJoined();
        refreshMeshGauges();
        return entry;
    })();

    pendingRooms.set(topic, create);
    try {
        return await create;
    } finally {
        pendingRooms.delete(topic);
    }
}

function scheduleLeave(topic: string, entry: RoomEntry, delayMs = LEAVE_DEBOUNCE_MS): void {
    if (entry.sticky && entry.listeners.size > 0) return;
    if (entry.leaveTimer) clearTimeout(entry.leaveTimer);
    entry.leaveTimer = setTimeout(() => {
        entry.leaveTimer = null;
        if (entry.refCount > 0 || entry.listeners.size > 0) return;
        if (entry.sticky) return;
        leaveRoomNow(topic, entry);
    }, delayMs);
}

/** Join target peer's home shard (ephemeral if not already sticky). */
export async function ensureRoomForPeer(ipnsKey: string): Promise<RoomEntry> {
    const topic = topicForPeer(ipnsKey);
    return ensureRoom(topic, false);
}

/**
 * Discovery topics for this identity: sharded home+neighbors, circle rooms,
 * default bootstrap room, custom channels, and optional legacy v1 bridge.
 */
export function getDiscoveryTopics(myIpnsKey?: string, followKeys?: string[]): string[] {
    if (myIpnsKey) {
        return topicsForSelf(myIpnsKey, {
            includeLegacy: isLegacyPeerBridgeEnabled(),
            includeBootstrap: isBootstrapRoomEnabled(),
            customChannels: parseCustomChannels(),
            followKeys: followKeys || [],
        });
    }
    // Pre-login: custom affinity channels only — never auto-join global/bootstrap mesh
    return parseCustomChannels().filter(
        (t) => t && t !== 'dsocial-peers-v1' && t !== 'dsocial-bootstrap'
    );
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

    if (payload.ipnsKey) setSelfPresenceKey(payload.ipnsKey);
    const entry = await ensureRoom(topic, true);
    entry.lastPayload = payload;
    await entry.sendPresence(payload);
}

export async function subscribeToPubsub(
    topic: string,
    onMessage: (msg: PresencePayload, trysteroPeerId?: string) => void,
    abortSignal: AbortSignal
): Promise<void> {
    if (!topic) return;

    const entry = await ensureRoom(topic, true);
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
        entry.sticky = false;
        scheduleLeave(topic, entry);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Wait until peer is mapped on a specific room (Trystero peer ids are room-scoped). */
async function waitForMappedPeer(
    ipnsKey: string,
    topic: string,
    timeoutMs: number
): Promise<PeerLocation | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const loc = ipnsToPeer.get(ipnsKey);
        if (loc && loc.topic === topic) return loc;
        await sleep(250);
    }
    const loc = ipnsToPeer.get(ipnsKey);
    return loc && loc.topic === topic ? loc : null;
}

async function withMappedHomePeer<T>(
    ipnsKey: string,
    run: (entry: RoomEntry, loc: PeerLocation) => Promise<T>
): Promise<T | null> {
    const homeTopic = topicForPeer(ipnsKey);
    const existing = rooms.get(homeTopic);
    const joinedOnDemand = !existing?.sticky;
    let entry: RoomEntry | null = null;

    try {
        entry = await ensureRoomForPeer(ipnsKey);

        let loc: PeerLocation | null | undefined = ipnsToPeer.get(ipnsKey);
        if (!loc || loc.topic !== homeTopic) {
            loc = await waitForMappedPeer(ipnsKey, homeTopic, PEER_WAIT_MS);
        }

        if (!loc) {
            console.debug('[Trystero] No WebRTC peer mapped for', ipnsKey.slice(0, 16));
            if (joinedOnDemand && entry && !entry.sticky) {
                scheduleLeave(homeTopic, entry, ON_DEMAND_IDLE_MS);
            }
            return null;
        }

        const result = await run(entry, loc);
        if (joinedOnDemand && !entry.sticky) {
            scheduleLeave(homeTopic, entry, ON_DEMAND_IDLE_MS);
        }
        return result;
    } catch (e) {
        console.warn('[Trystero] peer RPC failed', ipnsKey.slice(0, 16), e);
        if (joinedOnDemand && entry && !entry.sticky) {
            scheduleLeave(homeTopic, entry, ON_DEMAND_IDLE_MS);
        }
        return null;
    }
}

/** Ask an online peer (by IPNS key) for a page of their local library over WebRTC. */
export async function requestPeerFeed(
    ipnsKey: string,
    opts?: { offset?: number }
): Promise<PeerFeedSnapshot | null> {
    if (!ipnsKey) return null;

    const offset = opts?.offset;
    const snap = await withMappedHomePeer(ipnsKey, (entry, loc) =>
        entry.requestFeed(ipnsKey, loc.peerId, offset)
    );
    if (snap?.ok && snap.state) {
        bumpSyncOk();
        return snap;
    }
    bumpSyncFail();
    return null;
}

/** Ask an online peer for a single post JSON by CID (home-shard syncPost). */
export async function requestPeerPost(ipnsKey: string, cid: string): Promise<Post | null> {
    const clean = (cid || '').trim();
    if (!ipnsKey || !clean) return null;

    if (isHeliaAvailable()) {
        try {
            await startHelia();
            if (await heliaHasBlock(clean)) {
                const local = await heliaCatJson<Post>(clean);
                if (local && typeof local === 'object') {
                    return { ...(local as Post), id: clean };
                }
            }
        } catch { /* continue */ }
    }

    const res = await withMappedHomePeer(ipnsKey, (entry, loc) =>
        entry.requestPost(clean, loc.peerId)
    );
    if (res?.ok && res.post && typeof res.post === 'object') {
        bumpSyncOk();
        return { ...res.post, id: clean };
    }
    bumpSyncFail();
    return null;
}

/**
 * Pull media bytes for a CID from an online peer over WebRTC.
 * Pins into Helia when quota allows; otherwise serves an ephemeral blob: URL.
 * Returns the blob/gateway-ready local URL, or null.
 */
export async function requestPeerMedia(
    ipnsKey: string,
    cid: string,
    mimeHint?: string
): Promise<string | null> {
    if (!ipnsKey || !cid || cid.startsWith('http')) return null;

    const { getCachedHeliaMediaUrl, resolveHeliaMediaUrl } = await import('../lib/heliaMediaUrl');
    const cached = getCachedHeliaMediaUrl(cid);
    if (cached) return cached;

    if (isHeliaAvailable()) {
        try {
            await startHelia();
            if (await heliaHasBlock(cid)) {
                return resolveHeliaMediaUrl(cid, mimeHint, { allowLarge: true });
            }
        } catch { /* continue to P2P */ }
    }

    const bytes = await withMappedHomePeer(ipnsKey, (entry, loc) =>
        entry.requestMedia(cid, loc.peerId)
    );
    if (!bytes || bytes.length === 0) return null;
    if (bytes.length > MAX_P2P_MEDIA_BYTES) {
        console.warn(`[Trystero] media too large for ${cid.slice(0, 12)}… (${bytes.length})`);
        return null;
    }

    const url = await ingestMediaBytes(cid, bytes, mimeHint);
    if (url) {
        console.debug(`[Trystero] media ready ${cid.slice(0, 12)}… (${bytes.length} bytes)`);
    }
    return url;
}

async function waitForRoomPeers(entry: RoomEntry, timeoutMs: number): Promise<string[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const peers = Object.keys(entry.room.getPeers?.() ?? {});
            if (peers.length > 0) return peers;
        } catch { /* ignore */ }
        await sleep(250);
    }
    try {
        return Object.keys(entry.room.getPeers?.() ?? {});
    } catch {
        return [];
    }
}

/** True if this tab is already in `dsocial-cid/<cid>` (viewer sticky or recent request). */
export function isContentRoomJoined(cid: string): boolean {
    const clean = (cid || '').trim();
    return !!clean && rooms.has(contentTopic(clean));
}

/**
 * Join (or refresh) a per-CID content room for guest/share-link rendezvous.
 * Sticky while a PostPage is open (at most one sticky content CID).
 */
export async function ensureContentRoom(
    cid: string,
    opts?: { sticky?: boolean }
): Promise<RoomEntry | null> {
    const clean = (cid || '').trim();
    if (!clean) return null;
    const topic = contentTopic(clean);
    const sticky = !!opts?.sticky;
    const genAtStart = contentLeaveGen.get(clean) || 0;
    const existing = rooms.get(topic);

    if (!existing && !noteContentJoinAllowed()) {
        console.debug('[Trystero] content-room join rate limited');
        return null;
    }
    if (!existing) evictOldestContentRooms(topic);

    if (sticky && stickyContentCid && stickyContentCid !== clean) {
        const prevTopic = contentTopic(stickyContentCid);
        const prev = rooms.get(prevTopic);
        if (prev) {
            prev.sticky = false;
            scheduleLeave(prevTopic, prev, CONTENT_ROOM_IDLE_MS);
        }
        stickyContentCid = null;
    }

    const entry = await ensureRoom(topic, sticky);
    // Unmount/leave raced the join — drop sticky and tear down
    if ((contentLeaveGen.get(clean) || 0) !== genAtStart) {
        entry.sticky = false;
        if (stickyContentCid === clean) stickyContentCid = null;
        leaveRoomNow(topic, entry);
        return null;
    }
    entry.lastActive = Date.now();
    if (sticky) stickyContentCid = clean;
    if (!entry.sticky) {
        scheduleLeave(topic, entry, CONTENT_ROOM_IDLE_MS);
    }
    refreshMeshGauges();
    return entry;
}

/** Leave a content room (e.g. PostPage unmount). */
export async function leaveContentRoom(cid: string): Promise<void> {
    const clean = (cid || '').trim();
    if (!clean) return;
    contentLeaveGen.set(clean, (contentLeaveGen.get(clean) || 0) + 1);
    const topic = contentTopic(clean);
    const entry = rooms.get(topic);
    if (!entry) {
        if (stickyContentCid === clean) stickyContentCid = null;
        return;
    }
    if (stickyContentCid === clean) stickyContentCid = null;
    entry.sticky = false;
    leaveRoomNow(topic, entry);
}

/** Request post JSON by CID from any peer currently in the content room. */
export async function requestContentPost(cid: string): Promise<Post | null> {
    const clean = (cid || '').trim();
    if (!clean) return null;

    if (isHeliaAvailable()) {
        try {
            await startHelia();
            if (await heliaHasBlock(clean)) {
                const local = await heliaCatJson<Post>(clean);
                if (local && typeof local === 'object') {
                    return { ...(local as Post), id: clean };
                }
            }
        } catch { /* continue to P2P */ }
    }

    // Prefer already-joined sticky post room (avoid rate-limit / demote)
    let entry = rooms.get(contentTopic(clean)) || null;
    if (!entry) {
        entry = await ensureContentRoom(clean, { sticky: false });
    }
    if (!entry) {
        bumpSyncFail();
        return null;
    }

    const roundWait = Math.ceil(CONTENT_ROOM_PEER_WAIT_MS / CONTENT_ROOM_FETCH_ROUNDS);
    for (let round = 0; round < CONTENT_ROOM_FETCH_ROUNDS; round++) {
        const peers = await waitForRoomPeers(entry, roundWait);
        for (const peerId of peers) {
            try {
                const res = await entry.requestPost(clean, peerId);
                if (res?.ok && res.post && typeof res.post === 'object') {
                    bumpSyncOk();
                    entry.lastActive = Date.now();
                    if (!entry.sticky) scheduleLeave(entry.topic, entry, CONTENT_ROOM_IDLE_MS);
                    return { ...res.post, id: clean };
                }
            } catch {
                /* try next peer */
            }
        }
        // Holder may still be joining — brief pause before next peer wait
        if (round + 1 < CONTENT_ROOM_FETCH_ROUNDS) await sleep(500);
    }

    bumpSyncFail();
    if (!entry.sticky) scheduleLeave(entry.topic, entry, CONTENT_ROOM_IDLE_MS);
    return null;
}

/**
 * Pull media bytes from peers in a content room.
 * Prefer `rendezvousCid` (usually the post CID) — holders sticky-join the post room,
 * not a separate media-CID room. Falls back to sticky viewed post, then media CID.
 */
export async function requestContentMedia(
    cid: string,
    mimeHint?: string,
    opts?: { rendezvousCid?: string }
): Promise<string | null> {
    if (!cid || cid.startsWith('http')) return null;

    const { getCachedHeliaMediaUrl, resolveHeliaMediaUrl } = await import('../lib/heliaMediaUrl');
    const cached = getCachedHeliaMediaUrl(cid);
    if (cached) return cached;

    if (isHeliaAvailable()) {
        try {
            await startHelia();
            if (await heliaHasBlock(cid)) {
                return resolveHeliaMediaUrl(cid, mimeHint, { allowLarge: true });
            }
        } catch { /* continue */ }
    }

    const roomCandidates = [
        opts?.rendezvousCid,
        stickyContentCid,
        cid,
    ]
        .map((c) => (c || '').trim())
        .filter(Boolean)
        .filter((c, i, arr) => arr.indexOf(c) === i);

    for (const roomCid of roomCandidates) {
        // Prefer an already-joined room (post sticky) before paying a join
        let entry = rooms.get(contentTopic(roomCid)) || null;
        const joinedEphemeral = !entry;
        if (!entry) {
            entry = await ensureContentRoom(roomCid, { sticky: false });
        }
        if (!entry) continue;

        entry.lastActive = Date.now();
        const peers = await waitForRoomPeers(entry, PEER_WAIT_MS);
        for (const peerId of peers) {
            try {
                const bytes = await entry.requestMedia(cid, peerId);
                if (!bytes || bytes.length === 0) continue;
                if (bytes.length > MAX_P2P_MEDIA_BYTES) continue;
                const url = await ingestMediaBytes(cid, bytes, mimeHint);
                if (url) {
                    entry.lastActive = Date.now();
                    if (joinedEphemeral && !entry.sticky) {
                        scheduleLeave(entry.topic, entry, CONTENT_ROOM_IDLE_MS);
                    }
                    console.debug(`[Trystero] content-room media ${cid.slice(0, 12)}… via ${roomCid.slice(0, 12)}… (${bytes.length} bytes)`);
                    return url;
                }
            } catch {
                /* try next peer */
            }
        }
        if (joinedEphemeral && !entry.sticky) {
            scheduleLeave(entry.topic, entry, CONTENT_ROOM_IDLE_MS);
        }
    }

    return null;
}

/**
 * Guest: announce need for a CID on its want shard (rate-limited).
 * Holders listening on that shard may join the content room and serve.
 */
export async function publishContentWant(cid: string): Promise<void> {
    const clean = (cid || '').trim();
    if (!clean) return;
    const now = Date.now();
    const last = lastWantPublish.get(clean) || 0;
    if (now - last < WANT_PUBLISH_MIN_INTERVAL_MS) return;
    lastWantPublish.set(clean, now);

    const topic = wantTopic(clean);
    try {
        const entry = await ensureRoom(topic, false);
        entry.lastActive = now;
        await entry.sendWant({ cid: clean, timestamp: now });
        if (!entry.sticky && !activeWantTopics.has(topic)) {
            scheduleLeave(topic, entry, CONTENT_ROOM_IDLE_MS);
        }
        console.debug('[Trystero] published want', clean.slice(0, 12));
    } catch (e) {
        console.debug('[Trystero] want publish failed', e);
    }
}

/**
 * Holder: join ≤ MAX_WANT_ROOMS covering own/liked/saved serve CIDs; leave stale want rooms.
 */
export async function syncWantRoomsForServeSet(serveCids: string[]): Promise<void> {
    const nextTopics = new Set(wantTopicsForServeSet(serveCids));

    for (const topic of [...activeWantTopics]) {
        if (nextTopics.has(topic)) continue;
        activeWantTopics.delete(topic);
        const entry = rooms.get(topic);
        if (entry) {
            entry.sticky = false;
            leaveRoomNow(topic, entry);
        }
    }

    for (const topic of nextTopics) {
        if (activeWantTopics.has(topic)) continue;
        try {
            const entry = await ensureRoom(topic, true);
            activeWantTopics.add(topic);
            entry.lastActive = Date.now();
        } catch (e) {
            console.debug('[Trystero] want room join failed', topic, e);
        }
    }
}

/** Drop all want-shard subscriptions (logout). */
export async function clearWantRooms(): Promise<void> {
    for (const topic of [...activeWantTopics]) {
        activeWantTopics.delete(topic);
        const entry = rooms.get(topic);
        if (entry) {
            entry.sticky = false;
            leaveRoomNow(topic, entry);
        }
    }
}

