import { Session } from '../types';
import { getCookie, setCookie, eraseCookie, loadSessionCookie } from '../lib/utils';
import {
    SESSION_COOKIE_PREFIX,
    CURRENT_USER_LABEL_KEY,
    ACTIVE_IDENTITY_STORAGE_KEY,
    SESSION_BACKUP_STORAGE_KEY,
} from '../constants';

// In-memory keychain passphrase (never cookie/localStorage-stored)
let sessionMemoryPassword: string | undefined;

export const setSessionMemoryPassword = (pwd: string | undefined) => {
    sessionMemoryPassword = pwd;
};

export const getSessionMemoryPassword = (): string | undefined => sessionMemoryPassword;

function readActiveIdentityLabel(): string | null {
    try {
        const fromLocal = localStorage.getItem(ACTIVE_IDENTITY_STORAGE_KEY);
        if (fromLocal) return fromLocal;
    } catch { /* ignore */ }
    try {
        const fromSession = sessionStorage.getItem(CURRENT_USER_LABEL_KEY);
        if (fromSession) return fromSession;
    } catch { /* ignore */ }
    return getCookie('dsocial_optimistic_login');
}

export function setActiveIdentityLabel(label: string): void {
    const trimmed = (label || '').trim();
    if (!trimmed) return;
    try {
        sessionStorage.setItem(CURRENT_USER_LABEL_KEY, trimmed);
    } catch { /* ignore */ }
    try {
        localStorage.setItem(ACTIVE_IDENTITY_STORAGE_KEY, trimmed);
    } catch { /* ignore */ }
}

function clearActiveIdentityLabel(): void {
    try {
        sessionStorage.removeItem(CURRENT_USER_LABEL_KEY);
    } catch { /* ignore */ }
    try {
        localStorage.removeItem(ACTIVE_IDENTITY_STORAGE_KEY);
    } catch { /* ignore */ }
}

function readSessionBackup(): Session | null {
    try {
        const raw = localStorage.getItem(SESSION_BACKUP_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Session;
        if (parsed?.sessionType === 'helia' && parsed.ipnsKeyName) return parsed;
    } catch { /* ignore */ }
    return null;
}

function writeSessionBackup(session: Session): void {
    try {
        if (session.sessionType === 'helia' && session.ipnsKeyName) {
            localStorage.setItem(SESSION_BACKUP_STORAGE_KEY, JSON.stringify(session));
        }
    } catch (e) {
        console.warn('[Session] localStorage backup failed', e);
    }
}

function clearSessionBackup(): void {
    try {
        localStorage.removeItem(SESSION_BACKUP_STORAGE_KEY);
    } catch { /* ignore */ }
}

export function getDynamicSessionCookieName(label?: string | null): string | null {
    let userLabel = label || readActiveIdentityLabel();
    if (!userLabel) return null;
    return `${SESSION_COOKIE_PREFIX}_${userLabel.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function asHeliaSession(data: unknown): Session | null {
    if (!data || typeof data !== 'object') return null;
    const s = data as Session;
    if (s.sessionType === 'helia' && s.ipnsKeyName) {
        return {
            sessionType: 'helia',
            ipnsKeyName: s.ipnsKeyName,
            resolvedIpnsKey: s.resolvedIpnsKey,
            requiresPassword: !!s.requiresPassword,
        };
    }
    // Migrate old kubo cookies → treat as logged out
    if ((s as { sessionType?: string }).sessionType === 'kubo') return null;
    return null;
}

export function getSession(): Session {
    const label = readActiveIdentityLabel();
    const cookieName = getDynamicSessionCookieName(label);
    if (cookieName) {
        const fromCookie = asHeliaSession(loadSessionCookie<Session>(cookieName));
        if (fromCookie) return fromCookie;
    }

    const fromBackup = readSessionBackup();
    if (fromBackup) {
        // Re-sync label pointers so cookie name resolution works next time
        setActiveIdentityLabel(fromBackup.ipnsKeyName!);
        return fromBackup;
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
    try {
        setCookie(name, JSON.stringify(value), 30);
    } catch (e) {
        console.error('Failed save cookie:', e);
    }
}

/** Persist Helia session across refresh and tab close (localStorage + cookie). */
export function persistSession(session: Session): void {
    if (session.sessionType !== 'helia' || !session.ipnsKeyName) return;
    setActiveIdentityLabel(session.ipnsKeyName);
    writeSessionBackup(session);
    const cookieName = getDynamicSessionCookieName(session.ipnsKeyName);
    if (cookieName) saveSessionCookie(cookieName, session);
}

export function logoutSession(): void {
    sessionMemoryPassword = undefined;
    const cookieName = getDynamicSessionCookieName();
    if (cookieName) eraseCookie(cookieName);
    clearActiveIdentityLabel();
    clearSessionBackup();
    eraseCookie('dsocial_optimistic_login');
}
