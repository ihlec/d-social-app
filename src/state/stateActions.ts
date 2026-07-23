// fileName: src/state/stateActions.ts
import { 
    saveOptimisticCookie
} from '../lib/utils';
import {
    getSession,
    resolveIpns,
    fetchUserState,
    fetchUserStateChunk,
} from '../api/ipfsIpns';
import { uploadJson, uploadFile } from '../api/contentUpload';
import { publishIpns, heliaUnpin } from '../api/heliaNode';
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

// --- Complex Action Helpers ---
export async function uploadPost(postData: NewPostData, authorPeerId: string) {
    const { content, referenceCID, file } = postData;
    const session = getSession();
    if (session.sessionType !== 'helia') {
        throw new Error("No active Helia session. Please log in.");
    }
    const userLabel = sessionStorage.getItem("currentUserLabel") || "unknownUser";

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

        const mediaUploadResult = await uploadFile(file, { userLabel });
        mediaCid = mediaUploadResult.cid;
        uniqueMediaFileName = mediaUploadResult.uniqueFileName;

        if (thumbnailFile) {
            const thumbUploadResult = await uploadFile(thumbnailFile, { userLabel });
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

    const finalPostCID = await uploadJson(finalPost);

    return { finalPost, finalPostCID };
}

// --- NEW: Phase 1 - Upload JSON to IPFS (Fast) ---
export async function uploadStateToIpfs(
    stateToUpload: UserState | Partial<UserState>,
    myIpnsKeyLabel: string 
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'helia') {
        throw new Error("Session is misconfigured for state upload.");
    }
    const profileName = ('profile' in stateToUpload && stateToUpload.profile?.name) || sessionStorage.getItem("currentUserLabel") || '';
    const timestamp = ('updatedAt' in stateToUpload && stateToUpload.updatedAt) || Date.now();

    const cid = await uploadJson(stateToUpload);
    
    const cookieData: OptimisticStateCookie = { cid, name: profileName, updatedAt: timestamp };
    saveOptimisticCookie(myIpnsKeyLabel, cookieData);

    console.log(`[uploadStateToIpfs] State uploaded: ${cid}`);
    return cid;
}

export async function publishStateToIpns(
    cid: string, 
    keyName: string
): Promise<string> {
    const session = getSession();
    if (session.sessionType !== 'helia') {
        throw new Error("Session is misconfigured for IPNS publish.");
    }

    console.log(`[publishStateToIpns] Publishing ${cid} to key ${keyName}...`);
    await publishIpns(keyName, cid);
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
    return uploadJson(stateToUpload);
}

export async function pruneContent(postToPrune: Post) {
    const session = getSession();
    if (session.sessionType !== 'helia') {
        console.warn("Cannot prune content: No active Helia session.");
        return;
    }

    const cids = [postToPrune.id, postToPrune.mediaCid, postToPrune.thumbnailCid]
        .filter((cid): cid is string => !!cid);

    await Promise.allSettled(cids.map(async (cid) => {
        console.log(`[prune] Unpinning CID: ${cid}`);
        await heliaUnpin(cid);
    }));
    console.log("[prune] Unpinning complete.");
}