// fileName: src/types.ts
export interface UserProfile {
    name: string;
    bio?: string;
}

export interface Follow {
    ipnsKey: string;
    name?: string;
    lastSeenCid?: string;
    updatedAt?: number;
}

export interface Post {
    id: string;
    timestamp: number;
    content: string;
    authorKey: string;
    referenceCID?: string;
    mediaCid?: string;
    thumbnailCid?: string;
    mediaType?: 'image' | 'video' | 'file';
    fileName?: string;
    mediaFileName?: string;
    thumbnailFileName?: string;
    mediaAspectRatio?: number;
    replies?: string[];
}

export interface UserState {
    profile: UserProfile;
    postCIDs: string[];
    follows: Follow[];
    // We stick to the existing schema:
    likedPostCIDs?: string[];
    dislikedPostCIDs?: string[]; 
    blockedUsers?: string[]; // List of IPNS keys
    updatedAt: number;
    extendedUserState?: string | null;
}

export interface OptimisticStateCookie {
    cid: string;
    name: string;
    updatedAt: number;
}

export interface OnlinePeer {
    ipnsKey: string;
    name: string;
}

export interface NewPostData {
    content: string;
    referenceCID?: string;
    file?: File;
}

export interface Session {
    sessionType: 'kubo' | null;
    rpcApiUrl?: string;
    ipnsKeyName?: string;
    resolvedIpnsKey?: string;
    kuboUsername?: string;
    kuboPassword?: string;
    requiresPassword?: boolean;
}

export interface KuboAuth {
    username?: string;
    password?: string;
}