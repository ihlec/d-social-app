import { getSession } from './session';
import { fetchKubo, seedBlock } from './kuboClient';
import { resolveIpns } from './resolution';
import { fetchFromGateways } from './gatewayUtils';

export async function mirrorUser(ipnsKey: string, knownCid?: string): Promise<void> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) return;
    try {
        let profileCid = knownCid || await resolveIpns(ipnsKey);
        if(!profileCid) return;
        await pinCid(profileCid);
    } catch (e) { /* ignore  */ }
}

export async function isPinned(cid: string): Promise<boolean> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) return false;
    try { await fetchKubo(session.rpcApiUrl, '/api/v0/pin/ls', { arg: cid, type: 'recursive' }, undefined, { username: session.kuboUsername, password: session.kuboPassword }, 5000); return true; } catch { return false; }
}

export async function pinCid(cid: string): Promise<void> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) return;
    try { await fetchKubo(session.rpcApiUrl, '/api/v0/pin/add', { arg: cid }, undefined, { username: session.kuboUsername, password: session.kuboPassword }, 600000); } catch {}
}

export async function unpinCid(cid: string): Promise<void> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) return;
    try { await fetchKubo(session.rpcApiUrl, '/api/v0/pin/rm', { arg: cid }, undefined, { username: session.kuboUsername, password: session.kuboPassword }, 60000); } catch {}
}

export const ensureBlockLocal = async (cid: string, data?: any) => {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) return;

    try {
        try {
            await fetchKubo(session.rpcApiUrl, '/api/v0/block/stat', { arg: cid }, undefined, { username: session.kuboUsername, password: session.kuboPassword }, 1000);
            pinCid(cid).catch(() => {});
            return;
        } catch {}

        let blob: Blob;
        if (data) {
            blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        } else {
            const res = await fetchFromGateways(
                `/ipfs/${cid}`,
                'ipfs',
                async (response) => response, // Return Response object as-is
            );
            
            if (!res) {
                throw new Error("Could not fetch block");
            }
            
            blob = await res.blob();
        }

        if (blob!) {
            const seededCid = await seedBlock(
                session.rpcApiUrl, 
                blob!, 
                { username: session.kuboUsername, password: session.kuboPassword }
            );
            if (seededCid !== cid) await pinCid(cid);
        }

    } catch (e) {
        pinCid(cid).catch(() => {});
    }
};
