import { GATEWAY_FALLBACK_STORAGE_KEY } from '../constants';

/** Public gateway cold-path — off unless Settings opts in. */
export function isGatewayFallbackEnabled(): boolean {
    try {
        return localStorage.getItem(GATEWAY_FALLBACK_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

export function setGatewayFallbackEnabled(on: boolean): void {
    try {
        if (on) localStorage.setItem(GATEWAY_FALLBACK_STORAGE_KEY, '1');
        else localStorage.removeItem(GATEWAY_FALLBACK_STORAGE_KEY);
    } catch { /* ignore */ }
}
