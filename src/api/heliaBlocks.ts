/**
 * Unpin + delete UnixFS DAGs from the local Helia blockstore (frees IndexedDB quota).
 */

import { CID } from 'multiformats/cid';
import * as dagPb from '@ipld/dag-pb';
import { getHelia, heliaUnpin, heliaListPins, startHelia, isHeliaAvailable } from './heliaNode';

async function collectBytes(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of source) {
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
}

async function readBlock(cid: CID): Promise<Uint8Array | null> {
    const helia = await getHelia();
    try {
        if (!(await helia.blockstore.has(cid))) return null;
        const raw = await helia.blockstore.get(cid);
        return raw instanceof Uint8Array
            ? raw
            : await collectBytes(raw as AsyncIterable<Uint8Array>);
    } catch {
        return null;
    }
}

async function deleteCidRecursive(cid: CID, seen: Set<string>): Promise<number> {
    const key = cid.toString();
    if (seen.has(key)) return 0;
    seen.add(key);

    const helia = await getHelia();
    let deleted = 0;

    try {
        const bytes = await readBlock(cid);
        if (!bytes) return 0;

        // Walk dag-pb parents to remove raw / child blocks
        if (cid.code === dagPb.code) {
            try {
                const node = dagPb.decode(bytes);
                for (const link of node.Links) {
                    deleted += await deleteCidRecursive(link.Hash, seen);
                }
            } catch { /* not dag-pb or corrupt — still delete this block */ }
        }

        await helia.blockstore.delete(cid);
        deleted += 1;
    } catch {
        /* ignore missing / locked */
    }
    return deleted;
}

/** Unpin (if pinned) and delete the CID DAG from IndexedDB. Returns blocks removed. */
export async function heliaDeleteDag(cidStr: string): Promise<number> {
    if (!cidStr || cidStr.startsWith('http') || !isHeliaAvailable()) return 0;
    try {
        await startHelia();
        await heliaUnpin(cidStr);
        return await deleteCidRecursive(CID.parse(cidStr), new Set());
    } catch (e) {
        console.warn('[Helia] deleteDag failed', cidStr.slice(0, 12), e);
        return 0;
    }
}

/**
 * Expand root CIDs to every local block reachable via dag-pb links.
 * Raw / dag-json / dag-cbor leaves are kept as single-block roots.
 */
export async function heliaCollectReachable(rootCids: Iterable<string>): Promise<Set<string>> {
    await startHelia();
    const keep = new Set<string>();
    const stack: string[] = [];
    for (const c of rootCids) {
        if (c && !c.startsWith('http') && !c.startsWith('temp-')) stack.push(c);
    }

    while (stack.length > 0) {
        const key = stack.pop()!;
        if (keep.has(key)) continue;
        keep.add(key);
        try {
            const cid = CID.parse(key);
            const bytes = await readBlock(cid);
            if (!bytes || cid.code !== dagPb.code) continue;
            try {
                const node = dagPb.decode(bytes);
                for (const link of node.Links) {
                    stack.push(link.Hash.toString());
                }
            } catch { /* ignore */ }
        } catch { /* invalid cid */ }
    }
    return keep;
}

/**
 * Delete every local block not reachable from `rootKeepCids`.
 * Also unpins roots that are not in the keep set.
 * Returns { rootsUnpinned, blocksDeleted }.
 */
export async function heliaSweepExcept(rootKeepCids: Iterable<string>): Promise<{
    rootsUnpinned: number;
    blocksDeleted: number;
}> {
    if (!isHeliaAvailable()) return { rootsUnpinned: 0, blocksDeleted: 0 };
    await startHelia();

    const rootKeep = new Set<string>();
    for (const c of rootKeepCids) {
        if (c && !c.startsWith('http') && !c.startsWith('temp-')) rootKeep.add(c);
    }

    let rootsUnpinned = 0;
    try {
        for (const pin of await heliaListPins()) {
            if (rootKeep.has(pin)) continue;
            await heliaUnpin(pin);
            rootsUnpinned += 1;
        }
    } catch { /* ignore */ }

    const keepBlocks = await heliaCollectReachable(rootKeep);
    const helia = await getHelia();
    let blocksDeleted = 0;

    try {
        for await (const { cid } of helia.blockstore.getAll()) {
            const key = cid.toString();
            if (keepBlocks.has(key)) continue;
            try {
                await helia.blockstore.delete(cid);
                blocksDeleted += 1;
            } catch { /* ignore */ }
        }
    } catch (e) {
        console.warn('[Helia] blockstore sweep failed', e);
    }

    if (blocksDeleted > 0 || rootsUnpinned > 0) {
        console.info(
            `[Helia] sweep: unpinned ${rootsUnpinned} root(s), deleted ${blocksDeleted} block(s)`
        );
    }
    return { rootsUnpinned, blocksDeleted };
}
