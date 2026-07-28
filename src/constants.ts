
// Network & Topics
/**
 * Localhost-only rendezvous so two browsers on the same machine can meet without
 * mutual follows. Never joined on production hosts.
 */
export const DEV_LOCAL_RENDEZVOUS_TOPIC = 'dsocial-dev-local';
/**
 * Default-on public rendezvous so logged-in peers on production hosts (e.g. IPFS
 * app links) find each other without follows or Settings fiddling. Opt out via Settings.
 */
export const BOOTSTRAP_TOPIC = 'dsocial-bootstrap';
/**
 * Time-sliced rendezvous: `dsocial-meetup/<0..NUM_MEETUP_SLOTS-1>`.
 * All online peers join the current (and previous) slot so strangers collide
 * without random tourist hops. Ephemeral — not part of the sticky room budget.
 */
export const MEETUP_TOPIC_PREFIX = 'dsocial-meetup';
/** Wall-clock slot length for meetup rotation. */
export const MEETUP_SLOT_MS = 2 * 60 * 1000;
/** Rotating meetup topics (smaller = denser lobbies; PoC-friendly). */
export const NUM_MEETUP_SLOTS = 4;
/** Also hold the previous slot this long after a boundary (overlap). */
export const MEETUP_OVERLAP_MS = 45_000;
/** Hash-sharded presence rooms: `dsocial-peers-v2/<0..NUM_SHARDS-1>`. */
export const PEER_TOPIC_PREFIX_V2 = 'dsocial-peers-v2';
export const CIRCLE_TOPIC_PREFIX = 'dsocial-circle';
/** Per-CID rendezvous for guest/share-link fetch: `dsocial-cid/<cid>`. */
export const CONTENT_TOPIC_PREFIX = 'dsocial-cid';
/** Want shards so savers/authors can be summoned without post UI open. */
export const WANT_TOPIC_PREFIX = 'dsocial-want';
export const NUM_WANT_SHARDS = 32;
/**
 * Max want-shard rooms a holder joins (own/liked/saved serve set).
 * Kept tiny vs WebRTC mesh budget; shards are chosen by coverage density.
 */
export const MAX_WANT_ROOMS = 2;
/** Newest own+liked+saved CIDs considered when picking want-shard coverage. */
export const MAX_SERVE_CIDS = 40;
/** Idle leave for non-sticky content rooms. */
export const CONTENT_ROOM_IDLE_MS = 45_000;
/** Max content-room joins per rolling minute (spam cap). */
export const CONTENT_ROOM_JOINS_PER_MINUTE = 6;
/** Wait for WebRTC peers in a content room (ICE/TURN can be slow). */
export const CONTENT_ROOM_PEER_WAIT_MS = 25_000;
/** How many times a guest retries syncPost while waiting for a holder. */
export const CONTENT_ROOM_FETCH_ROUNDS = 4;
/** Min interval between want publishes for the same CID. */
export const WANT_PUBLISH_MIN_INTERVAL_MS = 8_000;
/** Shard count for ~100 peers/shard at 100k concurrent online. */
export const NUM_SHARDS = 1024;
/** Adjacent shards each peer also joins for cross-cluster overlap. */
export const NEIGHBOR_SHARD_COUNT = 2;
/**
 * Max peers we keep mapped per Trystero room (browser mesh safety).
 * Closer to realistic WebRTC PeerConnection budget than a full room census.
 */
export const MESH_PEER_CAP = 32;
/** Max ipns→peer mappings remembered locally. */
export const MAX_MAPPED_ONLINE_PEERS = 500;
/** Max follow-circle rooms considered before sticky budget cut (ego + follows). */
export const MAX_CIRCLE_ROOMS = 16;
/**
 * Hard cap on sticky Trystero rooms per tab (home + neighbors + circles + custom).
 * Primary lever for WebRTC load — Trystero full-meshes everyone in each joined room.
 */
export const MAX_STICKY_ROOMS = 8;
/** Join `dsocial-bootstrap` when unset / `1` (PoC tester discovery). */
export const INCLUDE_BOOTSTRAP_ROOM_DEFAULT = true;
/** localStorage key — set `0` to opt out of the public bootstrap room. */
export const BOOTSTRAP_ROOM_STORAGE_KEY = 'bootstrap_room';
/** localStorage / query flag for mesh debug metrics. */
export const DEBUG_MESH_STORAGE_KEY = 'dsocial_debug_mesh';

export const DEFAULT_NOSTR_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://nostr.mom',
    'wss://relay.snort.social',
];

export const DEFAULT_USER_STATE_CID = "QmRh23Gd4AJLBH82CN9wz2MAe6sY95AqDSDBMFW1qnheny";

// Timeouts & Intervals
/** Short rate-limit after a successful post (not tied to IPNS DHT). */
export const POST_COOLDOWN_MS = 30 * 1000; // 30 seconds
export const IPNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
/** Skip Phase-2 IPNS revalidation for a follow if checked within this window */
export const IPNS_REVALIDATE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const FEED_FOLLOW_BATCH_SIZE = 4;
/** Max media bytes served/fetched over Trystero (WebRTC data channel). */
export const MAX_P2P_MEDIA_BYTES = 20 * 1024 * 1024;
/**
 * Max file size for in-app uploads. Keep ≤ MAX_P2P_MEDIA_BYTES so peers
 * can still fetch via syncMedia; larger files belong outside this PoC.
 */
export const MAX_UPLOAD_BYTES = MAX_P2P_MEDIA_BYTES;
/** Timeout for a single peer media request. */
export const MEDIA_SYNC_TIMEOUT_MS = 90_000;
/** Cap media CIDs pulled after a tip sync (thumbs first). */
export const MAX_P2P_MEDIA_PER_SYNC = 8;

// Logic Constants
export const MAX_POSTS_PER_STATE = 100; // Bucketing limit

// Storage Keys
export const SESSION_COOKIE_PREFIX = 'dSocialSession';
/** sessionStorage + legacy key for current identity label. */
export const CURRENT_USER_LABEL_KEY = 'currentUserLabel';
/** localStorage — survives tab close / refresh (session persistence). */
export const ACTIVE_IDENTITY_STORAGE_KEY = 'dsocial_active_identity';
/** localStorage backup of session JSON (cookies can be blocked). */
/** Bumped for CAS migration — old Helia session backups must not auto-login. */
export const SESSION_BACKUP_STORAGE_KEY = 'dsocial_session_v2';
export const SESSION_BACKUP_LEGACY_KEYS = ['dsocial_session_v1'] as const;
