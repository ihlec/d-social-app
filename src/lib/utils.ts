// fileName: src/lib/utils.ts
import DOMPurify from 'dompurify';

/**
 * Sanitizes HTML content using DOMPurify with strict settings
 * Use this for user-generated content that may contain HTML
 */
export const sanitizeHtml = (dirty: string | null | undefined): string => {
    if (!dirty) return '';
    return DOMPurify.sanitize(dirty, {
        ALLOWED_TAGS: [], // No HTML tags allowed - strip everything
        ALLOWED_ATTR: [],
        KEEP_CONTENT: true, // Keep text content but strip tags
    });
};

/**
 * Sanitizes plain text content (for names, bios, etc.)
 * Strips all HTML and returns plain text
 */
export const sanitizeText = (text: string | null | undefined): string => {
    if (!text) return '';
    // First sanitize HTML, then decode any HTML entities
    const sanitized = DOMPurify.sanitize(text, {
        ALLOWED_TAGS: [],
        ALLOWED_ATTR: [],
        KEEP_CONTENT: true,
    });
    // Decode HTML entities (e.g., &amp; -> &)
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = sanitized;
    return tempDiv.textContent || tempDiv.innerText || '';
};

export const getCookie = (name: string): string | null => {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for(let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
};

export const setCookie = (name: string, value: string, days: number) => {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "")  + expires + "; path=/; SameSite=Strict";
};

export const eraseCookie = (name: string) => {
    document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
};

// --- Optimistic State Persistence Helpers ---
// Moved here to avoid circular dependency between ipfsIpns.ts and stateActions.ts
import { OptimisticStateCookie } from '../types';

const getOptimisticCookieName = (ipnsKey: string) => `dSocialOptimisticState_${ipnsKey}`;
const getLocalStorageCidKey = (ipnsKey: string) => `dsocial_latest_cid_${ipnsKey}`;

export const loadOptimisticCookie = (ipnsKey: string): OptimisticStateCookie | null => {
    const cookieName = getOptimisticCookieName(ipnsKey);
    const cookieValue = getCookie(cookieName);
    if (cookieValue) {
        try {
            return JSON.parse(cookieValue) as OptimisticStateCookie;
        } catch (e) {
            console.error("Failed to parse optimistic cookie:", e);
            return null;
        }
    }
    return null;
};

export const saveOptimisticCookie = (ipnsKey: string, data: OptimisticStateCookie): void => {
    const cookieName = getOptimisticCookieName(ipnsKey);
    try {
        setCookie(cookieName, JSON.stringify(data), 7);
        if (data.cid) {
            localStorage.setItem(getLocalStorageCidKey(ipnsKey), data.cid);
        }
    } catch (e) {
        console.error("Failed to save optimistic cookie:", e);
    }
};

export const getLatestLocalCid = (ipnsKey: string): string | null => {
    return localStorage.getItem(getLocalStorageCidKey(ipnsKey));
};

// Re-export loadSessionCookie for session.ts
export const loadSessionCookie = <T>(name: string): T | null => {
    const cookieValue = getCookie(name);
    if (cookieValue) {
        try {
            return JSON.parse(cookieValue) as T;
        } catch (e) {
            eraseCookie(name);
            return null;
        }
    }
    return null;
};

// FIX: Add the missing formatTimeAgo function
export const formatTimeAgo = (timestamp: number): string => {
    if (!timestamp) return '';
    
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    const intervals = [
        { label: 'y', seconds: 31536000 },
        { label: 'mo', seconds: 2592000 },
        { label: 'd', seconds: 86400 },
        { label: 'h', seconds: 3600 },
        { label: 'm', seconds: 60 },
        { label: 's', seconds: 1 }
    ];

    for (const interval of intervals) {
        const count = Math.floor(seconds / interval.seconds);
        if (count >= 1) {
            return `${count}${interval.label} ago`;
        }
    }
    return 'just now';
};

/**
 * Gets the base URL for sharing, preserving IPFS gateway CID if present
 * This ensures share URLs work correctly when the app is served from IPFS
 */
export const getShareBaseUrl = (): string => {
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    
    // Check if we're on an IPFS gateway (subdomain format: cid.ipfs.gateway.com)
    // Example: https://bafybe...ipfs.dweb.link
    const subdomainMatch = origin.match(/^https?:\/\/([a-z0-9]{50,})\.ipfs\.(.+)$/i);
    if (subdomainMatch) {
        // Preserve subdomain format: https://{cid}.ipfs.{gateway}
        return origin;
    }
    
    // Check if we're on an IPFS gateway (path format: gateway.com/ipfs/cid)
    // Example: https://ipfs.io/ipfs/bafybe... or https://gateway.pinata.cloud/ipfs/bafybe...
    const pathMatch = pathname.match(/^\/ipfs\/([a-z0-9]{50,})/i);
    if (pathMatch) {
        // Extract CID from path
        const cid = pathMatch[1];
        // Preserve path format: https://{gateway}/ipfs/{cid}
        return `${origin}/ipfs/${cid}`;
    }
    
    // Check if pathname starts with a CID (some gateways use direct CID paths)
    // Example: https://ipfs.io/bafybe.../
    const directCidMatch = pathname.match(/^\/([a-z0-9]{50,})/i);
    if (directCidMatch && (origin.includes('ipfs.io') || origin.includes('dweb.link') || origin.includes('gateway.pinata.cloud'))) {
        const cid = directCidMatch[1];
        // Try to determine if it's path or subdomain gateway
        if (origin.includes('ipfs.io') || origin.includes('gateway.pinata.cloud')) {
            return `${origin}/ipfs/${cid}`;
        }
    }
    
    // Not on IPFS gateway or CID not found, use origin as-is
    return origin;
};