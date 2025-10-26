// src/hooks/stateActions.ts
import { getCookie, setCookie } from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
    uploadJsonToIpfs,
    publishToIpns,
} from '../api/ipfsIpns';
// --- REMOVED: Filebase imports ---
import { createThumbnail } from '../lib/media';
import { UserProfile, UserState, OptimisticStateCookie, NewPostData, Post } from '../types';

// --- Cookie Helpers ---
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

// --- FIX: Export saveOptimisticCookie ---
export const saveOptimisticCookie = (ipnsKey: string, data: OptimisticStateCookie): void => {
    const cookieName = getOptimisticCookieName(ipnsKey);
    try {
        setCookie(cookieName, JSON.stringify(data), 7); // Save for 7 days
    } catch (e) {
        console.error("Failed to save optimistic cookie:", e);
    }
};
// --- END FIX ---

// --- Data Fetching Helpers ---
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

// --- FIX: Export fetchUserStateByIpns ---
export async function fetchUserStateByIpns(ipnsKey: string): Promise<{ state: UserState, cid: string }> {
    const cid = await resolveIpns(ipnsKey);
    const state = await fetchUserState(cid, ipnsKey);
    return { state, cid };
}
// --- END FIX ---


export async function fetchUserStateChunkByIpns(ipnsKey: string): Promise<Partial<UserState>> { // ...
    const cid = await resolveIpns(ipnsKey);
    return await fetchUserStateChunk(cid);
}

// --- Kubo-specific Upload Helper ---
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
// --- FIX: Export uploadPost ---
export async function uploadPost(postData: NewPostData, myIpnsKey: string) { // ...
    const { content, referenceCID, file } = postData;
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("No active Kubo session.");
    }

    let mediaCid: string | undefined, thumbnailCid: string | undefined;
    let mediaType: 'image' | 'video' | 'file' | undefined, fileName: string | undefined;
    
    if (file) {
        if (file.type.startsWith("image/")) mediaType = 'image';
        else if (file.type.startsWith("video/")) mediaType = 'video';
        else { mediaType = 'file'; fileName = file.name; }
        
        const thumbnailFile = await createThumbnail(file);
        
        mediaCid = await uploadFileToKubo(session.rpcApiUrl, file);
        if (thumbnailFile) thumbnailCid = await uploadFileToKubo(session.rpcApiUrl, thumbnailFile);
    }
    
    const finalPost: Omit<Post, 'id' | 'replies'> = {
        timestamp: Date.now(), content, authorKey: myIpnsKey, referenceCID, mediaCid, thumbnailCid, mediaType, fileName,
    };
    
    let finalPostCID: string;
    finalPostCID = await uploadJsonToIpfs(session.rpcApiUrl, finalPost);
    
    return { finalPost, finalPostCID };
}
// --- END FIX ---

/**
 * Uploads a given state object and publishes its CID to IPNS. Updates cookie.
 * Ensures `extendedUserState` link is maintained if not already set by chunking logic.
 * @param stateToPublish The UserState object (or partial chunk) to upload.
 * @param myIpnsKey The user's IPNS key for cookie saving.
 * @param currentHeadCID The CID of the state *before* this update (used for linking if not chunking).
 * @returns The CID of the uploaded state.
 */
// --- FIX: Export _uploadStateAndPublishToIpns ---
export async function _uploadStateAndPublishToIpns(
    stateToPublish: UserState | Partial<UserState>,
    myIpnsKey: string,
    currentHeadCID?: string // CID before this update
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl || !session.ipnsKeyName) {
        throw new Error("Session is misconfigured for publishing state.");
    }

    const profileName = ('profile' in stateToPublish && stateToPublish.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    const timestamp = ('updatedAt' in stateToPublish && stateToPublish.updatedAt) || Date.now();

    const finalStateToUpload = { ...stateToPublish };

    const isChunk = 'extendedUserState' in finalStateToUpload && finalStateToUpload.extendedUserState;

    if (!isChunk && currentHeadCID) {
        console.log(`[_uploadStateAndPublishToIpns] Not a chunk, linking to previous head: ${currentHeadCID}`);
        (finalStateToUpload as Partial<UserState>).extendedUserState = currentHeadCID;
    } else if (!isChunk && !currentHeadCID) {
        console.log("[_uploadStateAndPublishToIpns] Not a chunk and no previous head CID provided. Creating initial state.");
         (finalStateToUpload as Partial<UserState>).extendedUserState = null; // Explicitly null for clarity
    } else {
         console.log("[_uploadStateAndPublishToIpns] Is a chunk, using existing extendedUserState link:", finalStateToUpload.extendedUserState);
    }

    let headCID: string;

    headCID = await uploadJsonToIpfs(session.rpcApiUrl, finalStateToUpload);
    await publishToIpns(session.rpcApiUrl, headCID, session.ipnsKeyName);

    // Save cookie after successful publish
    const cookieData: OptimisticStateCookie = { cid: headCID, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKey, cookieData);

    return headCID;
}
// --- END FIX ---

/**
 * Uploads a state object without publishing to IPNS or updating the cookie.
 * Used internally for creating chunks.
 * @param stateToUpload The UserState object to upload.
 *@returns The CID of the uploaded state.
 */
// --- FIX: Export _uploadStateOnly ---
export async function _uploadStateOnly(stateToUpload: UserState | Partial<UserState>): Promise<string> {
     const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for state upload.");
    }

    let cid: string;
    cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload);
    
    return cid;
}
// --- END FIX ---

