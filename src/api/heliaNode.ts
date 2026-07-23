/**
 * Browser Helia node — sole write/identity plane (no Kubo).
 *
 * Libp2p is dial-capped: browsers hit WebSocket/"Insufficient resources"
 * limits quickly under Helia's default bootstrap + DHT client settings.
 */

import type { Helia } from 'helia';
import type { UnixFS } from '@helia/unixfs';
import type { IPNS } from '@helia/ipns';
import { CID } from 'multiformats/cid';

const DEFAULT_KEYCHAIN_PASSWORD = 'dsocial-helia-keychain-v1';

let heliaPromise: Promise<Helia> | null = null;
let fsInstance: UnixFS | null = null;
let ipnsInstance: IPNS | null = null;
let activePassword: string = DEFAULT_KEYCHAIN_PASSWORD;

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

    const blockstore = new IDBBlockstore('dsocial-helia-blocks');
    const datastore = new IDBDatastore('dsocial-helia-data');
    await blockstore.open();
    await datastore.open();

    const build = () => {
        // Same stack as createHelia(), with browser-safe dial limits.
        // Do NOT pass a custom libp2p keychain password — the peer "self" key
        // in IDB was created with libp2p defaults; overriding `pass` breaks boot.
        const node = withBitswap(
            withLibp2p(
                withHTTP(
                    createHeliaLight({
                        blockstore,
                        datastore,
                        codecs: [dagCbor, dagJson, jsonCodec],
                        hashers: [sha512],
                    })
                ),
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

    fsInstance = unixfs(helia);
    ipnsInstance = ipns(helia);
    return helia;
}

export async function stopHelia(): Promise<void> {
    if (!heliaPromise) return;
    const pending = heliaPromise;
    heliaPromise = null;
    fsInstance = null;
    ipnsInstance = null;
    status = 'idle';
    try {
        const h = await pending;
        await h.stop();
    } catch { /* ignore */ }
}

export async function startHelia(password?: string): Promise<Helia> {
    const pass = (password && password.length > 0) ? password : DEFAULT_KEYCHAIN_PASSWORD;

    // Reuse ready OR in-flight start with the same keychain password (avoids triple-boot).
    if (heliaPromise && activePassword === pass) {
        return heliaPromise;
    }

    if (heliaPromise) {
        await stopHelia();
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

export async function publishIpns(keyName: string, cidStr: string): Promise<string> {
    const nameApi = await getIpns();
    const cid = CID.parse(cidStr);
    const result = await nameApi.publish(keyName, cid, {
        lifetime: 1000 * 60 * 60 * 24 * 30, // 30 days
    });
    const name = result.name.startsWith('/ipns/') ? result.name.slice(6) : result.name;
    console.log(`[Helia] Published ${cidStr} → ${name}`);
    try {
        const { rememberIpnsResolution } = await import('./resolution');
        rememberIpnsResolution(name, cidStr);
    } catch { /* ignore */ }
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

/** Read raw bytes from the local Helia node (UnixFS). Returns null if missing locally. */
export async function heliaCatBytes(cidStr: string): Promise<Uint8Array | null> {
    if (status !== 'ready') return null;
    try {
        const helia = await getHelia();
        const cid = CID.parse(cidStr);
        // Prefer local blocks only — avoid bitswap dial storms for missing CIDs.
        if (!(await helia.blockstore.has(cid))) return null;
        const fs = await getUnixFs();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of fs.cat(cid)) {
            chunks.push(chunk);
            total += chunk.byteLength;
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

export async function heliaAddBytes(bytes: Uint8Array, pin: boolean = true): Promise<string> {
    const helia = await getHelia();
    const fs = await getUnixFs();
    const cid = await fs.addBytes(bytes);
    if (pin) {
        try { await helia.pins.add(cid); } catch (e) {
            console.warn('[Helia] pin failed (content still added)', e);
        }
    }
    return cid.toString();
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
