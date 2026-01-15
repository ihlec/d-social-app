import { Session } from '../types';
import { getCookie, setCookie, eraseCookie, loadSessionCookie } from '../lib/utils';
import { SESSION_COOKIE_PREFIX, CURRENT_USER_LABEL_KEY } from '../constants';

// --- IN-MEMORY SECRETS ---
// We do NOT store passwords in cookies/localStorage to prevent XSS leakage.
let sessionMemoryPassword: string | undefined;

export const setSessionMemoryPassword = (pwd: string | undefined) => {
    sessionMemoryPassword = pwd;
};

export function getDynamicSessionCookieName(label?: string | null): string | null {
    let userLabel = label || sessionStorage.getItem(CURRENT_USER_LABEL_KEY);
    if (!userLabel) {
        const optimistic = getCookie('dsocial_optimistic_login');
        if (optimistic) userLabel = optimistic;
    }
    if (!userLabel) return null;
    return `${SESSION_COOKIE_PREFIX}_${userLabel.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function getSession(): Session {
    const cookieName = getDynamicSessionCookieName();
    if (cookieName) {
        const sessionCookie = loadSessionCookie<Session>(cookieName);
        if (sessionCookie?.sessionType === 'kubo' && 
            sessionCookie.rpcApiUrl && 
            sessionCookie.rpcApiUrl !== 'undefined' && 
            sessionCookie.rpcApiUrl.startsWith('http')) {
            return { 
                ...sessionCookie, 
                kuboPassword: sessionMemoryPassword 
            };
        }
    }
    const optimisticKey = getCookie('dsocial_optimistic_login');
    if (optimisticKey) {
        return {
            sessionType: 'kubo', rpcApiUrl: 'http://127.0.0.1:5001',
            ipnsKeyName: optimisticKey, resolvedIpnsKey: undefined, kuboUsername: undefined, kuboPassword: undefined
        };
    }
    return { sessionType: null };
}

export function saveSessionCookie<T extends Partial<Session>>(name: string, value: T): void {
    const safeValue = { ...value };
    if ('kuboPassword' in safeValue) {
        delete safeValue.kuboPassword;
    }
    try { setCookie(name, JSON.stringify(safeValue), 7); } catch (e) { console.error("Failed save cookie:", e); }
}

export function logoutSession(): void {
    sessionMemoryPassword = undefined;
    const cookieName = getDynamicSessionCookieName();
    if (cookieName) eraseCookie(cookieName);
    sessionStorage.removeItem(CURRENT_USER_LABEL_KEY);
}
