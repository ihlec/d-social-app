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
    
    // Initialize with cached winner if available, otherwise default to first candidate
    const [bestUrl, setBestUrl] = useState<string | null>(() => {
        if (cid && raceCache.has(cid)) return raceCache.get(cid)!;
        return urls[0] || null;
    });

    useEffect(() => {
        if (!cid || urls.length <= 1) {
            setBestUrl(urls[0] || null);
            return;
        }

        // If we already have a cached winner that is in the current list, trust it.
        // But we might want to re-verify if it fails? 
        // For now, trust the cache to avoid flicker. 
        // A background re-verification could be added but might cause the flicker we want to avoid.
        if (raceCache.has(cid)) {
             const cached = raceCache.get(cid)!;
             // Ensure the cached URL is still valid for this session (e.g. matches current gateway list)
             if (urls.includes(cached)) {
                 setBestUrl(cached);
                 return; 
             }
        }

        let isMounted = true;
        const controllers = urls.slice(0, 3).map(() => new AbortController()); // Race top 3 candidates

        const race = async () => {
            try {
                // Race requests
                const winnerIndex = await Promise.any(
                    urls.slice(0, 3).map((url, i) => 
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
                    setBestUrl(urls[winnerIndex]);
                    if (cid) raceCache.set(cid, urls[winnerIndex]);
                }
            } catch (e) {
                // All failed HEAD/GET checks? 
                // If we defaulted to Local (index 0), and it failed the check,
                // we should NOT stay on it. Fallback to the first public gateway (index 1) blindly.
                if (isMounted && urls.length > 1) {
                    const fallback = urls[1];
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
