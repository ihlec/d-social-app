import { getSession } from './session';
import { resolveIpns } from './resolution';
import { heliaPin, heliaUnpin, heliaHasBlock, startHelia, isHeliaAvailable } from './heliaNode';
import { fetchFromGateways } from './gatewayUtils';

export async function mirrorUser(ipnsKey: string, knownCid?: string): Promise<void> {
    const session = getSession();
    if (session.sessionType !== 'helia') return;
    try {
        let profileCid = knownCid || await resolveIpns(ipnsKey);
        if (!profileCid) return;
        await pinCid(profileCid);
    } catch { /* ignore */ }
}

export async function isPinned(cid: string): Promise<boolean> {
    if (!isHeliaAvailable()) return false;
    try {
        await startHelia();
        return heliaHasBlock(cid);
    } catch {
        return false;
    }
}

export async function pinCid(cid: string): Promise<void> {
    if (!cid || !isHeliaAvailable()) return;
    try {
        await startHelia();
        await heliaPin(cid);
    } catch { /* ignore */ }
}

export async function unpinCid(cid: string): Promise<void> {
    if (!cid || !isHeliaAvailable()) return;
    try {
        await startHelia();
        await heliaUnpin(cid);
    } catch { /* ignore */ }
}

/** Ensure a block is local (fetch via gateway if needed, then pin). */
export const ensureBlockLocal = async (cid: string, data?: any) => {
    if (!isHeliaAvailable()) return;
    try {
        await startHelia();
        if (await heliaHasBlock(cid)) {
            pinCid(cid).catch(() => {});
            return;
        }

        if (data) {
            const { heliaAddJson } = await import('./heliaNode');
            await heliaAddJson(data, true);
            return;
        }

        const res = await fetchFromGateways(
            `/ipfs/${cid}`,
            'ipfs',
            async (response) => response,
        );
        if (!res) throw new Error('Could not fetch block');
        const blob = await res.blob();
        const { heliaAddBlob } = await import('./heliaNode');
        await heliaAddBlob(blob, true);
    } catch (e) {
        pinCid(cid).catch(() => {});
    }
};
