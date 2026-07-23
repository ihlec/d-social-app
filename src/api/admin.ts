import { getSession } from './session';
import { resolveIpns } from './resolution';
import { heliaPin, startHelia, isHeliaAvailable } from './heliaNode';

export async function mirrorUser(ipnsKey: string, knownCid?: string): Promise<void> {
    const session = getSession();
    if (session.sessionType !== 'helia') return;
    try {
        let profileCid = knownCid || await resolveIpns(ipnsKey);
        if (!profileCid) return;
        await pinCid(profileCid);
    } catch { /* ignore */ }
}

export async function pinCid(cid: string): Promise<void> {
    if (!cid || !isHeliaAvailable()) return;
    try {
        await startHelia();
        await heliaPin(cid);
    } catch { /* ignore */ }
}
