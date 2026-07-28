import { useState, useEffect, useMemo } from 'react';
import {
    getCachedHeliaMediaUrl,
    onHeliaMediaReady,
    resolveHeliaMediaUrl,
} from '../lib/heliaMediaUrl';

// Helper: Map extension to MIME type
export const getMimeType = (filename?: string): string => {
    if (!filename) return 'video/mp4';
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'ogg': 'video/ogg',
        'mov': 'video/quicktime',
        'mkv': 'video/x-matroska',
        'avi': 'video/x-msvideo',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'avif': 'image/avif',
        'pdf': 'application/pdf',
    };
    return mimeMap[ext || ''] || 'video/mp4';
};

// Global Cache to prevent flickering on remount
const raceCache = new Map<string, string>();

export type GatewayRaceOptions = {
    mimeHint?: string;
    /** When set, try Trystero media pull from this peer if local CAS misses. */
    peerIpnsKey?: string;
    /**
     * Post CID for content-room media rendezvous (holders join the post room,
     * not `dsocial-cid/<mediaCid>`).
     */
    rendezvousCid?: string;
    /** Allow larger on-demand CAS/P2P blobs (expanded video). */
    allowLarge?: boolean;
};

/**
 * Media URL resolution: local CAS blob, then Trystero P2P.
 * (Hook name kept for call-site compatibility after gateway removal.)
 */
export const useGatewayRace = (cid?: string, options?: GatewayRaceOptions) => {
    const mimeHint = options?.mimeHint;
    const peerIpnsKey = options?.peerIpnsKey;
    const rendezvousCid = options?.rendezvousCid;
    const allowLarge = options?.allowLarge === true;

    const [heliaUrl, setHeliaUrl] = useState<string | null>(() =>
        cid ? getCachedHeliaMediaUrl(cid) : null
    );

    const [bestUrl, setBestUrl] = useState<string | null>(() => {
        if (!cid) return null;
        const local = getCachedHeliaMediaUrl(cid);
        if (local) return local;
        const cached = raceCache.get(cid);
        return cached?.startsWith('blob:') ? cached : null;
    });

    const allUrls = useMemo(() => (heliaUrl ? [heliaUrl] : []), [heliaUrl]);

    useEffect(() => {
        if (!cid || cid.startsWith('http')) {
            setHeliaUrl(null);
            setBestUrl(null);
            return;
        }

        let cancelled = false;
        const apply = (url: string | null) => {
            if (cancelled || !url) return;
            setHeliaUrl((prev) => (prev === url ? prev : url));
            setBestUrl((prev) => (prev === url ? prev : url));
            raceCache.set(cid, url);
        };

        const resolveLocal = () =>
            resolveHeliaMediaUrl(cid, mimeHint, { allowLarge });

        const run = async () => {
            try {
                const cached = getCachedHeliaMediaUrl(cid);
                if (cached) {
                    apply(cached);
                    return;
                }
                const local = await resolveLocal();
                if (cancelled) return;
                if (local) {
                    apply(local);
                    return;
                }
                try {
                    const { requestPeerMedia, requestContentMedia } = await import('../api/pubsub');
                    let p2pUrl: string | null = null;
                    if (peerIpnsKey) {
                        p2pUrl = await requestPeerMedia(peerIpnsKey, cid, mimeHint);
                    }
                    if (!p2pUrl) {
                        p2pUrl = await requestContentMedia(cid, mimeHint, {
                            rendezvousCid: rendezvousCid || undefined,
                        });
                    }
                    if (!cancelled && p2pUrl) apply(p2pUrl);
                } catch (e) {
                    console.debug('[Media] P2P pull failed', cid.slice(0, 12), e);
                }
            } catch { /* ignore */ }
        };

        void run();

        const unsub = onHeliaMediaReady((readyCid) => {
            if (readyCid !== cid) return;
            const url = getCachedHeliaMediaUrl(cid);
            if (url) apply(url);
            else {
                resolveLocal().then((u) => {
                    if (!cancelled) apply(u);
                });
            }
        });

        return () => {
            cancelled = true;
            unsub();
        };
    }, [cid, mimeHint, peerIpnsKey, rendezvousCid, allowLarge]);

    useEffect(() => {
        if (!cid) {
            setBestUrl(null);
            return;
        }
        if (heliaUrl) setBestUrl(heliaUrl);
    }, [cid, heliaUrl]);

    return { bestUrl, allUrls };
};
