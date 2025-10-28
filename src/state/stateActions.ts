// fileName: src/hooks/stateActions.ts
import { getCookie, setCookie } from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
    uploadJsonToIpfs, // Keep this import for Kubo uploads
    publishToIpns,
    fetchKubo, // Import fetchKubo
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
async function uploadFileToKubo(
    apiUrl: string,
    file: File | Blob,
    userLabel: string,
    auth?: { username?: string, password?: string }
): Promise<{cid: string, uniqueFileName: string}> {
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const directoryName = `dSocialApp-${sanitizedLabel}`;

    const headers = new Headers();
    if (auth?.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers.append('Authorization', `Basic ${credentials}`);
    }

    let fileCid: string | null = null;

    const originalFileName = (file instanceof File) ? file.name : 'blob';
    const extension = originalFileName.includes('.') ? originalFileName.substring(originalFileName.lastIndexOf('.')) : '';
    const baseName = originalFileName.includes('.') ? originalFileName.substring(0, originalFileName.lastIndexOf('.')) : originalFileName;
    const uniqueFileName = `${baseName}-${Date.now()}${extension}`;
    const targetPath = `/${directoryName}/${uniqueFileName}`;

    try {
        // STEP 1: Add the file normally to get its CID
        const addFd = new FormData();
        addFd.append('file', file, uniqueFileName);

        // Use default (longer) timeout for add
        const addResponse = await fetchKubo(apiUrl, '/api/v0/add',
            { pin: 'true', 'cid-version': '1', 'wrap-with-directory': 'false' },
            addFd,
            auth
        );

        if (addResponse?.Hash) {
            fileCid = addResponse.Hash;
        } else {
             console.error("Failed to parse 'add' response:", addResponse);
             throw new Error("Bad 'add' response from Kubo. No hash found.");
        }

        if (!fileCid) throw new Error("Could not extract CID from 'add' response.");

        // STEP 2: Copy the file (by CID) into the MFS path
        console.log(`[uploadFileToKubo] File added (CID: ${fileCid}). Copying to MFS path: ${targetPath}`);

        // --- START MODIFICATION: Use 'arg' for both source and destination ---
        // Construct parameters ensuring 'arg' appears twice
        const cpParams = new URLSearchParams();
        cpParams.append('arg', `/ipfs/${fileCid}`); // Source
        cpParams.append('arg', targetPath);       // Destination
        cpParams.append('parents', 'true');
        cpParams.append('flush', 'true');
        // Convert URLSearchParams to a Record<string, string> for fetchKubo
        const finalCpParams: Record<string, string> = {};
        for (const [key, value] of cpParams.entries()) {
            // Note: If URLSearchParams has multiple 'arg', .entries() might only yield the first.
            // However, fetchKubo's logic handles appending multiple keys with the same name.
            // A more robust way might involve fetchKubo accepting URLSearchParams directly,
            // but for now, we'll try passing the object derived from it.
            // If issues persist, consider manually constructing the query string.
            if (finalCpParams[key]) {
                // If the key already exists (like 'arg'), create a temporary unique key
                // This relies on fetchKubo reconstructing the URL correctly
                 finalCpParams[`${key}_${Math.random().toString(36).substring(7)}`] = value;
            } else {
                finalCpParams[key] = value;
            }
        }
         // Re-map unique keys back to 'arg' if needed by fetchKubo's reconstruction logic
         const remappedParams: Record<string, string> = {};
         Object.entries(finalCpParams).forEach(([key, value]) => {
             if (key.startsWith('arg_')) {
                 remappedParams['arg'] = value; // This will overwrite, need better handling in fetchKubo if this fails
             } else if (key === 'arg') {
                  remappedParams['arg'] = value; // Ensure the first 'arg' is kept
             }
              else {
                 remappedParams[key] = value;
             }
         });
         // Let's directly construct the query string to be sure
         const queryString = `arg=${encodeURIComponent(`/ipfs/${fileCid}`)}&arg=${encodeURIComponent(targetPath)}&parents=true&flush=true`;
         const cpUrlPath = `/api/v0/files/cp?${queryString}`;
        // --- END MODIFICATION ---


        // Use default (longer) timeout for cp
        // --- START MODIFICATION: Pass reconstructed path instead of params object ---
        await fetchKubo(apiUrl, cpUrlPath, undefined /* No params object */, undefined, auth);
        // --- END MODIFICATION ---

        console.log(`[uploadFileToKubo] Successfully copied CID ${fileCid} to MFS path ${targetPath}`);
        return { cid: fileCid, uniqueFileName };

    } catch (e) {
        console.error(`Kubo file upload or MFS copy failed:`, e);
        throw e;
    }
}


// --- Complex Action Helpers ---
export async function uploadPost(postData: NewPostData, myIpnsKey: string) { // ...
    const { content, referenceCID, file } = postData;
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("No active Kubo session.");
    }
    const userLabel = sessionStorage.getItem("currentUserLabel") || "unknownUser";
    const auth = { username: session.kuboUsername, password: session.kuboPassword };

    let mediaCid: string | undefined, thumbnailCid: string | undefined;
    let mediaType: 'image' | 'video' | 'file' | undefined;
    let uniqueMediaFileName: string | undefined;
    let uniqueThumbnailFileName: string | undefined;
    let originalFileNameForFiletype: string | undefined;
    // --- START MODIFICATION: Add aspect ratio variable ---
    let mediaAspectRatio: number | undefined;
    // --- END MODIFICATION ---

    if (file) {
        if (file.type.startsWith("image/")) mediaType = 'image';
        else if (file.type.startsWith("video/")) mediaType = 'video';
        else {
            mediaType = 'file';
            originalFileNameForFiletype = file.name;
        }

        // --- START MODIFICATION: Destructure new return value ---
        const { thumbnailFile, aspectRatio } = await createThumbnail(file);
        if (aspectRatio) {
            mediaAspectRatio = aspectRatio;
        }
        // --- END MODIFICATION ---

        const mediaUploadResult = await uploadFileToKubo(session.rpcApiUrl, file, userLabel, auth);
        mediaCid = mediaUploadResult.cid;
        uniqueMediaFileName = mediaUploadResult.uniqueFileName;

        if (thumbnailFile) {
            const thumbUploadResult = await uploadFileToKubo(session.rpcApiUrl, thumbnailFile, userLabel, auth);
            thumbnailCid = thumbUploadResult.cid;
            uniqueThumbnailFileName = thumbUploadResult.uniqueFileName;
        }
    }

    const finalPost: Omit<Post, 'id' | 'replies'> = {
        timestamp: Date.now(),
        content,
        authorKey: myIpnsKey,
        referenceCID,
        mediaCid,
        thumbnailCid,
        mediaType,
        fileName: originalFileNameForFiletype,
        mediaFileName: uniqueMediaFileName,
        thumbnailFileName: uniqueThumbnailFileName,
        // --- START MODIFICATION: Add to final post object ---
        mediaAspectRatio: mediaAspectRatio
        // --- END MODIFICATION ---
    };

    let finalPostCID: string;
    // Pass auth to Kubo JSON upload (uses longer timeout internally now)
    finalPostCID = await uploadJsonToIpfs(session.rpcApiUrl, finalPost, auth);


    return { finalPost, finalPostCID };
}


export async function _uploadStateAndPublishToIpns(
    stateToPublish: UserState | Partial<UserState>,
    myIpnsKey: string
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl || !session.ipnsKeyName) {
        throw new Error("Session is misconfigured for publishing state.");
    }
    const auth = { username: session.kuboUsername, password: session.kuboPassword };

    const profileName = ('profile' in stateToPublish && stateToPublish.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    const timestamp = ('updatedAt' in stateToPublish && stateToPublish.updatedAt) || Date.now();

    const finalStateToUpload = { ...stateToPublish };

    console.log("[_uploadStateAndPublishToIpns] Publishing state with link:", finalStateToUpload.extendedUserState);

    let headCID: string;

    // Uses longer timeout
    headCID = await uploadJsonToIpfs(session.rpcApiUrl, finalStateToUpload, auth);

    // Uses longer timeout
    await publishToIpns(session.rpcApiUrl, headCID, session.ipnsKeyName, auth);


    const cookieData: OptimisticStateCookie = { cid: headCID, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKey, cookieData);

    return headCID;
}

export async function _uploadStateOnly(stateToUpload: UserState | Partial<UserState>): Promise<string> {
     const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for state upload.");
    }
     const auth = { username: session.kuboUsername, password: session.kuboPassword };

    let cid: string;
    // Uses longer timeout
    cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload, auth);


    return cid;
}

/**
 * Unpins CIDs, removes files from MFS using stored filenames, and runs GC.
 * @param postToPrune The Post object containing CIDs and unique filenames.
 */
export async function pruneContentFromKubo(postToPrune: Post) {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        console.warn("Cannot prune content: No active Kubo session.");
        return;
    }
    const myIpnsKey = session.resolvedIpnsKey;
    if (!myIpnsKey || postToPrune.authorKey !== myIpnsKey) {
        console.warn("[prune] Skipping MFS prune: Not the author.");
        const cidsToUnpin: (string | undefined)[] = [postToPrune.id, postToPrune.mediaCid, postToPrune.thumbnailCid];
        await prunePinsAndGc(cidsToUnpin, [], session.rpcApiUrl, session.kuboUsername, session.kuboPassword);
        return;
    }

    const auth = { username: session.kuboUsername, password: session.kuboPassword };
    const rpcApiUrl = session.rpcApiUrl;
    const userLabel = sessionStorage.getItem("currentUserLabel") || "unknownUser";
    const sanitizedLabel = userLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const directoryName = `dSocialApp-${sanitizedLabel}`;

    const cidsToUnpin: (string | undefined)[] = [];
    const mfsPathsToRemove: (string | undefined)[] = [];

    cidsToUnpin.push(postToPrune.id);
    cidsToUnpin.push(postToPrune.mediaCid);
    cidsToUnpin.push(postToPrune.thumbnailCid);

    if (postToPrune.mediaFileName) {
        mfsPathsToRemove.push(`/${directoryName}/${postToPrune.mediaFileName}`);
    } else if (postToPrune.mediaType === 'file' && postToPrune.fileName) {
         console.warn(`[prune] Using potentially non-unique original fileName for MFS path of file type post ${postToPrune.id}`);
         mfsPathsToRemove.push(`/${directoryName}/${postToPrune.fileName}`);
    }

    if (postToPrune.thumbnailFileName) {
        mfsPathsToRemove.push(`/${directoryName}/${postToPrune.thumbnailFileName}`);
    }

    await prunePinsAndGc(cidsToUnpin, mfsPathsToRemove, rpcApiUrl, auth.username, auth.password);
}

/** Helper to perform unpin, MFS removal, and GC */
async function prunePinsAndGc(
    cidsToUnpin: (string | undefined)[],
    mfsPathsToRemove: (string | undefined)[],
    rpcApiUrl: string,
    username?: string,
    password?: string
) {
    const auth = { username, password };

    // Unpin CIDs (Use longer timeout)
    const unpinPromises = cidsToUnpin
        .filter((cid): cid is string => !!cid)
        .map(cid => {
            console.log(`[prune] Unpinning CID: ${cid}`);
            return fetchKubo(rpcApiUrl, '/api/v0/pin/rm', { arg: cid }, undefined, auth)
                .catch(e => console.error(`Failed to unpin ${cid}:`, e));
        });
    await Promise.allSettled(unpinPromises);
    console.log("[prune] Unpinning complete.");

    // Remove from MFS (Use longer timeout)
    if (mfsPathsToRemove.length > 0) {
        const mfsPromises = mfsPathsToRemove
             .filter((path): path is string => !!path)
            .map(path => {
                console.log(`[prune] Removing MFS path: ${path}`);
                return fetchKubo(rpcApiUrl, '/api/v0/files/rm', { arg: path, flush: 'true' }, undefined, auth)
                    .catch(e => console.error(`Failed to remove MFS ${path}:`, e));
            });
        await Promise.allSettled(mfsPromises);
        console.log("[prune] MFS removal complete.");
    } else {
         console.log("[prune] No MFS paths to remove.");
    }


    // Run Garbage Collector (Use longer timeout)
    try {
        console.log("[prune] Triggering garbage collection...");
        await fetchKubo(rpcApiUrl, '/api/v0/repo/gc', undefined, undefined, auth);
        console.log("[prune] Garbage collection complete.");
    } catch (e) {
        console.error("Garbage collection failed:", e);
    }
}