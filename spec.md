Based on the code files provided and the architectural changes we have implemented, here is the comprehensive technical specification for the **D. Social App**.

-----

# Project Specification: D. Social App (Decentralized Social Graph)

## 1\. Executive Summary

**D. Social App** is a fully decentralized, client-side social media application built on the InterPlanetary File System (IPFS). It operates without a central backend server. Instead, it leverages a local **Kubo (IPFS Go Daemon)** node via RPC for data storage, identity management, content retrieval, and peer-to-peer networking.

The application allows users to publish posts, share media, follow other users, and discover peers purely through the IPFS network using IPNS for mutable state and PubSub for real-time presence.

## 2\. System Architecture

### 2.1 Technology Stack

  * **Frontend:** React (Vite), TypeScript.
  * **Storage & Networking:** IPFS (Kubo Daemon) via RPC API (port 5001).
  * **State Management:** React Context API + Local Optimistic Caching.
  * **Styling:** Native CSS (Variables/Themes) + Responsive Masonry Layout.
  * **Routing:** React Router (HashRouter).

### 2.2 Core Principles

1.  **Client-Side Only:** The React app is a static site. All logic runs in the browser.
2.  **Local-First / Local Node:** The app connects to `http://127.0.0.1:5001`. It relies on the user running their own IPFS node.
3.  **Content Addressing:** All posts and media are immutable and referenced by CID (Content ID).
4.  **Mutable Identity:** IPNS (InterPlanetary Name System) is used to point to the user's latest state.

-----

## 3\. Data Structure & State Management

### 3.1 User Identity

  * **Identity Key:** An IPNS Key (Ed25519) managed by the Kubo node.
  * **Profile:** Stored within the `UserState` object (Name, Bio).
  * **Resolution:** Resolving an IPNS Key returns the CID of the latest `UserState`.

### 3.2 The User State (Linked List)

To handle history and pagination without a database, the user state is structured as a **reverse linked list** of "Chunks".

**`UserState` Schema:**

```typescript
interface UserState {
  profile: { name: string; bio?: string };
  postCIDs: string[];        // Array of CIDs for posts in this chunk
  likedPostCIDs: string[];   // Array of CIDs liked
  dislikedPostCIDs: string[];
  follows: Follow[];         // Array of users followed
  updatedAt: number;
  extendedUserState: string | null; // CID of the PREVIOUS chunk (History)
}
```

  * **Updates:** When data is added, a new chunk is created containing the new data. The `extendedUserState` pointer is set to the CID of the previous state. This new chunk is published to IPNS.
  * **Traversal:** The app fetches the head CID via IPNS, then recursively fetches `extendedUserState` CIDs to load history lazily.

### 3.3 Posts

Posts are immutable JSON objects uploaded to IPFS.
**`Post` Schema:**

```typescript
interface Post {
  id: string;             // The CID of the post itself
  authorKey: string;      // The IPNS Key of the author
  content: string;        // Text content
  timestamp: number;
  referenceCID?: string;  // CID of parent post (if reply)
  mediaCid?: string;      // CID of attached image/video
  mediaType?: 'image' | 'video' | 'file';
  thumbnailCid?: string;  // Optimized thumbnail
}
```

-----

## 4\. Networking & Peer Discovery (PubSub)

This module replaces centralized trackers. It relies on the **GossipSub** protocol enabled in the Kubo daemon.

### 4.1 Transport

  * **Mechanism:** IPFS PubSub (RPC `/api/v0/pubsub/...`).
  * **Topic Name:** `dsocial-peers-v1`.
  * **Encoding:** Topic strings must be **Multibase encoded** (base64url with `u` prefix) when communicating with recent Kubo RPC versions.

### 4.2 Discovery Protocol

1.  **Presence (Heartbeat):**

      * Every **60 seconds**, the client publishes a JSON message to the topic.
      * **Payload:** `{ ipnsKey: string, name: string, timestamp: number }`.
      * **Trigger:** Sent immediately upon login/mount, then on interval.
      * **Method:** HTTP POST to `/api/v0/pubsub/pub` (FormData body).

2.  **Listening (Subscription):**

      * The client opens a long-lived HTTP connection to `/api/v0/pubsub/sub?arg=<encoded-topic>&discover=true`.
      * Incoming data streams as **NDJSON** (Newline Delimited JSON).
      * **Parsing:**
        1.  Decode NDJSON line.
        2.  Extract `data` field (Base64).
        3.  Decode Base64 to UTF-8 string.
        4.  Parse inner JSON to get Peer Presence.

3.  **Local Peer State:**

      * The app maintains a `Map<IpnsKey, LastSeenTimestamp>`.
      * **Pruning:** A local interval runs every **5 seconds**. Any peer not seen for **\> 90 seconds** is removed from the "Online Peers" list.

-----

## 5\. Functional Requirements

### 5.1 Authentication

  * **Login:** User provides Kubo RPC URL and IPNS Key Name.
  * **Key Generation:** If the key name doesn't exist, the app instructs Kubo to generate an Ed25519 key.
  * **State Initialization:** If no IPNS record exists, an empty `UserState` is created, pinned, and published.
  * **Session:** Session details are stored in a secure cookie.

### 5.2 Feeds

  * **My Feed:** Aggregates posts from:
    1.  The current user.
    2.  Users in the `follows` list.
  * **Explore Feed:** A Graph traversal mechanism.
    1.  Fetches users followed by the people you follow (2nd degree connections).
    2.  Aggregates posts from these discovered users.
  * **Lazy Loading:** Feeds fetch the latest "Head" chunk first. Older posts are fetched via the `extendedUserState` pointer only when the user scrolls to the bottom (Infinite Scroll).

### 5.3 Interactions

  * **Posting:** Uploads media/thumbnail to IPFS (MFS/Pinning), creates Post JSON, pins it, updates UserState, and republishes IPNS.
  * **Replying:** Creates a Post object with a `referenceCID`.
  * **Follow/Unfollow:** Updates the local `follows` array in UserState and republishes IPNS.
  * **Blocking:** Block undesired content via `dislikedPostCIDs` array in UserState.

-----

## 6\. Implementation Guidelines

### 6.1 Critical Constraints

1.  **IPNS Latency:** IPNS publishing is slow (can take 30s-1min). The UI uses **Optimistic Updates** (local state reflects changes immediately) while the network operation completes in the background.
2.  **CORS:** The local Kubo node must be configured to allow CORS for the frontend origin.
3.  **PubSub Flags:** The daemon must be launched with `--enable-pubsub-experiment` (or config `Pubsub.Enabled: true`).

### 6.2 Error Handling

  * **RPC Errors:** Network failures to localhost must be caught.
  * **Stream Errors:** The PubSub stream may disconnect. The implementation must handle `AbortController` signals and JSON parse errors on malformed messages gracefully (as seen in recent debugging).
  * **Base64 Padding:** Decode logic must handle unpadded Base64 strings returned by Kubo.

-----


