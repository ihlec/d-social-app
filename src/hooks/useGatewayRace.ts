import { useState, useEffect, useMemo } from 'react';
import { getAllGatewayUrls, reportGatewayError } from '../api/gatewayUtils';
import {
    getCachedHeliaMediaUrl,
    onHeliaMediaReady,
    resolveHeliaMediaUrl,
} from '../lib/heliaMediaUrl';
import { isGatewayFallbackEnabled } from '../lib/gatewayFallback';

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
    };
    return mimeMap[ext || ''] || 'video/mp4';
};

// Global Cache to prevent flickering on remount
const raceCache = new Map<string, string>();

export type GatewayRaceOptions = {
    mimeHint?: string;
    /** When set, try Trystero media pull from this peer if local Helia misses. */
    peerIpnsKey?: string;
    /**
     * Post CID for content-room media rendezvous (holders join the post room,
     * not `dsocial-cid/<mediaCid>`).
     */
    rendezvousCid?: string;
    /** Allow larger on-demand Helia/P2P blobs (expanded video). */
    allowLarge?: boolean;
    /**
     * Race public gateways after Helia/P2P miss.
     * Default: only when Settings opts in (`gateway_fallback=1`).
     */
    allowGatewayFallback?: boolean;
};

function isPublicGatewayHost(): boolean {
    if (typeof window === 'undefined') return false;
    const { hostname, origin } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return false;
    return (
        origin.includes('ipfs') ||
        origin.includes('dweb') ||
        origin.includes('pinata') ||
        origin.includes('filebase') ||
        origin.includes('4everland')
    );
}

/**
 * Media URL resolution order (aligned with product architecture):
 * 1. Local Helia blob
 * 2. Trystero P2P (author room, then content room)
 * 3. Public gateways — Settings opt-in only
 */
export const useGatewayRace = (cid?: string, options?: GatewayRaceOptions) => {
    const mimeHint = options?.mimeHint;
    const peerIpnsKey = options?.peerIpnsKey;
    const rendezvousCid = options?.rendezvousCid;
    const allowLarge = options?.allowLarge === true;
    const allowGatewayFallback =
        options?.allowGatewayFallback ?? isGatewayFallbackEnabled();
    const gatewayUrls = useMemo(
        () => (allowGatewayFallback || isPublicGatewayHost() ? getAllGatewayUrls(cid) : []),
        [cid, allowGatewayFallback]
    );
    const onPublicGateway = isPublicGatewayHost();

    const [heliaUrl, setHeliaUrl] = useState<string | null>(() =>
        cid ? getCachedHeliaMediaUrl(cid) : null
    );
    /** Local Helia (+ optional P2P) finished attempting before public gateways. */
    const [localChecked, setLocalChecked] = useState(() =>
        Boolean(cid && getCachedHeliaMediaUrl(cid))
    );

    const [bestUrl, setBestUrl] = useState<string | null>(() => {
        if (cid) {
            const local = getCachedHeliaMediaUrl(cid);
            if (local) return local;
            const cached = raceCache.get(cid);
            if (cached && (cached.startsWith('blob:') || gatewayUrls.includes(cached))) {
                return cached;
            }
        }
        // Don't flash failing public gateways while Helia/P2P are still trying
        if (onPublicGateway) return gatewayUrls[0] || null;
        return null;
    });

    const allUrls = useMemo(() => {
        if (heliaUrl) {
            return [heliaUrl, ...gatewayUrls.filter((u) => u !== heliaUrl)];
        }
        return gatewayUrls;
    }, [heliaUrl, gatewayUrls]);

    // 1–2) Local Helia, then optional peer pull
    useEffect(() => {
        if (!cid || cid.startsWith('http')) {
            setHeliaUrl(null);
            setLocalChecked(true);
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
            } finally {
                if (!cancelled) setLocalChecked(true);
            }
        };

        setLocalChecked(Boolean(getCachedHeliaMediaUrl(cid)));
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

    // 3) Public gateways — only after local + P2P miss, and only when allowed
    useEffect(() => {
        if (!cid) {
            setBestUrl(null);
            return;
        }

        if (heliaUrl) {
            setBestUrl(heliaUrl);
            return;
        }

        // Wait for Helia / peer path before hitting public gateways
        if (!localChecked) return;

        // Browser-peer media is almost never on public gateways — skip the 504 spam.
        if (!allowGatewayFallback && !onPublicGateway) {
            return;
        }

        if (onPublicGateway) {
            setBestUrl(gatewayUrls[0] || null);
            if (cid && gatewayUrls[0]) raceCache.set(cid, gatewayUrls[0]);
            return;
        }

        if (gatewayUrls.length === 0) {
            setBestUrl(null);
            return;
        }

        if (raceCache.has(cid)) {
            const cached = raceCache.get(cid)!;
            // Only reuse successful blob or previously winning gateway URLs
            if (cached.startsWith('blob:') || gatewayUrls.includes(cached)) {
                setBestUrl(cached);
                return;
            }
        }

        let isMounted = true;
        const urlsToRace = gatewayUrls.slice(0, 3);
        const controllers = urlsToRace.map(() => new AbortController());

        const race = async () => {
            try {
                const winnerIndex = await Promise.any(
                    urlsToRace.map((url, i) =>
                        fetch(url, {
                            method: 'GET',
                            headers: { Range: 'bytes=0-0' },
                            signal: controllers[i].signal,
                            cache: 'no-store',
                            mode: 'cors',
                        }).then((res) => {
                            if (res.status === 429) {
                                reportGatewayError(url);
                                throw new Error('429 Too Many Requests');
                            }
                            if (res.ok || res.status === 206 || res.status === 304) {
                                const type = res.headers.get('content-type');
                                if (type && type.includes('text/html')) {
                                    throw new Error('Ignore HTML response');
                                }
                                if (res.status === 304 && i === 0) {
                                    throw new Error('Reject 304 from Local Node');
                                }
                                return i;
                            }
                            throw new Error('Not 200/206/304');
                        })
                    )
                );

                if (isMounted) {
                    const local = getCachedHeliaMediaUrl(cid);
                    if (local) {
                        setBestUrl(local);
                        raceCache.set(cid, local);
                        return;
                    }
                    const winnerUrl = urlsToRace[winnerIndex];
                    setBestUrl(winnerUrl);
                    raceCache.set(cid, winnerUrl);
                }
            } catch {
                if (isMounted) {
                    const local = getCachedHeliaMediaUrl(cid);
                    if (local) {
                        setBestUrl(local);
                        raceCache.set(cid, local);
                    }
                    // Do not point <img>/<video> at a gateway that just 504'd
                }
            } finally {
                controllers.forEach((c) => c.abort());
            }
        };

        void race();

        return () => {
            isMounted = false;
            controllers.forEach((c) => c.abort());
        };
    }, [cid, gatewayUrls, heliaUrl, localChecked, onPublicGateway, allowGatewayFallback]);

    return { bestUrl, allUrls };
};
