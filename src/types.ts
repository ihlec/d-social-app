// src/types/index.ts
// --- REMOVED: S3Client import ---

// ... (keep UserProfile, Follow, Post, UserState, etc.) ...
export interface UserProfile { name: string; bio?: string; }
export interface Follow { ipnsKey: string; name?: string; lastSeenCid?: string; updatedAt?: number; }
export interface Post { id: string; timestamp: number; content: string; authorKey: string; referenceCID?: string; mediaCid?: string; thumbnailCid?: string; mediaType?: 'image' | 'video' | 'file'; fileName?: string; replies?: string[]; }
export interface UserState { profile: UserProfile; postCIDs: string[]; follows: Follow[]; likedPostCIDs?: string[]; dislikedPostCIDs?: string[]; updatedAt: number; extendedUserState?: string | null; }
export interface OptimisticStateCookie { cid: string; name: string; updatedAt: number; }
export interface OnlinePeer { ipnsKey: string; name: string; }
export interface NewPostData { content: string; referenceCID?: string; file?: File; }

// --- Modified Session type ---
export interface Session {
  sessionType: 'kubo' | null; // Only Kubo
  rpcApiUrl?: string; // Kubo
  ipnsKeyName?: string; // Kubo key name ('self', 'my-key')
  resolvedIpnsKey?: string; // Actual Peer ID (Kubo)
  // --- ADDED: Optional Kubo Auth ---
  kuboUsername?: string; // Optional username for Kubo Basic Auth
  kuboPassword?: string; // Optional password for Kubo Basic Auth
  // --- END ADD ---
  // --- REMOVED: Filebase properties ---
}
// --- End Modified Session type ---

