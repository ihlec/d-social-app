import { Session } from '../types';
import { getCookie, setCookie, eraseCookie, loadSessionCookie } from '../lib/utils';
import { SESSION_COOKIE_PREFIX, CURRENT_USER_LABEL_KEY } from '../constants';

// In-memory keychain passphrase (never cookie-stored)
let sessionMemoryPassword: string | undefined;

export const setSessionMemoryPassword = (pwd: string | undefined) => {
    sessionMemoryPassword = pwd;
};

export const getSessionMemoryPassword = (): string | undefined => sessionMemoryPassword;

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
        if (sessionCookie?.sessionType === 'helia' && sessionCookie.ipnsKeyName) {
            return { ...sessionCookie };
        }
        // Migrate old kubo cookies → treat as logged out (keys were on Kubo node)
        if ((sessionCookie as any)?.sessionType === 'kubo') {
            return { sessionType: null };
        }
    }
    const optimisticKey = getCookie('dsocial_optimistic_login');
    if (optimisticKey) {
        return {
            sessionType: 'helia',
            ipnsKeyName: optimisticKey,
            resolvedIpnsKey: undefined,
            requiresPassword: false,
        };
    }
    return { sessionType: null };
}

export function saveSessionCookie<T extends Partial<Session>>(name: string, value: T): void {
    try { setCookie(name, JSON.stringify(value), 7); } catch (e) { console.error("Failed save cookie:", e); }
}

export function logoutSession(): void {
    sessionMemoryPassword = undefined;
    const cookieName = getDynamicSessionCookieName();
    if (cookieName) eraseCookie(cookieName);
    sessionStorage.removeItem(CURRENT_USER_LABEL_KEY);
}
