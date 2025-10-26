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

export const saveOptimisticCookie = (ipnsKey: string, data: OptimisticStateCookie): void => {
    const cookieName = getOptimisticCookieName(ipnsKey);
    try {
        setCookie(cookieName, JSON.stringify(data), 7); // Save for 7 days
    } catch (e) {
        console.error("Failed to save optimistic cookie:", e);
    }
};

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

export async function fetchUserStateByIpns(ipnsKey: string): Promise<{ state: UserState, cid: string }> {
    const cid = await resolveIpns(ipnsKey);
    const state = await fetchUserState(cid, ipnsKey);
    return { state, cid };
}


export async function fetchUserStateChunkByIpns(ipnsKey: string): Promise<Partial<UserState>> { // ...
    const cid = await resolveIpns(ipnsKey);
    return await fetchUserStateChunk(cid);
}

// --- Kubo-specific Upload Helper ---
// --- MODIFIED: Added userLabel parameter ---
async function uploadFileToKubo(apiUrl: string, file: File | Blob, userLabel: string): Promise<string> {
    const fd = new FormData();
    fd.append('file', file);
    const url = new URL(`${apiUrl}/api/v0/add`);
    url.searchParams.append('pin', 'true');
    url.searchParams.append('cid-version', '1');
    // --- ADDED: 'to' and 'create' parameters for directory ---
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize label for folder name
    const directoryName = `dSocialApp-${sanitizedLabel}`;
    url.searchParams.append('to', directoryName);
    url.searchParams.append('create', 'true'); // Create directory if it doesn't exist
    url.searchParams.append('wrap-with-directory', 'true'); // Ensure file is *inside* the directory
    // --- END ADD ---

    try {
        const response = await fetch(url.toString(), { method: "POST", body: fd });
        if (!response.ok) throw new Error(`Kubo RPC error /api/v0/add: ${response.statusText}`);
        const txt = await response.text();
        const lines = txt.trim().split('\n');
        // --- MODIFIED: Find the entry matching the file name within the directory ---
        const fileName = (file instanceof File) ? file.name : 'blob'; // Get filename or default
        const targetPath = `${directoryName}/${fileName}`;
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const p = JSON.parse(lines[i]);
                // Check if the entry's Name matches the expected directory/filename path
                if (p?.Name === targetPath && p?.Hash) {
                    return p.Hash;
                }
                // Also check if the *last* entry represents the created *directory*
                // and return the file's hash if the directory structure was simple
                if (i === lines.length -1 && p?.Name === directoryName && lines.length > 1) {
                   // If the wrapper directory is the last entry,
                   // the actual file hash is likely the second-to-last entry.
                   try {
                       const fileEntry = JSON.parse(lines[lines.length - 2]);
                       if (fileEntry?.Hash && fileEntry?.Name === fileName) { // Check name matches without dir
                          return fileEntry.Hash;
                       }
                   } catch {/* ignore parse error */}
                }
            } catch { /* ignore parse error */ }
        }
        // Fallback: If specific path not found, return the hash of the last entry (might be the dir CID)
        // Or better: try parsing the second to last line assuming the last is the directory wrapper
        if (lines.length > 1) {
            try {
                const lastFileEntry = JSON.parse(lines[lines.length - 2]);
                if (lastFileEntry?.Hash) return lastFileEntry.Hash;
            } catch { /* ignore */ }
        }
         // Final fallback if only one line or second-to-last fails
        if (lines.length > 0) {
            try {
                const lastEntry = JSON.parse(lines[lines.length - 1]);
                if (lastEntry?.Hash) return lastEntry.Hash;
            } catch { /* ignore */ }
        }
        // --- END MODIFICATION ---
        throw new Error("Bad 'add' response from Kubo or could not find file hash in response.");
    } catch (e) { console.error(`Kubo file upload failed:`, e); throw e; }
}

// --- Complex Action Helpers ---
export async function uploadPost(postData: NewPostData, myIpnsKey: string) { // ...
    const { content, referenceCID, file } = postData;
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("No active Kubo session.");
    }
    // --- ADDED: Get userLabel ---
    const userLabel = sessionStorage.getItem("currentUserLabel") || "unknownUser";
    // --- END ADD ---

    let mediaCid: string | undefined, thumbnailCid: string | undefined;
    let mediaType: 'image' | 'video' | 'file' | undefined, fileName: string | undefined;

    if (file) {
        if (file.type.startsWith("image/")) mediaType = 'image';
        else if (file.type.startsWith("video/")) mediaType = 'video';
        else { mediaType = 'file'; fileName = file.name; }

        const thumbnailFile = await createThumbnail(file);

        // --- MODIFIED: Pass userLabel to uploadFileToKubo ---
        mediaCid = await uploadFileToKubo(session.rpcApiUrl, file, userLabel);
        if (thumbnailFile) thumbnailCid = await uploadFileToKubo(session.rpcApiUrl, thumbnailFile, userLabel);
        // --- END MODIFICATION ---
    }

    const finalPost: Omit<Post, 'id' | 'replies'> = {
        timestamp: Date.now(), content, authorKey: myIpnsKey, referenceCID, mediaCid, thumbnailCid, mediaType, fileName,
    };

    let finalPostCID: string;
    finalPostCID = await uploadJsonToIpfs(session.rpcApiUrl, finalPost);

    return { finalPost, finalPostCID };
}


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

export async function _uploadStateOnly(stateToUpload: UserState | Partial<UserState>): Promise<string> {
     const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for state upload.");
    }

    let cid: string;
    cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload);

    return cid;
}

