// src/hooks/libHelpers.ts
import { getCookie, setCookie } from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
    uploadJsonToIpfs,
    publishToIpns,
    updateIpnsRecord
} from '../api/ipfsIpns';
import { uploadJsonToFilebase, uploadFileToFilebase } from '../api/filebase';
import { createThumbnail } from '../lib/media';
import { UserProfile, UserState, OptimisticStateCookie, NewPostData, Post } from '../types';

// --- Cookie Helpers ---
// ... (loadOptimisticCookie, saveOptimisticCookie remain the same)
const getOptimisticCookieName = (ipnsKey: string) => `dSocialOptimisticState_${ipnsKey}`;

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
        setCookie(cookieName, JSON.stringify(data), 7); // Save for 7 days
    } catch (e) {
        console.error("Failed to save optimistic cookie:", e);
    }
};

// --- Data Fetching Helpers ---
// ... (fetchUserProfile remains the same)
export async function fetchUserProfile(ipnsKey: string): Promise<UserProfile> { // ...
    try {
        const profileCid = await resolveIpns(ipnsKey);
        const authorState = await fetchUserState(profileCid);
        if (authorState?.profile) {
            return authorState.profile;
        }
        return { name: 'Unknown User' };
    } catch (error) {
        console.warn(`Failed to fetch profile for author ${ipnsKey}`, error);
        return { name: 'Unknown User' };
    }
}

// --- FIX: This function now returns the resolved CID as well ---
export async function fetchUserStateByIpns(ipnsKey: string): Promise<{ state: UserState, cid: string }> {
    const cid = await resolveIpns(ipnsKey);
    const state = await fetchUserState(cid);
    return { state, cid };
}
// --- End Fix ---

export async function fetchUserStateChunkByIpns(ipnsKey: string): Promise<Partial<UserState>> { // ...
    const cid = await resolveIpns(ipnsKey);
    return await fetchUserStateChunk(cid);
}

// --- Kubo-specific Upload Helper ---
// ... (uploadFileToKubo remains the same)
async function uploadFileToKubo(apiUrl: string, file: File | Blob): Promise<string> { // ...
    const fd = new FormData();
    fd.append('file', file);
    const url = new URL(`${apiUrl}/api/v0/add`);
    url.searchParams.append('pin', 'true');
    url.searchParams.append('cid-version', '1');
    try {
        const response = await fetch(url.toString(), { method: "POST", body: fd });
        if (!response.ok) throw new Error(`Kubo RPC error /api/v0/add: ${response.statusText}`);
        const txt = await response.text();
        const lines = txt.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            try { const p = JSON.parse(lines[i]); if (p?.Hash) return p.Hash; } catch { /* ignore */ }
        }
        throw new Error("Bad 'add' response from Kubo.");
    } catch (e) { console.error(`Kubo file upload failed:`, e); throw e; }
}

// --- Complex Action Helpers ---
// ... (uploadPost remains the same)
export async function uploadPost(postData: NewPostData, myIpnsKey: string) { // ...
    const { content, referenceCID, file } = postData;
    const session = getSession();
    if (!session.sessionType) throw new Error("No active session.");
    let mediaCid: string | undefined, thumbnailCid: string | undefined;
    let mediaType: 'image' | 'video' | 'file' | undefined, fileName: string | undefined;
    if (file) {
        if (file.type.startsWith("image/")) mediaType = 'image';
        else if (file.type.startsWith("video/")) mediaType = 'video';
        else { mediaType = 'file'; fileName = file.name; }
        const thumbnailFile = await createThumbnail(file);
        if (session.sessionType === 'filebase' && session.s3Client && session.bucketName) {
            mediaCid = await uploadFileToFilebase(session.s3Client, session.bucketName, file);
            if (thumbnailFile) thumbnailCid = await uploadFileToFilebase(session.s3Client, session.bucketName, thumbnailFile);
        } else if (session.sessionType === 'kubo' && session.rpcApiUrl) {
            mediaCid = await uploadFileToKubo(session.rpcApiUrl, file);
            if (thumbnailFile) thumbnailCid = await uploadFileToKubo(session.rpcApiUrl, thumbnailFile);
        } else throw new Error("Session is misconfigured for file upload.");
    }
    const finalPost: Omit<Post, 'id' | 'replies'> = {
        timestamp: Date.now(), content, authorKey: myIpnsKey, referenceCID, mediaCid, thumbnailCid, mediaType, fileName,
    };
    let finalPostCID: string;
    if (session.sessionType === 'filebase' && session.s3Client && session.bucketName) {
        finalPostCID = await uploadJsonToFilebase(session.s3Client, session.bucketName, finalPost);
    } else if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        finalPostCID = await uploadJsonToIpfs(session.rpcApiUrl, finalPost);
    } else throw new Error("Session is misconfigured for JSON upload.");
    return { finalPost, finalPostCID };
}

// --- FIX: Renamed function, handles upload & IPNS publish only ---
/**
 * Uploads a given state object and publishes its CID to IPNS. Updates cookie.
 * Does NOT handle chunking logic.
 * @param stateToPublish The UserState object to upload.
 * @param myIpnsKey The user's IPNS key for cookie saving.
 * @returns The CID of the uploaded state.
 */
export async function _uploadStateAndPublishToIpns(stateToPublish: UserState | Partial<UserState>, myIpnsKey: string): Promise<string> {
    const session = getSession();
    if (!session.sessionType) throw new Error("No active session.");

    // --- FIX: Use sessionStorage ---
    // Determine profile name for cookie
    const profileName = ('profile' in stateToPublish && stateToPublish.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    // --- End Fix ---
    const timestamp = ('updatedAt' in stateToPublish && stateToPublish.updatedAt) || Date.now(); // Get timestamp

    let headCID: string;

    // Upload the state object
    if (session.sessionType === 'filebase' && session.s3Client && session.bucketName && session.ipnsNameLabel) {
        headCID = await uploadJsonToFilebase(session.s3Client, session.bucketName, stateToPublish);
        // Publish the resulting CID to IPNS
        await updateIpnsRecord(session.ipnsNameLabel, headCID);
    } else if (session.sessionType === 'kubo' && session.rpcApiUrl && session.ipnsKeyName) {
        headCID = await uploadJsonToIpfs(session.rpcApiUrl, stateToPublish);
        // Publish the resulting CID to IPNS
        await publishToIpns(session.rpcApiUrl, headCID, session.ipnsKeyName);
    } else {
        throw new Error("Session is misconfigured for publishing state.");
    }

    // Save cookie after successful publish
    const cookieData: OptimisticStateCookie = { cid: headCID, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKey, cookieData);

    return headCID;
}

// --- NEW Helper: Uploads *only* (for getting previous state CID) ---
/**
 * Uploads a state object without publishing to IPNS or updating the cookie.
 * Used internally for creating chunks.
 * @param stateToUpload The UserState object to upload.
 *@returns The CID of the uploaded state.
 */
export async function _uploadStateOnly(stateToUpload: UserState | Partial<UserState>): Promise<string> {
     const session = getSession();
    if (!session.sessionType) throw new Error("No active session.");

    let cid: string;
    if (session.sessionType === 'filebase' && session.s3Client && session.bucketName) {
        cid = await uploadJsonToFilebase(session.s3Client, session.bucketName, stateToUpload);
    } else if (session.sessionType === 'kubo' && session.rpcApiUrl) {
        cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload);
    } else {
        throw new Error("Session is misconfigured for state upload.");
    }
    return cid;
}