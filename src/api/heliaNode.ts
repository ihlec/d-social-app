/**
 * Local node API — IndexedDB CAS + WebCrypto identity (no Helia).
 * Export names stay Helia-shaped so call sites need minimal changes.
 *
 * Content IDs: CIDv1 + raw + sha2-256 (`bafkrei…`).
 * Peer / "IPNS" ids: CIDv1(raw, sha256(SPKI)) of the identity public key.
 * Tips are local only; sync between peers is Trystero.
 */

import {
    casPutBlock,
    casGetBlock,
    casHasBlock,
    casDeleteBlock,
    casPin,
    casUnpin,
    casListPins,
    casBlockSize,
    casSetTip,
    casGetTip,
    casWipeBlocks,
    isCasAvailable,
} from '../lib/cas/db';
import { hashBytesToCid } from '../lib/cas/hash';
import {
    ensureLocalIdentity,
    listLocalIdentityNames,
    getPublicIdForKeyName,
    hasLocalIdentity,
} from '../lib/cas/identity';

export type HeliaStatus = 'idle' | 'starting' | 'ready' | 'error';

let status: HeliaStatus = 'idle';
let lastError: string | null = null;
let readyPromise: Promise<void> | null = null;
let activePassword: string = '';

/** Serialize wipe / start so GC and upload cannot race IndexedDB. */
let lifecycle: Promise<void> = Promise.resolve();
let lifecycleHeld = false;

function enqueueLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    if (lifecycleHeld) return fn();
    const run = lifecycle.then(
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
    lifecycle = run.then(() => undefined, () => undefined);
    return run;
}

export function getHeliaStatus(): { status: HeliaStatus; error: string | null } {
    return { status, error: lastError };
}

export function getKeychainPassword(): string {
    return activePassword;
}

export function isHeliaAvailable(): boolean {
    return isCasAvailable();
}

/** True when IndexedDB is out of space. */
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

async function startUnlocked(): Promise<void> {
    if (status === 'ready' && readyPromise) return readyPromise;

    status = 'starting';
    lastError = null;

    readyPromise = (async () => {
        if (!isCasAvailable()) {
            throw new Error('IndexedDB unavailable in this browser');
        }
        // Best-effort drop legacy Helia IDBs + old feed cache (fresh start).
        await deleteLegacyHeliaIdbs();
        await purgeLegacyFeedCaches();
        status = 'ready';
        console.log('[CAS] Local node ready');
    })();

    try {
        await readyPromise;
    } catch (e: unknown) {
        status = 'error';
        lastError = e instanceof Error ? e.message : String(e);
        readyPromise = null;
        console.error('[CAS] Failed to start', e);
        throw e;
    }
}

function deleteIndexedDb(name: string): Promise<'ok' | 'blocked' | 'error'> {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve('ok');
            req.onblocked = () => resolve('blocked');
            req.onerror = () => resolve('error');
        } catch {
            resolve('error');
        }
    });
}

async function deleteLegacyHeliaIdbs(): Promise<void> {
    // Once per tab session — avoid hammering on every startHelia call.
    const flag = 'dsocial_legacy_helia_wiped_v1';
    try {
        if (sessionStorage.getItem(flag) === '1') return;
    } catch { /* ignore */ }

    for (const name of ['dsocial-helia-blocks', 'dsocial-helia-data']) {
        try {
            await deleteIndexedDb(name);
        } catch { /* ignore */ }
    }
    try {
        sessionStorage.setItem(flag, '1');
    } catch { /* ignore */ }
}

/** One-time wipe of Helia-era feed IDB so init/login doesn't resurrect old posts. */
async function purgeLegacyFeedCaches(): Promise<void> {
    const flag = 'dsocial_cas_feed_purged_v1';
    try {
        if (localStorage.getItem(flag) === '1') return;
    } catch { /* ignore */ }

    try {
        const { clearContentCache } = await import('../lib/contentCache');
        await clearContentCache();
    } catch (e) {
        console.warn('[CAS] feed cache purge failed', e);
    }
    try {
        localStorage.setItem(flag, '1');
    } catch { /* ignore */ }
}

/**
 * Start local CAS. Pass a string (including `''`) to set/clear the identity
 * passphrase; omit the arg to keep the current in-memory passphrase.
 */
export async function startHelia(password?: string): Promise<void> {
    if (password !== undefined) activePassword = password;
    return enqueueLifecycle(() => startUnlocked());
}

/** @deprecated Compatibility stub — CAS has no Helia instance. */
export async function getHelia(): Promise<null> {
    await startHelia();
    return null;
}

/** Wipe content blocks + pins; keep identities and tips. */
export async function wipeHeliaBlockstore(): Promise<void> {
    await enqueueLifecycle(async () => {
        await startUnlocked();
        await casWipeBlocks();
        console.info('[CAS] Wiped content blocks + pins');
    });
}

/** Ensure an identity exists; `ipnsName` is the public peer id (bafkrei…). */
export async function ensureIdentityKey(
    keyName: string
): Promise<{ keyName: string; ipnsName: string }> {
    await startHelia();
    const { keyName: name, publicId } = await ensureLocalIdentity(
        keyName,
        activePassword || undefined
    );
    return { keyName: name, ipnsName: publicId };
}

/** Look up an existing identity only (restore path — never creates). */
export async function getExistingIdentityKey(
    keyName: string
): Promise<{ keyName: string; ipnsName: string } | null> {
    await startHelia();
    const trimmed = keyName.trim();
    if (!(await hasLocalIdentity(trimmed))) return null;
    const publicId = await getPublicIdForKeyName(trimmed);
    if (!publicId) return null;
    return { keyName: trimmed, ipnsName: publicId };
}

export async function listIdentityKeys(): Promise<string[]> {
    await startHelia();
    return listLocalIdentityNames();
}

/**
 * Publish tip: local tip always + resolution cache.
 * Network IPNS is gone — peers learn tips via Trystero.
 */
export async function publishIpns(keyName: string, cidStr: string): Promise<string> {
    await startHelia();
    const publicId = await getPublicIdForKeyName(keyName);
    if (!publicId) {
        throw new Error(`Unknown identity "${keyName}" — login first`);
    }
    await casSetTip(publicId, cidStr);
    console.log(`[CAS] tip ${cidStr.slice(0, 12)}… → ${publicId.slice(0, 16)}…`);
    try {
        const { rememberIpnsResolution } = await import('./resolution');
        rememberIpnsResolution(publicId, cidStr);
    } catch { /* ignore */ }
    return publicId;
}

/** Resolve tip from local CAS (no network). */
export async function heliaResolveIpnsOffline(ipnsName: string): Promise<string> {
    if (!ipnsName || status !== 'ready') return '';
    try {
        const key = ipnsName.startsWith('/ipns/') ? ipnsName.slice(6) : ipnsName;
        return (await casGetTip(key)) || '';
    } catch {
        return '';
    }
}

export async function heliaStatSize(cidStr: string): Promise<number | null> {
    if (status !== 'ready') return null;
    try {
        return await casBlockSize(cidStr);
    } catch {
        return null;
    }
}

export async function heliaCatBytes(
    cidStr: string,
    maxBytes?: number
): Promise<Uint8Array | null> {
    if (status !== 'ready') return null;
    try {
        const bytes = await casGetBlock(cidStr);
        if (!bytes) return null;
        if (maxBytes != null && bytes.byteLength > maxBytes) return null;
        return bytes;
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
    await startHelia();
    try {
        const cid = await hashBytesToCid(bytes);
        await casPutBlock(cid, bytes);
        if (pin) {
            try {
                await casPin(cid);
            } catch (e) {
                console.warn('[CAS] pin failed (content still added)', e);
            }
        }
        return cid;
    } catch (e) {
        if (isStorageQuotaError(e)) {
            throw new Error(
                'Browser storage is full (IndexedDB quota). Delete old posts/media or clear this site’s stored data, then try again.'
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
    await startHelia();
    if (!(await casHasBlock(cidStr))) {
        throw new Error(`Cannot pin missing block ${cidStr.slice(0, 12)}…`);
    }
    await casPin(cidStr);
}

export async function heliaUnpin(cidStr: string): Promise<void> {
    await startHelia();
    try {
        await casUnpin(cidStr);
    } catch { /* ignore */ }
}

export async function heliaHasBlock(cidStr: string): Promise<boolean> {
    try {
        if (status !== 'ready') await startHelia();
        return casHasBlock(cidStr);
    } catch {
        return false;
    }
}

export async function heliaListPins(): Promise<Set<string>> {
    await startHelia();
    return casListPins();
}

/** Delete a single flat block (no DAG). */
export async function heliaDeleteBlock(cidStr: string): Promise<void> {
    await startHelia();
    await casUnpin(cidStr);
    await casDeleteBlock(cidStr);
}
