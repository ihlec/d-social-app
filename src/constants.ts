// fileName: src/constants.ts

// Network & Topics
export const PEER_DISCOVERY_TOPIC = 'dsocial-peers-v1';
export const DEFAULT_USER_STATE_CID = "QmRh23Gd4AJLBH82CN9wz2MAe6sY95AqDSDBMFW1qnheny";

// Timeouts & Intervals
export const POST_COOLDOWN_MS = 300 * 1000; // 5 minutes
export const IPNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- PERFORMANCE TUNING ---
export const KUBO_RPC_TIMEOUT_MS = 5000;       // 5s: Fast reads (content)
export const KUBO_RESOLVE_TIMEOUT_MS = 20000;  // 20s: IPNS Resolution (needs DHT time)
export const KUBO_PUBLISH_TIMEOUT_MS = 60000;  // 60s: IPNS Publishing (slow DHT propagation)

export const GATEWAY_TIMEOUT_MS = 30000;        // 30s: Allow time for DHT lookups and network congestion
export const IPNS_RESOLVE_TIMEOUT_MS = 20000;  // 20s: Overall Resolve Limit

// Gateway Timeouts (Local vs Public)
export const LOCAL_GATEWAY_TIMEOUT_MS = 60000;  // 60 seconds: Fail fast to allow public gateways to try
export const LOCAL_IPNS_TIMEOUT_MS = 120000;     // 2 minutes: IPNS resolution should be faster than content retrieval
export const PUBLIC_GATEWAY_TIMEOUT_MS = 30000;  // 30 seconds: Allow time for DHT lookups (10-30s typical)

// Logic Constants
export const MAX_POSTS_PER_STATE = 100; // Bucketing limit

// Storage Keys
export const SESSION_COOKIE_PREFIX = 'dSocialSession';
export const TEMP_POST_PREFIX = 'temp-';
export const CURRENT_USER_LABEL_KEY = 'currentUserLabel';

// --- GATEWAY CONFIGURATION (Source of Truth) ---
// Note: We removed dweb.link (subdomain gateways) due to 504 Timeouts.
// These are now simple string arrays to support the new "Ranked" logic.

export const PUBLIC_IPNS_GATEWAYS = [
    'https://ipfs.io/ipns/',
    'https://gateway.pinata.cloud/ipns/',
    'https://ipfs.filebase.io/ipns/',
    'https://k51qzi5uqu5dj.ipns.dweb.link/' // Example subdomain fallback, though dynamic is better
];

export const PUBLIC_CONTENT_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.filebase.io/ipfs/',
    'https://4everland.io/ipfs/'
];