/**
 * Unpin + delete flat CAS blocks (frees IndexedDB quota).
 * No UnixFS/DAG walk — each root is a single block.
 */

import {
    heliaUnpin,
    heliaListPins,
    heliaDeleteBlock,
    startHelia,
    isHeliaAvailable,
} from './heliaNode';
import { casListBlockCids, casDeleteBlock, casUnpin } from '../lib/cas/db';

/** Unpin (if pinned) and delete the block. Returns 1 if removed, else 0. */
export async function heliaDeleteDag(cidStr: string): Promise<number> {
    if (!cidStr || cidStr.startsWith('http') || !isHeliaAvailable()) return 0;
    try {
        await startHelia();
        await heliaUnpin(cidStr);
        await heliaDeleteBlock(cidStr);
        return 1;
    } catch (e) {
        console.warn('[CAS] deleteBlock failed', cidStr.slice(0, 12), e);
        return 0;
    }
}

/** Flat CAS: reachable set is just the root CIDs themselves. */
export async function heliaCollectReachable(rootCids: Iterable<string>): Promise<Set<string>> {
    await startHelia();
    const keep = new Set<string>();
    for (const c of rootCids) {
        if (c && !c.startsWith('http') && !c.startsWith('temp-')) keep.add(c);
    }
    return keep;
}

/**
 * Delete every local block not in `rootKeepCids`.
 * Also unpins roots that are not in the keep set.
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

    let blocksDeleted = 0;
    try {
        for (const key of await casListBlockCids()) {
            if (rootKeep.has(key)) continue;
            try {
                await casUnpin(key);
                await casDeleteBlock(key);
                blocksDeleted += 1;
            } catch { /* ignore */ }
        }
    } catch (e) {
        console.warn('[CAS] blockstore sweep failed', e);
    }

    if (blocksDeleted > 0 || rootsUnpinned > 0) {
        console.info(
            `[CAS] sweep: unpinned ${rootsUnpinned} root(s), deleted ${blocksDeleted} block(s)`
        );
    }
    return { rootsUnpinned, blocksDeleted };
}
