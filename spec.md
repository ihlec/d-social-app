Based on our entire discussion and the documented iterations, here is the exhaustive `SPECIFICATION.md` file for your project. This document serves as the "single source of truth" for the application's architecture, logic, and requirements.

---

# **Project Specification: Decentralized Social Media (dSocial)**

**Version:** 1.0.0
**Status:** Implementation Ready
**Architecture:** Local-First / Serverless / IPFS-Based

---

## **1. Executive Summary**

dSocial is a decentralized, censorship-resistant social media application built on the InterPlanetary File System (IPFS). Unlike traditional platforms, it has no central server or database. User data is self-sovereign, stored as immutable DAG (Directed Acyclic Graph) objects, and addressed via IPNS (InterPlanetary Name System) keys.

The application runs entirely in the browser as a Single Page Application (SPA), connecting to a user's local IPFS node (Kubo) for write operations and public gateways for read-only access.

---

## **2. System Architecture**

### **2.1 Core Principles**

1. **Local-First:** The "Database" is the user's local IPFS node. The UI simply reflects the state of the network.
2. **Append-Only Log:** Data is never overwritten. Updates (new posts, follows) create new DAG objects that point to previous states, creating a verifiable history chain.
3. **Client-Side Aggregation:** There is no "Feed Server." The client application crawls the social graph in real-time to build timelines.

### **2.2 Network Topology**

* **Client (Browser):** React 18 Application.
* **Local Node (Agent):** Kubo (go-ipfs) running on `localhost:5001` (RPC) and `localhost:8080` (Gateway).
* **The Swarm:** Public IPFS Network for content replication and peer discovery.
* **Gateways:** Public entry points (`ipfs.io`, `dweb.link`) for Guest Mode access.

---

## **3. Data Models (Schema)**

The application relies on specific TypeScript interfaces representing the IPFS DAG nodes.

### **3.1 User Identity (`UserState`)**

The root object pointed to by a user's IPNS key.

```typescript
interface UserState {
  profile: {
    name: string;
    bio: string;
    avatarCid?: string;
  };
  postCIDs: string[];        // Array of Post CIDs authored by this user
  follows: { ipnsKey: string }[]; // Social Graph
  likedPostCIDs: string[];
  dislikedPostCIDs: string[];
  updatedAt: number;         // Unix Timestamp
  extendedUserState: string | null; // CID of the previous UserState (Linked List)
}

```

### **3.2 Content Unit (`Post`)**

```typescript
interface Post {
  id: string;             // The CID of this object (computed after upload)
  authorKey: string;      // IPNS Key of the creator
  content: string;        // Text body
  timestamp: number;      // Creation time
  mediaCid?: string;      // CID of attached file/image
  mediaType?: 'image' | 'video' | 'file';
  
  // Threading Logic
  referenceCID?: string;  // Parent Post CID (if reply)
  replies?: string[];     // Denormalized list of child CIDs (optimistic)
}

```

---

## **4. Technical Logic & Strategies**

### **4.1 Network Layer (Modular API Architecture)**

The network layer is organized into focused modules:

* **`src/api/session.ts`**: Session management, cookie handling, and in-memory password storage
* **`src/api/resolution.ts`**: IPNS resolution, gateway racing, and tiered caching (memory + localStorage)
* **`src/api/content.ts`**: UserState and Post fetching operations
* **`src/api/auth.ts`**: Login/logout authentication logic
* **`src/api/pubsub.ts`**: Peer discovery via IPFS PubSub
* **`src/api/kuboClient.ts`**: Low-level RPC wrapper for Kubo API calls
* **`src/api/ipfsIpns.ts`**: Barrel file that exports all API functionality

**Key Strategies:**

* **Race Strategy:** To minimize latency, fetch requests are sent to both the **Local Node** and a **Public Gateway** simultaneously.
  * *Optimization:* The Gateway request is delayed by **300ms**. If the Local Node responds fast (cache hit), the Gateway request is aborted to save bandwidth.
* **Guest Mode:** If no Local Node is detected (connection failure on port 5001), the app strictly uses Public Gateways for read-only access.

### **4.2 Resilience & Caching (`src/lib/fetchBackoff.ts`)**

* **Exponential Backoff:** Prevents retry loops on offline peers.
* *Algorithm:* `Delay = 1min * 2^(failures)`. Max: 24h.
* *Storage:* Persisted in `localStorage`.


* **Tiered Caching:**
1. **Memory (Map):** 10-minute TTL for fast UI switching.
2. **Browser Storage:** Persists "Last Known CID" for offline support.



### **4.3 Feed Generation (`src/features/feed/useFeed.ts`)**

* **Mechanism:** Client-Side Crawl.
* **Process:**
1. Load `UserState` for current user.
2. Iterate `follows` array -> Resolve IPNS for each -> Fetch their `postCIDs`.
3. **Recursive Sorting:** Sort threads by "Latest Activity" (Timestamp of the post OR its most recent descendant).



---

## **5. Application State Management**

### **5.1 Architecture**

* **Store:** React Context + `useAppStorage` Hook.
* **Mutability:** The State Object is immutable. Updates require generating a new state object and replacing the reference.

### **5.2 Authentication Logic (`src/features/auth/useAuth.ts`)**

* **Detection:** Checks for `dsocial_session` cookie on mount.
* **Rehydration:** If cookie exists, fetches `UserState` from IPFS to restore session.
* **Optimistic Login:** Sets cookie immediately on valid credentials to unblock UI while IPFS data loads.

### **5.3 Mutation Actions (`src/state/useActions.ts`)**

* **Create Post Flow:**
1. Upload Media -> Get `MediaCID`.
2. Create `Post` JSON -> Upload -> Get `PostCID`.
3. Clone `UserState` -> Prepend `PostCID` -> Upload -> Get `StateCID`.
4. **IPNS Publish:** Update IPNS Key to point to new `StateCID` (Slow, ~1 min).
5. **Optimistic UI:** Update local React State immediately.



---

## **6. UI/UX Specification**

### **6.1 Layout System**

* **Responsive Grid:**
* **Desktop:** Sidebar (Nav) | Feed (Main) | Widgets (Right)
* **Mobile:** Feed (Full Width) | Bottom Nav (Future) or Hamburger Menu.


* **Masonry Feed:** Posts are stacked dynamically based on height to eliminate gaps.

### **6.2 Components**

* **Post Item:**
* **Recursive:** Capable of rendering itself inside itself to display threaded replies (`depth` prop).
* **Context-Aware:** Renders differently for Root posts vs. Replies vs. Expanded View.


* **New Post Form:**
* **Spam Protection:** Integrates `useCooldown` hook. Displays countdown timer if user posts >1x/minute.
* **Drag & Drop:** Native HTML5 DnD for media uploads.



### **6.3 Theming**

* **Engine:** Pure CSS Variables (`src/index.css`).
* **Palette:**
* `--bg-primary`: #0f0f0f (Dark Gray)
* `--primary-color`: #3b82f6 (Blue)
* `--text-primary`: #ffffff (White)



---

## **7. Infrastructure & Requirements**

### **7.1 Development Environment**

* **Runtime:** Node.js v16+
* **Build Tool:** Vite
* **Language:** TypeScript 5.0+

### **7.2 IPFS Node Configuration (User Requirement)**

Users must run a local IPFS daemon with the following CORS headers to allow browser access:

```bash
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["http://localhost:5173", "http://127.0.0.1:5173"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'

```

### **7.3 Routing**

* **Router:** `HashRouter` (e.g., `/#/profile/k51...`).
* **Reason:** Essential for compatibility with IPFS Gateways which treat paths like `/profile` as file system directories (resulting in 404s).