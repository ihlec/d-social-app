// fileName: src/hooks/stateActions.ts
import { getCookie, setCookie } from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
    uploadJsonToIpfs, // Keep this import for Kubo uploads
    publishToIpns,
    // --- START MODIFICATION: Import fetchKubo ---
    fetchKubo,
    // --- END MODIFICATION ---
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
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize label for folder name
    const directoryName = `dSocialApp-${sanitizedLabel}`;

    const headers = new Headers();
    if (auth?.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers.append('Authorization', `Basic ${credentials}`);
    }

    let fileCid: string | null = null;
    const fileName = (file instanceof File) ? file.name : 'blob';
    // --- FIX: Use a leading slash for an absolute MFS path ---
    const targetPath = `/${directoryName}/${fileName}`; 

    try {
        // ---
        // --- START OF MODIFICATION ---
        // ---

        // --- STEP 1: Add the file normally to get its CID ---
        const addFd = new FormData();
        addFd.append('file', file, fileName); // Use the plain filename

        const addUrl = new URL(`${apiUrl}/api/v0/add`);
        addUrl.searchParams.append('pin', 'true');
        addUrl.searchParams.append('cid-version', '1');
        // Add 'wrap-with-directory=false' to just get the file's hash as a single JSON response
        addUrl.searchParams.append('wrap-with-directory', 'false'); 

        const addResponse = await fetch(addUrl.toString(), { 
            method: "POST", 
            body: addFd, 
            headers: new Headers(headers) // Pass headers
        });

        if (!addResponse.ok) throw new Error(`Kubo RPC error /api/v0/add: ${addResponse.statusText}`);
        
        const addTxt = await addResponse.text();
        try {
            const p = JSON.parse(addTxt); // Should be a single JSON line
            if (p?.Hash) {
                fileCid = p.Hash;
            } else {
                throw new Error("Bad 'add' response from Kubo. No hash found.");
            }
        } catch (e) {
             console.error("Failed to parse 'add' response:", addTxt);
             throw new Error("Bad 'add' response from Kubo (JSON parse failed).");
        }

        if (!fileCid) throw new Error("Could not extract CID from 'add' response.");

        // --- STEP 2: Copy the file (by CID) into the MFS path ---
        console.log(`[uploadFileToKubo] File added (CID: ${fileCid}). Copying to MFS path: ${targetPath}`);

        const cpUrl = new URL(`${apiUrl}/api/v0/files/cp`);
        cpUrl.searchParams.append('arg', `/ipfs/${fileCid}`); // Source: /ipfs/CID
        cpUrl.searchParams.append('arg', targetPath);       // Destination: /dSocialApp-Ben/file.mp4
        cpUrl.searchParams.append('parents', 'true');      // Create parent directories if they don't exist

        const cpResponse = await fetch(cpUrl.toString(), { 
            method: "POST", 
            headers: new Headers(headers) // Pass headers again
        });

        if (!cpResponse.ok) {
            // Try to read error message from Kubo
            try {
                const errJson = await cpResponse.json();
                throw new Error(`Kubo RPC error /api/v0/files/cp: ${errJson.Message || cpResponse.statusText}`);
            } catch {
                throw new Error(`Kubo RPC error /api/v0/files/cp: ${cpResponse.statusText}`);
            }
        }
        
        console.log(`[uploadFileToKubo] Successfully copied CID ${fileCid} to MFS path ${targetPath}`);
        return fileCid; // Return the CID

        // ---
        // --- END OF MODIFICATION ---
        // ---

    } catch (e) { 
        console.error(`Kubo file upload or MFS copy failed:`, e); 
        throw e; 
    }
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
    myIpnsKey: string
    // --- FIX: Removed currentHeadCID argument ---
    // currentHeadCID?: string // CID before this update
    // --- END FIX ---
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl || !session.ipnsKeyName) {
        throw new Error("Session is misconfigured for publishing state.");
    }
    const auth = { username: session.kuboUsername, password: session.kuboPassword }; // Prepare auth object

    const profileName = ('profile' in stateToPublish && stateToPublish.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    const timestamp = ('updatedAt' in stateToPublish && stateToPublish.updatedAt) || Date.now();

    const finalStateToUpload = { ...stateToPublish };

    // --- FIX: Remove logic that uses currentHeadCID. ---
    // The stateToPublish object now *always* contains the correct extendedUserState link (or null)
    // as set by the logic in useActions.ts.
    console.log("[_uploadStateAndPublishToIpns] Publishing state with link:", finalStateToUpload.extendedUserState);
    // --- END FIX ---

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

// --- START MODIFICATION: Add pruneContentFromKubo ---
/**
 * Unpins CIDs, removes files from MFS, and runs GC on the local Kubo node.
 * @param cidsToUnpin An array of CIDs to unpin.
 * @param mfsPathsToRemove An array of absolute MFS paths to remove (e.g., /dSocialApp-Ben/file.jpg)
 */
export async function pruneContentFromKubo(cidsToUnpin: (string | undefined)[], mfsPathsToRemove: (string | undefined)[]) {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        console.warn("Cannot prune content: No active Kubo session.");
        return;
    }
    const auth = { username: session.kuboUsername, password: session.kuboPassword };
    const rpcApiUrl = session.rpcApiUrl;

    // 1. Unpin CIDs
    const unpinPromises = cidsToUnpin.map(cid => {
        if (!cid) return Promise.resolve();
        console.log(`[prune] Unpinning CID: ${cid}`);
        // Note: fetchKubo is imported from ipfsIpns.ts
        return fetchKubo(rpcApiUrl, '/api/v0/pin/rm', { arg: cid }, undefined, auth)
            .catch(e => console.error(`Failed to unpin ${cid}:`, e)); // Don't let one failure stop others
    });
    await Promise.allSettled(unpinPromises);
    console.log("[prune] Unpinning complete.");

    // 2. Remove from MFS
    const mfsPromises = mfsPathsToRemove.map(path => {
        if (!path) return Promise.resolve();
        console.log(`[prune] Removing MFS path: ${path}`);
        return fetchKubo(rpcApiUrl, '/api/v0/files/rm', { arg: path }, undefined, auth)
            .catch(e => console.error(`Failed to remove MFS ${path}:`, e));
    });
    await Promise.allSettled(mfsPromises);
    console.log("[prune] MFS removal complete.");

    // 3. Run Garbage Collector to prune blocks from cache
    try {
        console.log("[prune] Triggering garbage collection...");
        await fetchKubo(rpcApiUrl, '/api/v0/repo/gc', undefined, undefined, auth);
        console.log("[prune] Garbage collection complete.");
    } catch (e) {
        console.error("Garbage collection failed:", e);
    }
}
// --- END MODIFICATION ---