/**
 * Deterministic Trystero room sharding for decentralized presence.
 * Shard id is computed from IPNS key — no directory server.
 */

import {
    CIRCLE_TOPIC_PREFIX,
    CONTENT_TOPIC_PREFIX,
    DEV_LOCAL_RENDEZVOUS_TOPIC,
    INCLUDE_LEGACY_PEER_BRIDGE_DEFAULT,
    LEGACY_PEER_BRIDGE_STORAGE_KEY,
    MAX_CIRCLE_ROOMS,
    MAX_SERVE_CIDS,
    MAX_STICKY_ROOMS,
    MAX_WANT_ROOMS,
    NEIGHBOR_SHARD_COUNT,
    NUM_SHARDS,
    NUM_WANT_SHARDS,
    PEER_DISCOVERY_TOPIC,
    PEER_TOPIC_PREFIX_V2,
    WANT_TOPIC_PREFIX,
} from '../constants';
import type { UserState } from '../types';

/** FNV-1a 32-bit — fast, stable shard assignment. */
export function hashIpnsKey(ipnsKey: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < ipnsKey.length; i++) {
        h ^= ipnsKey.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function homeShard(ipnsKey: string): number {
    if (!ipnsKey) return 0;
    return hashIpnsKey(ipnsKey) % NUM_SHARDS;
}

/** Adjacent shards on the ring (overlap / bridge membership). */
export function neighborShards(ipnsKey: string, k: number = NEIGHBOR_SHARD_COUNT): number[] {
    const home = homeShard(ipnsKey);
    if (k <= 0 || NUM_SHARDS <= 1) return [];
    const out: number[] = [];
    for (let i = 1; i <= k; i++) {
        out.push((home + i) % NUM_SHARDS);
        if (out.length >= k) break;
        out.push((home - i + NUM_SHARDS) % NUM_SHARDS);
        if (out.length >= k) break;
    }
    return out.slice(0, k);
}

export function shardTopic(shard: number): string {
    const s = ((shard % NUM_SHARDS) + NUM_SHARDS) % NUM_SHARDS;
    return `${PEER_TOPIC_PREFIX_V2}/${s}`;
}

/** Home-shard topic for a peer (join on-demand for syncFeed). */
export function topicForPeer(ipnsKey: string): string {
    return shardTopic(homeShard(ipnsKey));
}

/** Short stable circle id from IPNS key (ego / follow affinity rooms). */
export function circleId(ipnsKey: string): string {
    return hashIpnsKey(ipnsKey).toString(16).padStart(8, '0');
}

export function circleTopic(ipnsKey: string): string {
    return `${CIRCLE_TOPIC_PREFIX}/${circleId(ipnsKey)}`;
}

/** Per-CID Trystero room for guest/share-link rendezvous. */
export function contentTopic(cid: string): string {
    const clean = (cid || '').trim();
    return `${CONTENT_TOPIC_PREFIX}/${clean}`;
}

export function wantShard(cid: string): number {
    const clean = (cid || '').trim();
    if (!clean) return 0;
    return hashIpnsKey(clean) % NUM_WANT_SHARDS;
}

export function wantTopic(cidOrShard: string | number): string {
    if (typeof cidOrShard === 'number') {
        const s = ((cidOrShard % NUM_WANT_SHARDS) + NUM_WANT_SHARDS) % NUM_WANT_SHARDS;
        return `${WANT_TOPIC_PREFIX}/${s}`;
    }
    return `${WANT_TOPIC_PREFIX}/${wantShard(cidOrShard)}`;
}

/**
 * Newest own + saved CIDs a logged-in peer may auto-serve via want→content-room.
 * Likes excluded (thumb-only / anti-spam).
 */
export function serveCidsFromState(state: UserState | null | undefined): string[] {
    if (!state) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const cid of [...(state.postCIDs || []), ...(state.savedPostCIDs || [])]) {
        const c = (cid || '').trim();
        if (!c || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        if (out.length >= MAX_SERVE_CIDS) break;
    }
    return out;
}

/** Up to MAX_WANT_ROOMS want topics — prefer shards that cover the most serve CIDs. */
export function wantTopicsForServeSet(cids: string[]): string[] {
    const counts = new Map<number, number>();
    for (const cid of cids) {
        const s = wantShard(cid);
        counts.set(s, (counts.get(s) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, MAX_WANT_ROOMS)
        .map(([s]) => wantTopic(s));
}

export function parseCustomChannels(): string[] {
    try {
        const custom = localStorage.getItem('custom_channels') || '';
        return custom
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

/** Opt-in legacy global room (`legacy_peer_bridge=1`). Off by default for scale. */
export function isLegacyPeerBridgeEnabled(): boolean {
    try {
        const v = localStorage.getItem(LEGACY_PEER_BRIDGE_STORAGE_KEY);
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
    } catch { /* ignore */ }
    return INCLUDE_LEGACY_PEER_BRIDGE_DEFAULT;
}

/** True on local Vite/dev hosts — enables same-machine cross-browser rendezvous. */
export function isLocalDevHost(): boolean {
    try {
        if (typeof window === 'undefined') return false;
        const h = window.location.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch {
        return false;
    }
}

export interface TopicsForSelfOptions {
    /** Dual-publish on legacy global room during migration. Default from constant / Settings. */
    includeLegacy?: boolean;
    /** Extra affinity rooms from settings. */
    customChannels?: string[];
    /** Follow IPNS keys — join their circle rooms (capped). */
    followKeys?: string[];
    /** Override sticky room cap (tests). */
    maxStickyRooms?: number;
}

/**
 * Rooms this tab should stay joined to, ranked and capped:
 * home → ego circle → localhost rendezvous → neighbors → follow circles → custom → legacy.
 */
export function topicsForSelf(myIpnsKey: string, opts: TopicsForSelfOptions = {}): string[] {
    const {
        includeLegacy = INCLUDE_LEGACY_PEER_BRIDGE_DEFAULT,
        customChannels = parseCustomChannels(),
        followKeys = [],
        maxStickyRooms = MAX_STICKY_ROOMS,
    } = opts;

    const ranked: string[] = [];
    const seen = new Set<string>();
    const push = (t: string) => {
        if (!t || seen.has(t)) return;
        seen.add(t);
        ranked.push(t);
    };

    if (myIpnsKey) {
        push(shardTopic(homeShard(myIpnsKey)));
        push(circleTopic(myIpnsKey));

        // Same-machine Firefox↔Chromium without mutual follows / global v1
        if (isLocalDevHost()) {
            push(DEV_LOCAL_RENDEZVOUS_TOPIC);
        }

        for (const n of neighborShards(myIpnsKey)) {
            push(shardTopic(n));
        }

        const follows = followKeys.filter(Boolean);
        let circleAdds = 0;
        const maxFollowCircles = Math.max(0, MAX_CIRCLE_ROOMS - 1);
        for (const key of follows) {
            if (key === myIpnsKey) continue;
            if (circleAdds >= maxFollowCircles) break;
            push(circleTopic(key));
            circleAdds += 1;
        }
    }

    for (const t of customChannels) {
        // Never sneak the global v1 mesh in via custom channels
        if (t === PEER_DISCOVERY_TOPIC) continue;
        push(t);
    }

    if (includeLegacy) {
        push(PEER_DISCOVERY_TOPIC);
    }

    return ranked.slice(0, Math.max(0, maxStickyRooms));
}

/** Unsigned distance on the shard ring (for mesh subsample). */
export function shardDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % NUM_SHARDS;
    return Math.min(d, NUM_SHARDS - d);
}

/** Prefer peers in our home/neighbor shards for Explore seeding. */
export function isLocalClusterPeer(myIpnsKey: string, peerIpnsKey: string): boolean {
    if (!myIpnsKey || !peerIpnsKey) return false;
    const mine = new Set([homeShard(myIpnsKey), ...neighborShards(myIpnsKey)]);
    return mine.has(homeShard(peerIpnsKey));
}
