/**
 * Content upload — Helia only.
 */

import { heliaAddBlob, heliaAddJson, isHeliaAvailable, startHelia } from './heliaNode';

export async function ensureContentNode(): Promise<'helia' | 'none'> {
    if (!isHeliaAvailable()) return 'none';
    try {
        await startHelia();
        return 'helia';
    } catch {
        return 'none';
    }
}

export async function uploadJson(data: unknown): Promise<string> {
    if (!isHeliaAvailable()) throw new Error('IndexedDB / Helia unavailable in this browser.');
    const cid = await heliaAddJson(data, true);
    console.log(`[ContentUpload] JSON via Helia: ${cid}`);
    return cid;
}

export async function uploadFile(
    file: File | Blob,
    options?: { userLabel?: string; uniqueFileName?: string }
): Promise<{ cid: string; uniqueFileName: string }> {
    if (!isHeliaAvailable()) throw new Error('IndexedDB / Helia unavailable in this browser.');

    const originalFileName = (file instanceof File) ? file.name : 'blob';
    const extension = originalFileName.includes('.') ? originalFileName.substring(originalFileName.lastIndexOf('.')) : '';
    const baseName = originalFileName.includes('.') ? originalFileName.substring(0, originalFileName.lastIndexOf('.')) : originalFileName;
    const uniqueFileName = options?.uniqueFileName || `${baseName}-${Date.now()}${extension}`;

    const cid = await heliaAddBlob(file, true);
    console.log(`[ContentUpload] File via Helia: ${cid}`);
    return { cid, uniqueFileName };
}
