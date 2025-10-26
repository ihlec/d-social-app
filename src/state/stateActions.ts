// src/hooks/stateActions.ts
import { getCookie, setCookie } from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
    uploadJsonToIpfs, // Keep this import for Kubo uploads
    publishToIpns,
} from '../api/ipfsIpns';
// --- REMOVED: Filebase imports ---
import { createThumbnail } from '../lib/media';
import { UserProfile, UserState, OptimisticStateCookie, NewPostData, Post } from '../types';

// --- Cookie Helpers ---
const getOptimisticCookieName = (ipnsKey: string) => `dSocialOptimisticState_${ipnsKey}`;

// --- ADDED: Export keyword ---
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
// --- END ADD ---

// --- ADDED: Export keyword ---
export const saveOptimisticCookie = (ipnsKey: string, data: OptimisticStateCookie): void => {
    const cookieName = getOptimisticCookieName(ipnsKey);
    try {
        setCookie(cookieName, JSON.stringify(data), 7); // Save for 7 days
    } catch (e) {
        console.error("Failed to save optimistic cookie:", e);
    }
};
// --- END ADD ---

// --- Data Fetching Helpers ---
// --- ADDED: Export keyword ---
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
// --- END ADD ---

// --- ADDED: Export keyword ---
export async function fetchUserStateByIpns(ipnsKey: string): Promise<{ state: UserState, cid: string }> {
    const cid = await resolveIpns(ipnsKey);
    const state = await fetchUserState(cid, ipnsKey);
    return { state, cid };
}
// --- END ADD ---

// --- ADDED: Export keyword ---
export async function fetchUserStateChunkByIpns(ipnsKey: string): Promise<Partial<UserState>> { // ...
    const cid = await resolveIpns(ipnsKey);
    return await fetchUserStateChunk(cid);
}
// --- END ADD ---

// --- Kubo-specific Upload Helper ---
async function uploadFileToKubo(apiUrl: string, file: File | Blob, userLabel: string, auth?: { username?: string, password?: string }): Promise<string> {
    const fd = new FormData();
    fd.append('file', file);
    const url = new URL(`${apiUrl}/api/v0/add`);
    url.searchParams.append('pin', 'true');
    url.searchParams.append('cid-version', '1');
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize label for folder name
    const directoryName = `dSocialApp-${sanitizedLabel}`;

    const headers = new Headers();
    if (auth?.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers.append('Authorization', `Basic ${credentials}`);
    }

    try {
        const fileName = (file instanceof File) ? file.name : 'blob'; // Get filename or default
        const targetPath = `${directoryName}/${fileName}`; // Target path within Kubo's MFS-like structure for 'add'

        const addFd = new FormData();
        addFd.append('file', file, targetPath); // Specify the full path as the filename in FormData

        const addUrl = new URL(`${apiUrl}/api/v0/add`);
        addUrl.searchParams.append('pin', 'true');
        addUrl.searchParams.append('cid-version', '1');
        // addUrl.searchParams.append('parents', 'true'); // Optionally ensure parent dirs are created


        const response = await fetch(addUrl.toString(), { method: "POST", body: addFd, headers: headers }); // Pass auth headers

        if (!response.ok) throw new Error(`Kubo RPC error /api/v0/add: ${response.statusText}`);
        const txt = await response.text();
        const lines = txt.trim().split('\n');
        // The last line should contain the hash of the added file or the wrapping directory
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const p = JSON.parse(lines[i]);
                 // Check if the name matches the intended file path within the directory
                if (p?.Name === targetPath && p?.Hash) {
                    return p.Hash;
                }
                // Fallback: If the last entry is just the file name (less likely with path in FormData)
                if (p?.Name === fileName && p?.Hash) {
                    console.warn(`[uploadFileToKubo] Found hash by filename match ('${fileName}') instead of full path ('${targetPath}'). Check Kubo 'add' behavior.`);
                    return p.Hash;
                }
                 // Fallback: If the response wraps it in a directory object, take the file hash before it
                if (p?.Name === directoryName && lines.length > 1 && i === lines.length - 1) {
                     try {
                        const fileEntry = JSON.parse(lines[i - 1]);
                        if (fileEntry?.Hash && fileEntry?.Name === fileName) { // Check name matches without dir
                            console.warn(`[uploadFileToKubo] Found hash in entry preceding directory ('${directoryName}'). Check Kubo 'add' behavior.`);
                           return fileEntry.Hash;
                        }
                    } catch {/* ignore parse error */}
                }

            } catch { /* ignore parse error */ }
        }
        // Last resort fallback: grab the hash from the very last line if nothing else matched
        if (lines.length > 0) {
            try {
                const lastEntry = JSON.parse(lines[lines.length - 1]);
                if (lastEntry?.Hash) {
                     console.warn(`[uploadFileToKubo] Using hash from last line ('${lastEntry?.Name}') as fallback.`);
                    return lastEntry.Hash;
                }
            } catch { /* ignore */ }
        }
        throw new Error("Bad 'add' response from Kubo or could not find file hash in response.");
    } catch (e) { console.error(`Kubo file upload failed:`, e); throw e; }
}


// --- Complex Action Helpers ---
// --- ADDED: Export keyword ---
export async function uploadPost(postData: NewPostData, myIpnsKey: string) { // ...
    const { content, referenceCID, file } = postData;
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("No active Kubo session.");
    }
    const userLabel = sessionStorage.getItem("currentUserLabel") || "unknownUser";
    const auth = { username: session.kuboUsername, password: session.kuboPassword }; // Prepare auth object

    let mediaCid: string | undefined, thumbnailCid: string | undefined;
    let mediaType: 'image' | 'video' | 'file' | undefined, fileName: string | undefined;

    if (file) {
        if (file.type.startsWith("image/")) mediaType = 'image';
        else if (file.type.startsWith("video/")) mediaType = 'video';
        else { mediaType = 'file'; fileName = file.name; }

        const thumbnailFile = await createThumbnail(file);

        // Pass auth to Kubo upload
        mediaCid = await uploadFileToKubo(session.rpcApiUrl, file, userLabel, auth);
        if (thumbnailFile) thumbnailCid = await uploadFileToKubo(session.rpcApiUrl, thumbnailFile, userLabel, auth);
    }

    const finalPost: Omit<Post, 'id' | 'replies'> = {
        timestamp: Date.now(), content, authorKey: myIpnsKey, referenceCID, mediaCid, thumbnailCid, mediaType, fileName,
    };

    let finalPostCID: string;
    // Pass auth to Kubo JSON upload
    finalPostCID = await uploadJsonToIpfs(session.rpcApiUrl, finalPost, auth);

    return { finalPost, finalPostCID };
}
// --- END ADD ---


// --- ADDED: Export keyword ---
export async function _uploadStateAndPublishToIpns(
    stateToPublish: UserState | Partial<UserState>,
    myIpnsKey: string,
    currentHeadCID?: string // CID before this update
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl || !session.ipnsKeyName) {
        throw new Error("Session is misconfigured for publishing state.");
    }
    const auth = { username: session.kuboUsername, password: session.kuboPassword }; // Prepare auth object

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

    // Pass auth to Kubo JSON upload
    headCID = await uploadJsonToIpfs(session.rpcApiUrl, finalStateToUpload, auth);
    // Pass auth to Kubo publish
    await publishToIpns(session.rpcApiUrl, headCID, session.ipnsKeyName, auth);

    // Save cookie after successful publish
    const cookieData: OptimisticStateCookie = { cid: headCID, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKey, cookieData);

    return headCID;
}
// --- END ADD ---

// --- ADDED: Export keyword ---
export async function _uploadStateOnly(stateToUpload: UserState | Partial<UserState>): Promise<string> {
     const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for state upload.");
    }
     const auth = { username: session.kuboUsername, password: session.kuboPassword }; // Prepare auth object

    let cid: string;
    // Pass auth to Kubo JSON upload
    cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload, auth);

    return cid;
}
// --- END ADD ---

