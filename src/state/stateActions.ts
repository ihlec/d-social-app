// src/hooks/stateActions.ts
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

export async function fetchUserStateByIpns(ipnsKey: string): Promise<{ state: UserState, cid: string }> {
    const cid = await resolveIpns(ipnsKey);
    // --- FIX: Pass ipnsKey as profile hint ---
    const state = await fetchUserState(cid, ipnsKey);
    // --- END FIX ---
    return { state, cid };
}

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


/**
 * Uploads a given state object and publishes its CID to IPNS. Updates cookie.
 * Ensures `extendedUserState` link is maintained if not already set by chunking logic.
 * @param stateToPublish The UserState object (or partial chunk) to upload.
 * @param myIpnsKey The user's IPNS key for cookie saving.
 * @param currentHeadCID The CID of the state *before* this update (used for linking if not chunking).
 * @returns The CID of the uploaded state.
 */
export async function _uploadStateAndPublishToIpns(
    // --- FIX: Type juggling to handle potentially missing extendedUserState ---
    stateToPublish: UserState | Partial<UserState>,
    myIpnsKey: string,
    currentHeadCID?: string // CID before this update
    // --- END FIX ---
): Promise<string> {
    const session = getSession();
    if (!session.sessionType) throw new Error("No active session.");

    const profileName = ('profile' in stateToPublish && stateToPublish.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    const timestamp = ('updatedAt' in stateToPublish && stateToPublish.updatedAt) || Date.now();

    // --- FIX: Ensure the chain link is maintained for non-chunked updates ---
    // Create a mutable copy to potentially modify
    const finalStateToUpload = { ...stateToPublish };

    // Check if extendedUserState is already set (meaning it's a chunk from useActions)
    const isChunk = 'extendedUserState' in finalStateToUpload && finalStateToUpload.extendedUserState;

    if (!isChunk && currentHeadCID) {
        console.log(`[_uploadStateAndPublishToIpns] Not a chunk, linking to previous head: ${currentHeadCID}`);
        // Ensure the property exists even if partial, and set it
        (finalStateToUpload as Partial<UserState>).extendedUserState = currentHeadCID;
    } else if (!isChunk && !currentHeadCID) {
        // This case should ideally only happen for the very first state save for a user.
        console.log("[_uploadStateAndPublishToIpns] Not a chunk and no previous head CID provided. Creating initial state.");
         (finalStateToUpload as Partial<UserState>).extendedUserState = null; // Explicitly null for clarity
    } else {
         console.log("[_uploadStateAndPublishToIpns] Is a chunk, using existing extendedUserState link:", finalStateToUpload.extendedUserState);
    }
    // --- END FIX ---


    let headCID: string;

    // Upload the potentially modified state object
    if (session.sessionType === 'filebase' && session.s3Client && session.bucketName && session.ipnsNameLabel) {
        // --- FIX: Upload the modified object ---
        headCID = await uploadJsonToFilebase(session.s3Client, session.bucketName, finalStateToUpload);
        // --- END FIX ---
        await updateIpnsRecord(session.ipnsNameLabel, headCID);
    } else if (session.sessionType === 'kubo' && session.rpcApiUrl && session.ipnsKeyName) {
        // --- FIX: Upload the modified object ---
        headCID = await uploadJsonToIpfs(session.rpcApiUrl, finalStateToUpload);
        // --- END FIX ---
        await publishToIpns(session.rpcApiUrl, headCID, session.ipnsKeyName);
    } else {
        throw new Error("Session is misconfigured for publishing state.");
    }

    // Save cookie after successful publish
    const cookieData: OptimisticStateCookie = { cid: headCID, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKey, cookieData);

    return headCID;
}

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