
const BACKOFF_STORAGE_KEY = 'dsocial_fetch_backoff';
// Strategy: 10s -> 20s -> 40s -> ... Max 24h
const BASE_DELAY_MS = 10 * 1000; 
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

interface BackoffEntry {
    attempts: number;
    nextRetry: number; // Timestamp (Date.now())
}

interface BackoffState {
    [key: string]: BackoffEntry;
}

// In-memory set to track currently in-flight requests to prevent thundering herd
const pendingRequests = new Set<string>();

const loadState = (): BackoffState => {
    try {
        const raw = localStorage.getItem(BACKOFF_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
};

const saveState = (state: BackoffState) => {
    try {
        localStorage.setItem(BACKOFF_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        // Ignore storage errors
    }
};

/**
 * Returns TRUE if the key is currently in a cooldown period OR is currently being fetched.
 */
export const shouldSkipRequest = (key: string): boolean => {
    if (!key) return true;
    
    // 1. Check if already in flight (in-memory)
    if (pendingRequests.has(key)) {
        return true;
    }

    // 2. Check persistent backoff
    const state = loadState();
    const entry = state[key];
    
    if (!entry) return false; // No record, go ahead
    
    if (Date.now() < entry.nextRetry) {
        // Still waiting
        return true;
    }
    
    return false; // Timer expired, allow retry
};

/**
 * Marks a request as started. Call this before initiating the fetch.
 */
export const markRequestPending = (key: string) => {
    if (key) pendingRequests.add(key);
};

/**
 * Call this when a fetch fails (e.g., resolveIpns returns null).
 * Increases the wait time exponentially.
 */
export const reportFetchFailure = (key: string) => {
    if (!key) return;
    
    pendingRequests.delete(key); // Request finished (failed)

    const state = loadState();
    const entry = state[key] || { attempts: 0, nextRetry: 0 };
    
    // Only increment attempts if we passed the previous retry time
    // This prevents double-penalizing if multiple failures come in for the same window
    if (Date.now() >= entry.nextRetry) {
        entry.attempts += 1;
        
        // Exponential: Base * 2^(attempts-1)
        const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, entry.attempts - 1),
            MAX_DELAY_MS
        );
        
        entry.nextRetry = Date.now() + delay;
        state[key] = entry;
        
        saveState(state);
        console.warn(`[Backoff] ${key.substring(0,10)}... failed ${entry.attempts} times. Retry in ${Math.round(delay/1000)}s`);
    } else {
         // Already penalized, just ignore
    }
};

/**
 * Call this when a fetch succeeds.
 * Removes the key from the penalty box.
 */
export const reportFetchSuccess = (key: string) => {
    if (!key) return;
    pendingRequests.delete(key); // Request finished (success)

    const state = loadState();
    if (state[key]) {
        delete state[key];
        saveState(state);
    }
};
