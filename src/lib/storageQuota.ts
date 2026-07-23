/**
 * Browser origin storage budget (Helia IndexedDB + other site data).
 */

export type StorageEstimate = {
    usage: number;
    quota: number;
    usageRatio: number;
    remaining: number;
    persisted: boolean;
};

export async function getStorageEstimate(): Promise<StorageEstimate | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
        const est = await navigator.storage.estimate();
        const usage = est.usage ?? 0;
        const quota = est.quota ?? 0;
        let persisted = false;
        try {
            persisted = (await navigator.storage.persisted?.()) ?? false;
        } catch { /* ignore */ }
        return {
            usage,
            quota,
            usageRatio: quota > 0 ? usage / quota : 1,
            remaining: Math.max(0, quota - usage),
            persisted,
        };
    } catch {
        return null;
    }
}

/**
 * True if we can likely store `bytesNeeded`.
 * Margin is a small fixed buffer + ~15% for UnixFS DAG overhead — NOT a % of
 * total quota (that wrongly reserved hundreds of MB on Firefox's ~10 GiB cap).
 */
export async function hasStorageHeadroom(bytesNeeded: number): Promise<boolean> {
    const est = await getStorageEstimate();
    if (!est || est.quota <= 0) return true; // unknown — allow and let Helia throw
    const overhead = Math.max(2 * 1024 * 1024, Math.ceil(bytesNeeded * 0.15));
    return est.remaining > bytesNeeded + overhead;
}

/** Human-readable remaining/needed for error toasts. */
export async function describeStorageGap(bytesNeeded: number): Promise<string> {
    const est = await getStorageEstimate();
    if (!est) return '';
    const overhead = Math.max(2 * 1024 * 1024, Math.ceil(bytesNeeded * 0.15));
    const need = bytesNeeded + overhead;
    return ` (${formatBytes(est.remaining)} free, need ~${formatBytes(need)})`;
}

export async function requestPersistentStorage(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    try {
        return await navigator.storage.persist();
    } catch {
        return false;
    }
}

export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
