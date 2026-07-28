/**
 * Local identity: ECDSA P-256 keypair in IDB.
 * publicId = CIDv1(raw, sha256(SPKI)) — stable peer id (replaces Helia IPNS k51).
 */

import {
    casGetIdentity,
    casListIdentityNames,
    casPutIdentity,
    type IdentityRecord,
} from './db';
import { hashBytesToCid } from './hash';

function b64Encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return btoa(s);
}

function b64Decode(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt as BufferSource, iterations: 120_000, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function wrapPrivateKey(pkcs8: ArrayBuffer, passphrase: string): Promise<{
    privateKeyB64: string;
    saltB64: string;
    ivB64: string;
}> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aes = await deriveAesKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, pkcs8);
    return {
        privateKeyB64: b64Encode(ct),
        saltB64: b64Encode(salt),
        ivB64: b64Encode(iv),
    };
}

async function unwrapPrivateKey(
    rec: IdentityRecord,
    passphrase: string
): Promise<ArrayBuffer> {
    if (!rec.encrypted || !rec.saltB64 || !rec.ivB64) {
        const raw = b64Decode(rec.privateKeyB64);
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    }
    const salt = b64Decode(rec.saltB64);
    const iv = b64Decode(rec.ivB64);
    const aes = await deriveAesKey(passphrase, salt);
    return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        aes,
        b64Decode(rec.privateKeyB64) as BufferSource
    );
}

export async function ensureLocalIdentity(
    keyName: string,
    passphrase?: string
): Promise<{ keyName: string; publicId: string }> {
    const trimmed = keyName.trim();
    if (!trimmed) throw new Error('Identity name is required');

    let rec = await casGetIdentity(trimmed);
    if (!rec) {
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify']
        );
        const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
        const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
        const publicId = await hashBytesToCid(new Uint8Array(spki));
        const publicKeyB64 = b64Encode(spki);

        if (passphrase && passphrase.length > 0) {
            const wrapped = await wrapPrivateKey(pkcs8, passphrase);
            rec = {
                keyName: trimmed,
                publicId,
                publicKeyB64,
                privateKeyB64: wrapped.privateKeyB64,
                encrypted: true,
                saltB64: wrapped.saltB64,
                ivB64: wrapped.ivB64,
            };
        } else {
            rec = {
                keyName: trimmed,
                publicId,
                publicKeyB64,
                privateKeyB64: b64Encode(pkcs8),
                encrypted: false,
            };
        }
        await casPutIdentity(rec);
    } else if (rec.encrypted) {
        if (!passphrase) throw new Error('Passphrase required for this identity');
        await unwrapPrivateKey(rec, passphrase);
    }

    return { keyName: trimmed, publicId: rec.publicId };
}

export async function listLocalIdentityNames(): Promise<string[]> {
    return casListIdentityNames();
}

export async function getPublicIdForKeyName(keyName: string): Promise<string | null> {
    const rec = await casGetIdentity(keyName.trim());
    return rec?.publicId || null;
}

/** True only if this browser already has a CAS identity for the label (never creates). */
export async function hasLocalIdentity(keyName: string): Promise<boolean> {
    const trimmed = keyName.trim();
    if (!trimmed) return false;
    return !!(await casGetIdentity(trimmed));
}
