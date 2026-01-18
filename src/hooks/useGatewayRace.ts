import { useState, useEffect, useMemo } from 'react';
import { getAllGatewayUrls, reportGatewayError } from '../api/gatewayUtils';

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
        'avi': 'video/x-msvideo'
    };
    return mimeMap[ext || ''] || 'video/mp4';
};

// Global Cache to prevent flickering on remount
const raceCache = new Map<string, string>();

export const useGatewayRace = (cid?: string) => {
    const urls = useMemo(() => getAllGatewayUrls(cid), [cid]);
    
    // Check if we're on a public gateway (not localhost)
    const isOnPublicGateway = typeof window !== 'undefined' && 
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1' &&
        (window.location.origin.includes('ipfs') || 
         window.location.origin.includes('dweb') || 
         window.location.origin.includes('pinata') ||
         window.location.origin.includes('filebase') ||
         window.location.origin.includes('4everland'));
    
    // If on public gateway, there's only one URL - no need to race
    const [bestUrl, setBestUrl] = useState<string | null>(() => {
        if (isOnPublicGateway) {
            return urls[0] || null;
        }
        
        // On localhost: check cache
        if (cid && raceCache.has(cid)) {
            const cached = raceCache.get(cid)!;
            if (urls.includes(cached)) {
                return cached;
            }
            raceCache.delete(cid);
        }
        return urls[0] || null;
    });

    useEffect(() => {
        if (!cid) {
            setBestUrl(urls[0] || null);
            return;
        }
        
        // Re-check if we're on a public gateway (in case origin changed)
        const checkIsOnPublicGateway = typeof window !== 'undefined' && 
            window.location.hostname !== 'localhost' &&
            window.location.hostname !== '127.0.0.1' &&
            (window.location.origin.includes('ipfs') || 
             window.location.origin.includes('dweb') || 
             window.location.origin.includes('pinata') ||
             window.location.origin.includes('filebase') ||
             window.location.origin.includes('4everland'));
        
        // On public gateway: only one URL, no racing needed
        if (checkIsOnPublicGateway) {
            setBestUrl(urls[0] || null);
            if (cid && urls[0]) {
                raceCache.set(cid, urls[0]);
            }
            return;
        }
        
        // On localhost: use racing logic
        if (urls.length <= 1) {
            setBestUrl(urls[0] || null);
            return;
        }

        // Check cache for localhost
        if (raceCache.has(cid)) {
             const cached = raceCache.get(cid)!;
             if (urls.includes(cached)) {
                 setBestUrl(cached);
                 return;
             }
        }

        let isMounted = true;
        // Prioritize same-origin URLs in the race (slice top 3, but same-origin should be first)
        const urlsToRace = urls.slice(0, 3);
        const controllers = urlsToRace.map(() => new AbortController());

        const race = async () => {
            try {
                // Race requests - same-origin URL (if present) should be in urlsToRace[0]
                const winnerIndex = await Promise.any(
                    urlsToRace.map((url, i) => 
                        // Use GET with Range: bytes=0-0 to check availability/type without full download
                        fetch(url, { 
                            method: 'GET', 
                            headers: { 'Range': 'bytes=0-0' },
                            signal: controllers[i].signal, 
                            cache: 'no-store',
                            mode: 'cors' // Explicitly request CORS to fail fast if not supported
                        })
                            .then(res => {
                                // Explicitly handle 429 Too Many Requests
                                if (res.status === 429) {
                                    reportGatewayError(url);
                                    throw new Error('429 Too Many Requests');
                                }

                                if (res.ok || res.status === 206 || res.status === 304) {
                                    // Reject HTML responses (often error pages or directory listings from gateways)
                                    const type = res.headers.get('content-type');
                                    if (type && type.includes('text/html')) {
                                        throw new Error('Ignore HTML response');
                                    }
                                    
                                    // REJECT 304 if it comes from the local gateway (index 0) and we suspect it's broken/empty
                                    if (res.status === 304 && i === 0) {
                                         throw new Error('Reject 304 from Local Node');
                                    }

                                    return i;
                                }
                                
                                // Report other server errors to cooldown if persistent
                                if (res.status >= 500) {
                                    // Optional: reportGatewayError(url);
                                }
                                
                                throw new Error('Not 200/206/304');
                            })
                            .catch(err => {
                                // If the error is a CORS error, it might be due to 429 blocking OPTIONS or headers.
                                // We can't distinguish purely from JS "Failed to fetch", but if we see many, we could fallback.
                                // For now, we rely on the 429 status check above.
                                throw err;
                            })
                    )
                );

                if (isMounted) {
                    const winnerUrl = urlsToRace[winnerIndex];
                    setBestUrl(winnerUrl);
                    if (cid) raceCache.set(cid, winnerUrl);
                }
            } catch (e) {
                // All failed HEAD/GET checks? 
                // Fallback to the first URL in the list (which should be same-origin if on a gateway)
                if (isMounted && urlsToRace.length > 0) {
                    const fallback = urlsToRace[0]; // First URL should be same-origin
                    setBestUrl(fallback);
                    if (cid) raceCache.set(cid, fallback);
                }
            } finally {
                controllers.forEach(c => c.abort());
            }
        };

        race();

        return () => {
            isMounted = false;
            controllers.forEach(c => c.abort());
        };
    }, [cid, urls]);

    return { bestUrl, allUrls: urls };
};
