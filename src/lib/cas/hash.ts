/**
 * Content addressing without Helia/UnixFS: CIDv1 + raw codec + sha2-256.
 * IDs look like `bafkrei…` but are not UnixFS graphs — local CAS only.
 */

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';

export async function hashBytesToCid(bytes: Uint8Array): Promise<string> {
    const digest = await sha256.digest(bytes);
    return CID.createV1(raw.code, digest).toString();
}

export async function hashJsonToCid(data: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    return hashBytesToCid(bytes);
}
