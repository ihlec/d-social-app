# D. Social App 

A decentralized social media proof-of-concept built with React, TypeScript, a browser Helia node, and Trystero peer sync.

## Architecture (how it actually works)

| Layer | Role |
|--------|------|
| **Helia** | Identity (keychain → IPNS name), local content-addressed storage (UnixFS CIDs), local IPNS tip, pins/GC |
| **Trystero** | Online presence, tip/feed sync, media bytes between peers (WebRTC + Nostr signaling) |
| **Public gateways** | **Off by default** (Settings opt-in). Cold fallback only — browser-published content is often **not** on the public IPFS network yet |

**Feeds** (home / explore) require login. **Guests** can open a single share link: `/post/:cid` (per-CID Trystero content room) or `/profile/:key` (author home-shard rendezvous). Default fetch path is Helia → Trystero P2P.

Day-to-day UX hides raw CIDs / IPNS keys (copy from **Identity & debug** in the sidebar, or Share on a profile). Internally, users are still IPNS keys and posts/media are still CIDs.

**Session:** login is persisted in `localStorage` (plus a cookie backup). Refresh or reopening the tab restores your Helia identity; Logout clears it. Passphrase logins stay locked until you unlock after a reload.

## I have an identity, what now?

-> Join a Social Network with it OR just use it for blogging. 

You can find the latest version of D. Social App here: https://ipfs.io/ipns/k51qzi5uqu5dl65eg14adz5ceu6k9dna2s55io6iyr1qpyd1wwxqf2g7wm3tf8

## You want to contribute?

-> Read [spec.md](spec.md) (current Helia + Trystero architecture) and this README.

## Getting Started

1.  **Install Dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

2.  **Run Development Server:**
    ```bash
    npm run dev
    ```
    This will start the Vite development server, typically at `http://localhost:5173`.

    **Helia:** identity + local CAS (no Kubo required). Watch for `[Helia] Browser node ready`.
    **Trystero:** use two browsers on localhost (dev room) or follow each other — that is the live sync path.

3.  **Build for Production:**
    ```bash
    npm run build
    ```
    This creates a `dist` folder with the optimized production build.

## Key Technologies

* React
* TypeScript
* Vite
* React Router DOM
* React Hot Toast (for notifications)
* Masonic (masonry feed layout)
* Helia (browser IPFS: storage + identity)
* Trystero (WebRTC + Nostr: online presence / feed + media sync)

## Online presence (cluster of clusters)

Presence is **not** one global WebRTC mesh. Each peer joins a capped set of rooms (default **≤ 8 sticky rooms**):

* a **home shard** and **neighbor shards** derived from `hash(ipnsKey) % NUM_SHARDS`
* a **follow-circle** room (ego + capped follow circles)
* optional **affinity channels** from Settings

Mapped peers per room are capped (~**32**). `syncFeed` may temporarily join another peer’s home shard, then leave. Explore seeds from follows plus peers already seen in joined rooms — not a global online directory.

**Legacy global room** (`dsocial-peers-v1`) is **off by default**. It cannot scale to ~100k concurrent online users. Opt in only via Settings (“Join legacy global peer room”) for migration or local debugging. Cross-shard discovery should use follow-circles or on-demand home-shard joins.

**Localhost testing:** on `localhost` / `127.0.0.1`, peers also join `dsocial-dev-local` so two browsers on the same machine can meet without mutual follows or the global v1 room. Production hosts do not join that topic.

**Signaling relays** are configurable in Settings (`custom_nostr_relays`). They only carry Trystero signaling; content and presence payloads stay on peer WebRTC. Run or use community Nostr relays — the app does not depend on a single operator. Defaults ship with several public relays for bootstrap.

**TURN** defaults to public Open Relay for ICE when direct WebRTC fails (see Settings). Override with your own servers JSON, or set `[]` / `off` to disable.

**Share links:** copy Share to get `/#/post/<cid>?a=<authorIpns>`. Guests load from (1) author home shard if the author is online anywhere in the app, (2) content room `dsocial-cid/<cid>` (any peer with the blocks), (3) want shards `dsocial-want/<0..31>` that summon holders with **own** or **Saved** CIDs into the content room — post UI need not be open. Likes do not auto-serve. At most 2 want rooms per holder; content sticky ≤ 1 viewed CID.

**Mesh debug:** set `localStorage.dsocial_debug_mesh = '1'` or open with `?debugMesh=1`, then inspect `window.__dsocialMesh` (sticky topics, `contentTopics`, peers/room, sync ok/fail). Console snapshots log every 30s.

### Quick two-browser check (bridge off)

1. Open the app in two browsers with legacy bridge **unchecked** (default). Use `?debugMesh=1`.
2. Confirm `window.__dsocialMesh.stickyTopics` has **no** `dsocial-peers-v1` and length ≤ 8.
3. In browser A, follow browser B (paste ID from **Identity & debug**, or a profile link). Wait for presence / Explore seed.
4. Optional: enable legacy bridge in Settings on both, reload — you should see `dsocial-peers-v1` in sticky topics (migration escape hatch only).

### Guest share-link check

1. Logged-in browser A: stay on the **home feed** (do not open the post). Copy Share on a post you authored (URL includes `?a=`).
2. Logged-out browser B: open that link (gateways left off).
3. Post + media should arrive via author home-shard P2P without A having the post open.
4. Optional: A offline, B has Saved the post and is online on the feed — guest bare/share link should still load after want summons B.

## TODO
- following not possible when on public gateway hosted url (guest / no Helia write path)
- allow creating user aliases
- export/import of user's private key
- moderator features / filter disliked posts of followed users in the role of moderators
- scale through users - the more users cache (view) and pin (like) content, the faster the network will become.
