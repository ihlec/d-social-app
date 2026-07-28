/**
 * Local Helia → blob: URL for media. Prefer this over public gateways so
 * same-browser and P2P-ingested CIDs render immediately.
 *
 * Large auto-loads are capped. On-demand / P2P view may use a larger ephemeral
 * blob (one at a time) so video can play without filling IndexedDB.
 */

import {
    heliaAddBytes,
    heliaCatBytes,
    heliaHasBlock,
    heliaStatSize,
    startHelia,
    isHeliaAvailable,
    isStorageQuotaError,
} from '../api/heliaNode';
import { casPin, casPutBlock } from './cas/db';
import { MAX_P2P_MEDIA_BYTES } from '../constants';

/** Soft cap for automatic blob: URLs (thumbs / small images). */
export const MAX_HELIA_BLOB_BYTES = 8 * 1024 * 1024;
/** Cap for a single on-demand / P2P view blob (revokes previous large blob). */
export const MAX_EPHEMERAL_BLOB_BYTES = MAX_P2P_MEDIA_BYTES;

const urlCache = new Map<string, string>();
const readyListeners = new Set<(cid: string) => void>();
/** CIDs we already know are too large for automatic blob URLs. */
const skipAutoBlob = new Set<string>();
let lastEphemeralLargeCid: string | null = null;

export function onHeliaMediaReady(cb: (cid: string) => void): () => void {
    readyListeners.add(cb);
    return () => {
        readyListeners.delete(cb);
    };
}

export function notifyHeliaMediaReady(cid: string): void {
    if (!cid) return;
    for (const cb of readyListeners) {
        try {
            cb(cid);
        } catch {
            /* ignore */
        }
    }
}

function toBlobPart(bytes: Uint8Array): BlobPart {
    return bytes as unknown as BlobPart;
}

function sniffMime(bytes: Uint8Array): string | null {
    // %PDF
    if (
        bytes.length >= 4
        && bytes[0] === 0x25
        && bytes[1] === 0x50
        && bytes[2] === 0x44
        && bytes[3] === 0x46
    ) {
        return 'application/pdf';
    }
    if (bytes.length < 12) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        return 'image/gif';
    }
    if (
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        return 'video/mp4';
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
        return 'video/webm';
    }
    return null;
}

export function getCachedHeliaMediaUrl(cid?: string): string | null {
    if (!cid) return null;
    return urlCache.get(cid) || null;
}

function revokeCached(cid: string): void {
    const url = urlCache.get(cid);
    if (!url) return;
    try {
        URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    urlCache.delete(cid);
}

/**
 * Cache bytes as a blob: URL without requiring Helia pin (quota-safe view path).
 * Large blobs replace the previous large ephemeral entry.
 */
export function cacheMediaBytesAsBlob(
    cid: string,
    bytes: Uint8Array,
    mimeHint?: string
): string | null {
    if (!cid || !bytes?.length) return null;
    if (bytes.length > MAX_EPHEMERAL_BLOB_BYTES) {
        console.debug(
            `[HeliaMedia] refuse ephemeral blob ${cid.slice(0, 12)}… (${bytes.length} > ${MAX_EPHEMERAL_BLOB_BYTES})`
        );
        return null;
    }

    const existing = urlCache.get(cid);
    if (existing) {
        notifyHeliaMediaReady(cid);
        return existing;
    }

    if (bytes.length > MAX_HELIA_BLOB_BYTES) {
        if (lastEphemeralLargeCid && lastEphemeralLargeCid !== cid) {
            revokeCached(lastEphemeralLargeCid);
        }
        lastEphemeralLargeCid = cid;
    }

    // Prefer magic-byte sniff so a wrong extension/hint (e.g. PDF as video/mp4)
    // cannot poison the blob: URL Content-Type used by <iframe>/<img>/<video>.
    const mime = sniffMime(bytes) || mimeHint || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([toBlobPart(bytes)], { type: mime }));
    urlCache.set(cid, url);
    notifyHeliaMediaReady(cid);
    return url;
}

/** Build or return a cached blob: URL from local Helia blocks (auto size-capped). */
export async function resolveHeliaMediaUrl(
    cid?: string,
    mimeHint?: string,
    options?: { allowLarge?: boolean }
): Promise<string | null> {
    if (!cid || cid.startsWith('http')) return null;
    const cached = urlCache.get(cid);
    if (cached) return cached;

    const maxBytes = options?.allowLarge ? MAX_EPHEMERAL_BLOB_BYTES : MAX_HELIA_BLOB_BYTES;
    if (!options?.allowLarge && skipAutoBlob.has(cid)) return null;

    if (!isHeliaAvailable()) return null;
    try {
        await startHelia();
        if (!(await heliaHasBlock(cid))) return null;

        const size = await heliaStatSize(cid);
        if (size != null && size > maxBytes) {
            if (!options?.allowLarge) skipAutoBlob.add(cid);
            console.debug(
                `[HeliaMedia] skip blob for ${cid.slice(0, 12)}… (${size} bytes > ${maxBytes})`
            );
            return null;
        }

        const bytes = await heliaCatBytes(cid, maxBytes);
        if (!bytes || bytes.length === 0) return null;

        return cacheMediaBytesAsBlob(cid, bytes, mimeHint);
    } catch {
        return null;
    }
}

/**
 * Pin bytes into Helia when possible; always try to expose a blob: URL.
 * Quota failures still yield an ephemeral blob so P2P view works.
 */
export async function ingestMediaBytes(
    expectedCid: string,
    bytes: Uint8Array,
    mimeHint?: string
): Promise<string | null> {
    if (!expectedCid || !bytes?.length) return null;

    const existing = urlCache.get(expectedCid);
    if (existing) {
        notifyHeliaMediaReady(expectedCid);
        return existing;
    }

    if (isHeliaAvailable()) {
        try {
            await startHelia();
            // Store under peer-agreed CID (verify hash when it matches).
            const computed = await heliaAddBytes(bytes, true);
            if (computed !== expectedCid) {
                // Peer sent a different CID scheme — keep lookup key they expect.
                await casPutBlock(expectedCid, bytes);
                try { await casPin(expectedCid); } catch { /* ignore */ }
                console.warn(
                    `[CAS] ingest CID mismatch: expected ${expectedCid.slice(0, 12)}… got ${computed.slice(0, 12)}…`
                );
            }
        } catch (e) {
            if (isStorageQuotaError(e)) {
                console.warn(
                    '[HeliaMedia] IndexedDB quota full — serving ephemeral blob without pin'
                );
            } else {
                console.warn('[HeliaMedia] pin/add failed — serving ephemeral blob', e);
            }
        }
    }

    return cacheMediaBytesAsBlob(expectedCid, bytes, mimeHint);
}
