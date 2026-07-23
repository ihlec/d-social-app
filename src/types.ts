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
    likedPostCIDs?: string[];
    dislikedPostCIDs?: string[];
    /** Explicitly saved posts — pins full media (not just thumbs). */
    savedPostCIDs?: string[];
    /** IPNS keys */
    blockedUsers?: string[];
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
    /** Latest state CID announced over Trystero (may not be on public gateways yet). */
    stateCid?: string;
    /** Trystero/WebRTC peer id for direct feed sync. */
    trysteroPeerId?: string;
}

export interface NewPostData {
    content: string;
    referenceCID?: string;
    file?: File;
}

export interface Session {
    sessionType: 'helia' | null;
    /** Local keychain label (e.g. display name) */
    ipnsKeyName?: string;
    /** Public IPNS name (k51…) */
    resolvedIpnsKey?: string;
    /** User set a custom keychain passphrase */
    requiresPassword?: boolean;
}