/**
 * IndexedDB backend for the thin local CAS (fresh start — no Helia).
 * DB: dsocial_cas_v1
 *   blocks: cid → ArrayBuffer
 *   pins: cid → 1
 *   tips: publicId → stateCid
 *   identities: keyName → IdentityRecord
 */

const DB_NAME = 'dsocial_cas_v1';
const DB_VERSION = 1;

export type IdentityRecord = {
    keyName: string;
    publicId: string;
    /** PKCS8 as base64 (or AES-GCM wrapped when passphrase set). */
    privateKeyB64: string;
    publicKeyB64: string;
    encrypted: boolean;
    /** PBKDF2 salt when encrypted */
    saltB64?: string;
    ivB64?: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error || new Error('CAS IDB open failed'));
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks');
            if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins');
            if (!db.objectStoreNames.contains('tips')) db.createObjectStore('tips');
            if (!db.objectStoreNames.contains('identities')) db.createObjectStore('identities');
        };
        req.onsuccess = () => resolve(req.result);
    });
    return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('CAS IDB request failed'));
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('CAS IDB tx failed'));
        tx.onabort = () => reject(tx.error || new Error('CAS IDB tx aborted'));
    });
}

export async function casPutBlock(cid: string, bytes: Uint8Array): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('blocks', 'readwrite');
    // Copy into a clean ArrayBuffer — IDB rejects shared/detached buffers from some paths.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    tx.objectStore('blocks').put(copy.buffer, cid);
    await txDone(tx);
}

export async function casGetBlock(cid: string): Promise<Uint8Array | null> {
    const db = await openDb();
    const tx = db.transaction('blocks', 'readonly');
    const buf = await reqToPromise(tx.objectStore('blocks').get(cid));
    if (!buf) return null;
    return new Uint8Array(buf as ArrayBuffer);
}

export async function casHasBlock(cid: string): Promise<boolean> {
    const db = await openDb();
    const tx = db.transaction('blocks', 'readonly');
    const key = await reqToPromise(tx.objectStore('blocks').getKey(cid));
    return key !== undefined;
}

export async function casDeleteBlock(cid: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('blocks', 'readwrite');
    tx.objectStore('blocks').delete(cid);
    await txDone(tx);
}

export async function casPin(cid: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('pins', 'readwrite');
    tx.objectStore('pins').put(1, cid);
    await txDone(tx);
}

export async function casUnpin(cid: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('pins', 'readwrite');
    tx.objectStore('pins').delete(cid);
    await txDone(tx);
}

export async function casListPins(): Promise<Set<string>> {
    const db = await openDb();
    const tx = db.transaction('pins', 'readonly');
    const keys = await reqToPromise(tx.objectStore('pins').getAllKeys());
    return new Set(keys.map(String));
}

export async function casBlockSize(cid: string): Promise<number | null> {
    const bytes = await casGetBlock(cid);
    return bytes ? bytes.byteLength : null;
}

export async function casSetTip(publicId: string, stateCid: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('tips', 'readwrite');
    tx.objectStore('tips').put(stateCid, publicId);
    await txDone(tx);
}

export async function casGetTip(publicId: string): Promise<string> {
    const db = await openDb();
    const tx = db.transaction('tips', 'readonly');
    const tip = await reqToPromise(tx.objectStore('tips').get(publicId));
    return typeof tip === 'string' ? tip : '';
}

export async function casPutIdentity(rec: IdentityRecord): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('identities', 'readwrite');
    tx.objectStore('identities').put(rec, rec.keyName);
    await txDone(tx);
}

export async function casGetIdentity(keyName: string): Promise<IdentityRecord | null> {
    const db = await openDb();
    const tx = db.transaction('identities', 'readonly');
    const rec = await reqToPromise(tx.objectStore('identities').get(keyName));
    return (rec as IdentityRecord) || null;
}

export async function casListIdentityNames(): Promise<string[]> {
    const db = await openDb();
    const tx = db.transaction('identities', 'readonly');
    const keys = await reqToPromise(tx.objectStore('identities').getAllKeys());
    return keys.map(String).filter((n) => n && n !== 'self');
}

/** Delete all content blocks + pins; keep identities and tips. */
export async function casWipeBlocks(): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(['blocks', 'pins'], 'readwrite');
    tx.objectStore('blocks').clear();
    tx.objectStore('pins').clear();
    await txDone(tx);
}

/** List all block CIDs (for GC sweeps). */
export async function casListBlockCids(): Promise<string[]> {
    const db = await openDb();
    const tx = db.transaction('blocks', 'readonly');
    const keys = await reqToPromise(tx.objectStore('blocks').getAllKeys());
    return keys.map(String);
}

export function isCasAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
}
