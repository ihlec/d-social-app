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
    /** Author peer public id (CAS `bafkrei…` or legacy `k51…`) */
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
    /** Liked posts — serve commitment (pin post + media; join want shards). */
    likedPostCIDs?: string[];
    dislikedPostCIDs?: string[];
    /** Bookmarked posts — same full pin as like; kept if you unlike. */
    savedPostCIDs?: string[];
    /** Peer public ids */
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
    /** Peer public id (CAS or legacy Helia) */
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
    /** Public peer id (CAS `bafkrei…`, or legacy Helia `k51…`) */
    resolvedIpnsKey?: string;
    /** User set a custom identity passphrase */
    requiresPassword?: boolean;
}