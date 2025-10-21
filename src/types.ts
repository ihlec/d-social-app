// src/types/index.ts
import { S3Client } from "@aws-sdk/client-s3";

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
  sessionType: 'kubo' | 'filebase' | null;
  rpcApiUrl?: string; // Kubo
  ipnsKeyName?: string; // Kubo key name ('self', 'my-key')
  resolvedIpnsKey?: string; // Actual Peer ID (for both Kubo and Filebase)
  s3Client?: S3Client | undefined; // Filebase S3 Client (needs initialization)
  bucketName?: string; // Filebase Bucket Name
  ipnsNameLabel?: string; // Filebase IPNS Name Label (e.g., "Tom")
  // Store Filebase S3/API credentials
  filebaseKey?: string; // Filebase Access Key ID
  filebaseSecret?: string; // Filebase Secret Access Key
}
// --- End Modified Session type ---