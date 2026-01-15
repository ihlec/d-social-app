// fileName: src/state/stateActions.ts
import { 
    saveOptimisticCookie
} from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
    uploadJsonToIpfs,
    publishToIpns,
    fetchKubo,
} from '../api/ipfsIpns';
import { createThumbnail } from '../lib/media';
import { UserProfile, UserState, OptimisticStateCookie, NewPostData, Post } from '../types';

// --- Data Fetching Helpers ---
export async function fetchUserProfile(ipnsKey: string): Promise<UserProfile> {
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

export async function fetchUserStateChunkByIpns(ipnsKey: string): Promise<Partial<UserState>> {
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
        const addFd = new FormData();
        addFd.append('file', file, uniqueFileName);

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

        console.log(`[uploadFileToKubo] File added (CID: ${fileCid}). Copying to MFS path: ${targetPath}`);

        const queryString = `arg=${encodeURIComponent(`/ipfs/${fileCid}`)}&arg=${encodeURIComponent(targetPath)}&parents=true&flush=true`;
        const cpUrlPath = `/api/v0/files/cp?${queryString}`;
       
        await fetchKubo(apiUrl, cpUrlPath, undefined, undefined, auth);

        console.log(`[uploadFileToKubo] Successfully copied CID ${fileCid} to MFS path ${targetPath}`);
        return { cid: fileCid, uniqueFileName };

    } catch (e) {
        console.error(`Kubo file upload or MFS copy failed:`, e);
        throw e;
    }
}


// --- Complex Action Helpers ---
export async function uploadPost(postData: NewPostData, authorPeerId: string) {
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
    let mediaAspectRatio: number | undefined;

    if (file) {
        if (file.type.startsWith("image/")) mediaType = 'image';
        else if (file.type.startsWith("video/")) mediaType = 'video';
        else {
            mediaType = 'file';
            originalFileNameForFiletype = file.name;
        }

        const { thumbnailFile, aspectRatio } = await createThumbnail(file);
        if (aspectRatio) {
            mediaAspectRatio = aspectRatio;
        }

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
        authorKey: authorPeerId, 
        referenceCID,
        mediaCid,
        thumbnailCid,
        mediaType,
        fileName: originalFileNameForFiletype,
        mediaFileName: uniqueMediaFileName,
        thumbnailFileName: uniqueThumbnailFileName,
        mediaAspectRatio: mediaAspectRatio
    };

    let finalPostCID: string;
    finalPostCID = await uploadJsonToIpfs(session.rpcApiUrl, finalPost, auth);

    return { finalPost, finalPostCID };
}

// --- NEW: Phase 1 - Upload JSON to IPFS (Fast) ---
export async function uploadStateToIpfs(
    stateToUpload: UserState | Partial<UserState>,
    myIpnsKeyLabel: string 
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for state upload.");
    }
    const auth = { username: session.kuboUsername, password: session.kuboPassword };
    const profileName = ('profile' in stateToUpload && stateToUpload.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    const timestamp = ('updatedAt' in stateToUpload && stateToUpload.updatedAt) || Date.now();

    // 1. Upload to IPFS
    const cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload, auth);
    
    // 2. Save Cookie (Optimistic Persistence)
    const cookieData: OptimisticStateCookie = { cid, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKeyLabel, cookieData);

    console.log(`[uploadStateToIpfs] State uploaded: ${cid}`);
    return cid;
}

// --- NEW: Phase 2 - Publish CID to IPNS (Slow) ---
export async function publishStateToIpns(
    cid: string, 
    keyName: string
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for IPNS publish.");
    }
    const auth = { username: session.kuboUsername, password: session.kuboPassword };

    console.log(`[publishStateToIpns] Publishing ${cid} to key ${keyName}...`);
    await publishToIpns(session.rpcApiUrl, cid, keyName, auth);
    console.log(`[publishStateToIpns] Done.`);
    
    return cid;
}

// --- Deprecated (kept for reference or manual use) ---
export async function _uploadStateAndPublishToIpns(
    stateToPublish: UserState | Partial<UserState>,
    myIpnsKeyLabel: string 
): Promise<string> {
    const cid = await uploadStateToIpfs(stateToPublish, myIpnsKeyLabel);
    await publishStateToIpns(cid, myIpnsKeyLabel);
    return cid;
}

export async function _uploadStateOnly(stateToUpload: UserState | Partial<UserState>): Promise<string> {
     const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        throw new Error("Session is misconfigured for state upload.");
    }
     const auth = { username: session.kuboUsername, password: session.kuboPassword };

    let cid: string;
    cid = await uploadJsonToIpfs(session.rpcApiUrl, stateToUpload, auth);

    return cid;
}

export async function pruneContentFromKubo(postToPrune: Post) {
    const session = getSession();
    if (session.sessionType !== 'kubo' || !session.rpcApiUrl) {
        console.warn("Cannot prune content: No active Kubo session.");
        return;
    }
    const myIpnsKey = session.resolvedIpnsKey;
    if (!myIpnsKey || postToPrune.authorKey !== myIpnsKey) {
        console.warn("[prune] Skipping MFS prune: Not the author.");
        // We can still unpin if we want to clean local cache, but MFS is owner-only
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

async function prunePinsAndGc(
    cidsToUnpin: (string | undefined)[],
    mfsPathsToRemove: (string | undefined)[],
    rpcApiUrl: string,
    username?: string,
    password?: string
) {
    const auth = { username, password };

    const unpinPromises = cidsToUnpin
        .filter((cid): cid is string => !!cid)
        .map(cid => {
            console.log(`[prune] Unpinning CID: ${cid}`);
            return fetchKubo(rpcApiUrl, '/api/v0/pin/rm', { arg: cid }, undefined, auth)
                .catch(e => console.error(`Failed to unpin ${cid}:`, e));
        });
    await Promise.allSettled(unpinPromises);
    console.log("[prune] Unpinning complete.");

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

    try {
        console.log("[prune] Triggering garbage collection...");
        await fetchKubo(rpcApiUrl, '/api/v0/repo/gc', undefined, undefined, auth);
        console.log("[prune] Garbage collection complete.");
    } catch (e) {
        console.error("Garbage collection failed:", e);
    }
}