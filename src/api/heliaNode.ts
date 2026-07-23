/**
 * Browser Helia node — sole write/identity plane (no Kubo).
 *
 * Libp2p is dial-capped: browsers hit WebSocket/"Insufficient resources"
 * limits quickly under Helia's default bootstrap + DHT client settings.
 *
 * All UnixFS writes use IPIP-0499 `unixfs-v1-2025` so CIDs match other
 * modern importers (Helia/Kubo CIDv1/Storacha) for the same bytes.
 */

import type { Helia } from 'helia';
import type { AddOptions, UnixFS } from '@helia/unixfs';
import type { IPNS } from '@helia/ipns';
import { CID } from 'multiformats/cid';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';

const DEFAULT_KEYCHAIN_PASSWORD = 'dsocial-helia-keychain-v1';
/** How often @helia/ipns re-puts published records (multi-hour browser sessions). */
const IPNS_REPUBLISH_INTERVAL_MS = 15 * 60 * 1000;
const IPNS_RECORD_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/** IPIP-0499 modern profile — https://specs.ipfs.tech/ipips/ipip-0499/ */
export const UNIXFS_CID_PROFILE = 'unixfs-v1-2025' as const;

/**
 * Explicit importer settings for `unixfs-v1-2025`.
 * Passed on every add so we do not silently inherit a future Helia default drift.
 */
export const UNIXFS_V1_2025_ADD_OPTIONS: AddOptions = {
    profile: UNIXFS_CID_PROFILE,
    cidVersion: 1,
    rawLeaves: true,
    shardSplitStrategy: 'block-bytes',
    shardSplitThresholdBytes: 262_144,
    shardFanoutBits: 8, // HAMT fanout 256
    chunker: fixedSize({ chunkSize: 1_048_576 }),
    layout: balanced({ maxChildrenPerNode: 1024 }),
};

let heliaPromise: Promise<Helia> | null = null;
let fsInstance: UnixFS | null = null;
let ipnsInstance: IPNS | null = null;
let activePassword: string = DEFAULT_KEYCHAIN_PASSWORD;

type ClosableStore = { close: () => Promise<void> };
let activeBlockstore: ClosableStore | null = null;
let activeDatastore: ClosableStore | null = null;

/** Serialize stop / wipe / start so GC and upload cannot race IndexedDB. */
let heliaLifecycle: Promise<void> = Promise.resolve();
let lifecycleHeld = false;

function enqueueHeliaLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    // Re-entrant: wipe/start call unlocked helpers while already holding the lock.
    if (lifecycleHeld) return fn();
    const run = heliaLifecycle.then(
        async () => {
            lifecycleHeld = true;
            try {
                return await fn();
            } finally {
                lifecycleHeld = false;
            }
        },
        async () => {
            lifecycleHeld = true;
            try {
                return await fn();
            } finally {
                lifecycleHeld = false;
            }
        }
    );
    heliaLifecycle = run.then(() => undefined, () => undefined);
    return run;
}

/** @helia/ipns starts republisher on Helia `start`; expose start() for late/safe kick. */
type IPNSWithLifecycle = IPNS & { start?: () => void; stop?: () => void };

function ensureIpnsRepublisherStarted(): void {
    const api = ipnsInstance as IPNSWithLifecycle | null;
    if (api && typeof api.start === 'function') {
        api.start();
    }
}

export type HeliaStatus = 'idle' | 'starting' | 'ready' | 'error';

let status: HeliaStatus = 'idle';
let lastError: string | null = null;

export function getHeliaStatus(): { status: HeliaStatus; error: string | null } {
    return { status, error: lastError };
}

export function getKeychainPassword(): string {
    return activePassword;
}

function shouldDenyDial(multiaddr: { toString(): string }): boolean {
    const s = multiaddr.toString();
    // Local / invalid / wildcard DNSAddrs blow up the dial queue in browsers
    if (
        s.includes('/ip4/127.0.0.1') ||
        s.includes('/ip4/0.0.0.0') ||
        s.includes('/ip6/::1') ||
        s.includes('/dnsaddr/localhost') ||
        s.includes('%2A') ||
        s.includes('/*.') ||
        s.includes('/dns/localhost')
    ) {
        return true;
    }
    return false;
}

/** Drop unreadable libp2p "self" peer key so a fresh one can be created. */
async function clearLibp2pSelfKey(datastore: { delete: (key: import('interface-datastore').Key) => Promise<void> }): Promise<void> {
    const { Key } = await import('interface-datastore');
    for (const path of ['/pkcs8/self', '/info/self']) {
        try {
            await datastore.delete(new Key(path));
        } catch { /* ignore */ }
    }
}

function isSelfKeyCorruptError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return (
        msg.includes('Encrypted key was not a libp2p-key') ||
        msg.includes('Decryption failed') ||
        msg.includes('decrypt')
    );
}

async function createBrowserHelia(pass: string): Promise<Helia> {
    const [
        { createHeliaLight },
        { withHTTP },
        { withLibp2p },
        { withBitswap },
        { unixfs },
        { ipns },
        { keychain: createHeliaKeychain },
        { IDBBlockstore },
        { IDBDatastore },
        dagCbor,
        dagJson,
        jsonCodec,
        { sha512 },
    ] = await Promise.all([
        import('helia'),
        import('@helia/http'),
        import('@helia/libp2p'),
        import('@helia/bitswap'),
        import('@helia/unixfs'),
        import('@helia/ipns'),
        import('@ipshipyard/keychain'),
        import('blockstore-idb'),
        import('datastore-idb'),
        import('@ipld/dag-cbor'),
        import('@ipld/dag-json'),
        import('multiformats/codecs/json'),
        import('multiformats/hashes/sha2'),
    ]);

    const { isGatewayFallbackEnabled } = await import('../lib/gatewayFallback');
    const allowHttpGateways = isGatewayFallbackEnabled();

    const blockstore = new IDBBlockstore('dsocial-helia-blocks');
    const datastore = new IDBDatastore('dsocial-helia-data');
    await blockstore.open();
    await datastore.open();
    activeBlockstore = blockstore;
    activeDatastore = datastore;

    const build = () => {
        // Same stack as createHelia(), with browser-safe dial limits.
        // Do NOT pass a custom libp2p keychain password — the peer "self" key
        // in IDB was created with libp2p defaults; overriding `pass` breaks boot.
        // withHTTP (trustless gateways) only when Settings opts in — otherwise
        // Helia is local CAS + bitswap peers; Trystero is the sync path.
        const light = createHeliaLight({
            blockstore,
            datastore,
            codecs: [dagCbor, dagJson, jsonCodec],
            hashers: [sha512],
        });
        const routed = allowHttpGateways ? withHTTP(light) : light;
        const node = withBitswap(
            withLibp2p(
                routed,
                {
                    connectionManager: {
                        maxConnections: 6,
                        maxParallelDials: 1,
                        maxDialQueueLength: 8,
                        maxPeerAddrsToDial: 2,
                        dialTimeout: 5_000,
                        addressDialTimeout: 3_000,
                        maxIncomingPendingConnections: 1,
                    },
                    connectionGater: {
                        denyDialMultiaddr: async (ma: { toString(): string }) => shouldDenyDial(ma),
                    },
                }
            )
        );

        // Helia currently ignores HeliaInit.keychain — wire password ourselves
        // for identity keys (separate from the libp2p peer "self" key).
        const components = (node as unknown as { components: Record<string, unknown> }).components;
        const identityKeychain = createHeliaKeychain({ password: pass })(components as any);
        (node as any).keychain = components.keychain = identityKeychain;

        return node;
    };

    // @helia/ipns constructor touches libp2p and throws NotStartedError if wired
    // before helia.start(). Attach after start, then kick republisher manually
    // (it only auto-starts on the Helia `start` event, which already fired).
    const attachServices = (node: Helia) => {
        fsInstance = unixfs(node);
        ipnsInstance = ipns(node, {
            republishInterval: IPNS_REPUBLISH_INTERVAL_MS,
        });
        ensureIpnsRepublisherStarted();
    };

    let helia = build();
    try {
        if (helia.status !== 'started') {
            await helia.start();
        }
    } catch (e) {
        if (!isSelfKeyCorruptError(e)) throw e;
        console.warn('[Helia] Unreadable peer self-key in IndexedDB — regenerating');
        try { await helia.stop(); } catch { /* ignore */ }
        await clearLibp2pSelfKey(datastore);
        helia = build();
        if (helia.status !== 'started') {
            await helia.start();
        }
    }

    attachServices(helia);
    return helia;
}

async function closeStores(): Promise<void> {
    const bs = activeBlockstore;
    const ds = activeDatastore;
    activeBlockstore = null;
    activeDatastore = null;
    try { await bs?.close(); } catch { /* ignore */ }
    try { await ds?.close(); } catch { /* ignore */ }
}

async function stopHeliaUnlocked(): Promise<void> {
    if (!heliaPromise) {
        await closeStores();
        return;
    }
    const pending = heliaPromise;
    heliaPromise = null;
    fsInstance = null;
    ipnsInstance = null;
    status = 'idle';
    try {
        const h = await pending;
        await h.stop();
    } catch { /* ignore */ }
    await closeStores();
}

export async function stopHelia(): Promise<void> {
    return enqueueHeliaLifecycle(() => stopHeliaUnlocked());
}

const HELIA_BLOCKSTORE_IDB = 'dsocial-helia-blocks';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Delete an IndexedDB. Must only run after all connections are closed.
 * Retries on `blocked` — never pretends success while another handle is open.
 */
async function deleteIndexedDb(name: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    for (let attempt = 0; attempt < 8; attempt++) {
        const outcome = await new Promise<'ok' | 'blocked' | 'error'>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve('ok');
            req.onerror = () => resolve('error');
            req.onblocked = () => resolve('blocked');
        });
        if (outcome === 'ok') return;
        console.warn(
            `[Helia] deleteDatabase(${name}) ${outcome} (attempt ${attempt + 1}/8) — closing stores & retrying`
        );
        await closeStores();
        await sleep(400 + attempt * 200);
    }
    throw new Error(
        `Could not delete ${name}. Close other tabs open on this app, then try again.`
    );
}

async function startHeliaUnlocked(pass: string): Promise<Helia> {
    if (heliaPromise && activePassword === pass) {
        return heliaPromise;
    }
    if (heliaPromise) {
        await stopHeliaUnlocked();
    }

    activePassword = pass;
    status = 'starting';
    lastError = null;

    heliaPromise = (async () => {
        try {
            const helia = await createBrowserHelia(pass);
            status = 'ready';
            console.log('[Helia] Browser node ready');
            return helia;
        } catch (e: any) {
            status = 'error';
            lastError = e?.message || String(e);
            heliaPromise = null;
            console.error('[Helia] Failed to start', e);
            throw e;
        }
    })();

    return heliaPromise;
}

/**
 * Nuclear reclaim: stop Helia, close IDB handles, delete media blockstore, restart.
 * Keeps `dsocial-helia-data` (identity / IPNS / libp2p keys).
 */
export async function wipeHeliaBlockstore(): Promise<void> {
    const pass = activePassword;
    await enqueueHeliaLifecycle(async () => {
        await stopHeliaUnlocked();
        await deleteIndexedDb(HELIA_BLOCKSTORE_IDB);
        console.info('[Helia] Wiped blockstore IndexedDB', HELIA_BLOCKSTORE_IDB);
        await startHeliaUnlocked(pass);
    });
}

export async function startHelia(password?: string): Promise<Helia> {
    const pass = (password && password.length > 0) ? password : DEFAULT_KEYCHAIN_PASSWORD;
    if (heliaPromise && activePassword === pass && status === 'ready') {
        return heliaPromise;
    }
    return enqueueHeliaLifecycle(() => startHeliaUnlocked(pass));
}

export async function getHelia(): Promise<Helia> {
    return startHelia(activePassword);
}

export async function getUnixFs(): Promise<UnixFS> {
    await getHelia();
    if (!fsInstance) throw new Error('Helia UnixFS not initialized');
    return fsInstance;
}

export async function getIpns(): Promise<IPNS> {
    await getHelia();
    if (!ipnsInstance) throw new Error('Helia IPNS not initialized');
    return ipnsInstance;
}

export function isHeliaAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
}

/** Ensure an identity key exists; returns IPNS name (k51… without /ipns/ prefix). */
export async function ensureIdentityKey(keyName: string): Promise<{ keyName: string; ipnsName: string }> {
    const helia = await getHelia();

    try {
        await helia.keychain.exportKey(keyName);
    } catch {
        await helia.keychain.generateKey(keyName);
    }

    const priv = await helia.keychain.exportKey(keyName);
    const ipnsName = priv.publicKey.toCID().toString();
    try {
        const { base36 } = await import('multiformats/bases/base36');
        return { keyName, ipnsName: priv.publicKey.toCID().toString(base36) };
    } catch {
        return { keyName, ipnsName };
    }
}

export async function listIdentityKeys(): Promise<string[]> {
    const helia = await getHelia();
    const names: string[] = [];
    for await (const info of helia.keychain.listKeys()) {
        if (info.name && info.name !== 'self') names.push(info.name);
    }
    return names;
}

function ipnsNameFromPublish(name: string): string {
    return name.startsWith('/ipns/') ? name.slice(6) : name;
}

/**
 * Publish IPNS: local record always, network put + content provide best-effort.
 * Browser delegated PUT often fails; that must not block the app write path.
 */
export async function publishIpns(keyName: string, cidStr: string): Promise<string> {
    const helia = await getHelia();
    const nameApi = await getIpns();
    const cid = CID.parse(cidStr);
    ensureIpnsRepublisherStarted();

    let name = '';

    // 1) Local always — IndexedDB-backed record for this browser
    try {
        const local = await nameApi.publish(keyName, cid, {
            lifetime: IPNS_RECORD_LIFETIME_MS,
            offline: true,
        });
        name = ipnsNameFromPublish(local.name);
        console.log(`[Helia] IPNS local ok ${cidStr} → ${name}`);
        try {
            const { rememberIpnsResolution } = await import('./resolution');
            rememberIpnsResolution(name, cidStr);
        } catch { /* ignore */ }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Helia] IPNS local failed: ${msg}`);
        throw e;
    }

    // 2–3) Network put + provide — fire-and-forget so callers (post UI / persistence
    // queue) never block on delegated routing / DHT, which often stalls in browsers.
    void (async () => {
        try {
            const net = await nameApi.publish(keyName, cid, {
                lifetime: IPNS_RECORD_LIFETIME_MS,
            });
            const netName = ipnsNameFromPublish(net.name);
            console.log(`[Helia] IPNS network put ok ${cidStr} → ${netName}`);
            try {
                const { rememberIpnsResolution } = await import('./resolution');
                rememberIpnsResolution(netName, cidStr);
            } catch { /* ignore */ }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[Helia] IPNS network put failed: ${msg}`);
        }

        try {
            await helia.routing.provide(cid);
            console.log(`[Helia] provide ok ${cidStr}`);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[Helia] provide failed: ${msg}`);
        }
    })();

    return name;
}

/**
 * Resolve an IPNS name from the local Helia record store (no network).
 * Works for names this browser has published even before public gateways see them.
 */
export async function heliaResolveIpnsOffline(ipnsName: string): Promise<string> {
    if (!ipnsName || status !== 'ready' || !ipnsInstance) return '';
    try {
        const nameApi = await getIpns();
        const key = ipnsName.startsWith('/ipns/') ? ipnsName.slice(6) : ipnsName;
        for await (const result of nameApi.resolve(key, { offline: true })) {
            const value = result.value || '';
            if (value.startsWith('/ipfs/')) return value.slice(6).split('/')[0];
            if (value.startsWith('Qm') || value.startsWith('baf')) return value.split('/')[0];
        }
    } catch { /* no local record */ }
    return '';
}

/** Local UnixFS size in bytes, or null if missing / not a file. Offline only. */
export async function heliaStatSize(cidStr: string): Promise<number | null> {
    if (status !== 'ready') return null;
    try {
        const helia = await getHelia();
        const cid = CID.parse(cidStr);
        if (!(await helia.blockstore.has(cid))) return null;
        const fs = await getUnixFs();
        const st = await fs.stat(cid, { offline: true });
        return Number(st.size);
    } catch {
        return null;
    }
}

/**
 * Read raw bytes from the local Helia node (UnixFS). Returns null if missing.
 * Optional `maxBytes` aborts before buffering oversized files (avoids tab OOM).
 */
export async function heliaCatBytes(
    cidStr: string,
    maxBytes?: number
): Promise<Uint8Array | null> {
    if (status !== 'ready') return null;
    try {
        const helia = await getHelia();
        const cid = CID.parse(cidStr);
        // Prefer local blocks only — avoid bitswap dial storms for missing CIDs.
        if (!(await helia.blockstore.has(cid))) return null;
        const fs = await getUnixFs();

        if (maxBytes != null) {
            try {
                const st = await fs.stat(cid, { offline: true });
                if (Number(st.size) > maxBytes) return null;
            } catch {
                /* continue; stream guard below */
            }
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of fs.cat(cid)) {
            total += chunk.byteLength;
            if (maxBytes != null && total > maxBytes) return null;
            chunks.push(chunk);
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return out;
    } catch {
        return null;
    }
}

export async function heliaCatJson<T = unknown>(cidStr: string): Promise<T | null> {
    const bytes = await heliaCatBytes(cidStr);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
        return null;
    }
}

/** True when IndexedDB / Helia blockstore is out of space. */
export function isStorageQuotaError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    const name = e && typeof e === 'object' && 'name' in e ? String((e as { name?: string }).name) : '';
    return (
        name === 'QuotaExceededError'
        || name === 'PutFailedError'
        || /QuotaExceeded/i.test(msg)
        || /quota limitations/i.test(msg)
    );
}

export async function heliaAddBytes(bytes: Uint8Array, pin: boolean = true): Promise<string> {
    const helia = await getHelia();
    const fs = await getUnixFs();
    try {
        const cid = await fs.addBytes(bytes, UNIXFS_V1_2025_ADD_OPTIONS);
        if (pin) {
            try { await helia.pins.add(cid); } catch (e) {
                console.warn('[Helia] pin failed (content still added)', e);
            }
        }
        return cid.toString();
    } catch (e) {
        if (isStorageQuotaError(e)) {
            throw new Error(
                'Browser storage is full (Helia IndexedDB quota). Delete old posts/media or clear this site’s stored data, then try again.'
            );
        }
        throw e;
    }
}

export async function heliaAddBlob(blob: Blob, pin: boolean = true): Promise<string> {
    return heliaAddBytes(new Uint8Array(await blob.arrayBuffer()), pin);
}

export async function heliaAddJson(data: unknown, pin: boolean = true): Promise<string> {
    return heliaAddBytes(new TextEncoder().encode(JSON.stringify(data)), pin);
}

export async function heliaPin(cidStr: string): Promise<void> {
    const helia = await getHelia();
    await helia.pins.add(CID.parse(cidStr));
}

export async function heliaUnpin(cidStr: string): Promise<void> {
    const helia = await getHelia();
    try {
        await helia.pins.rm(CID.parse(cidStr));
    } catch { /* ignore */ }
}

export async function heliaHasBlock(cidStr: string): Promise<boolean> {
    try {
        const helia = await getHelia();
        return helia.blockstore.has(CID.parse(cidStr));
    } catch {
        return false;
    }
}

export async function heliaListPins(): Promise<Set<string>> {
    const helia = await getHelia();
    const pins = new Set<string>();
    for await (const { cid } of helia.pins.ls()) {
        pins.add(cid.toString());
    }
    return pins;
}
