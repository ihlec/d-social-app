# D. Social App 

A decentralized social media proof-of-concept built with React, TypeScript, a thin local CAS (IndexedDB), WebCrypto identities, and Trystero peer sync.

## Architecture (how it actually works)

| Layer | Role |
|--------|------|
| **Local CAS** | Content-addressed storage in IndexedDB (`bafkrei…` CIDs), pins/GC |
| **WebCrypto identity** | ECDSA P-256 keypair; peer id = hash of public key; local tip (replaces IPNS) |
| **Trystero** | Online presence, tip/feed sync, media bytes between peers (WebRTC + Nostr signaling) |

**Feeds** (home / explore) require login. **Guests** can open a single share link: `/post/:cid` (per-CID Trystero content room) or `/profile/:key` (author home-shard rendezvous). Default fetch path is local CAS → Trystero P2P.

Day-to-day UX hides raw CIDs / peer ids (copy from **Identity & debug** in the sidebar, or Share on a profile). Internally, users are peer public ids and posts/media are content CIDs.

**Session:** login is persisted in `localStorage` (plus a cookie backup). Refresh or reopening the tab restores your identity; Logout clears it. Passphrase logins stay locked until you unlock after a reload.

**Fresh start:** this build drops Helia/IPFS network interop. Old Helia identities and UnixFS CIDs will not carry over — create a new identity.

## I have an identity, what now?

-> Join a Social Network with it OR just use it for blogging. 

You can find the latest version of D. Social App here:

| | |
|:--|:--|
| https://ipfs.io/ipfs/bafybeihz7smffb2553f6psxasq7asgb5yeiyxnnkq763cs3njre2hpr6du | <img src="assets/ipfs-app-qr.png" alt="QR code for the latest IPFS build" width="140" /> |

## You want to contribute?

-> Read [spec.md](spec.md) (current CAS + Trystero architecture) and this README.

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

    **CAS:** identity + local content store. Watch for `[CAS] Local node ready`.
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
* IndexedDB CAS + WebCrypto (storage + identity)
* Trystero (WebRTC + Nostr: online presence / feed + media sync)
* multiformats (CIDv1 raw sha2-256)

## Online presence (cluster of clusters)

Presence is **not** one unbounded WebRTC mesh. Each logged-in peer joins a capped set of rooms (default **≤ 8 sticky rooms**):

* a **home shard** and **neighbor shards** derived from `hash(ipnsKey) % NUM_SHARDS`
* a **follow-circle** room (ego + capped follow circles)
* **`dsocial-bootstrap`** — **on by default** so strangers on a shared IPFS app link find each other without follows or Settings tweaks (opt out in Settings when the network grows)
* **`dsocial-meetup/<0..3>`** — time-sliced lobby (2‑minute wall-clock slots). Everyone joins the current slot (and briefly the previous one) so strangers collide even if bootstrap is quiet; these rooms are ephemeral and outside the sticky-room budget
* optional **affinity channels** from Settings

Mapped peers per room are capped (~**32**). `syncFeed` may temporarily join another peer’s home shard, then leave. Explore seeds from follows plus peers already seen in joined rooms.

**Online Peers** in the sidebar is recent presence (about **5 minutes**). Strangers still need a shared room (`dsocial-bootstrap`, overlapping shards, or a follow circle). Follow circles are one-way unless mutual — following someone lets you hear them; they only hear you if they follow back or you share bootstrap/shards.

**Snowball explore:** syncing an online peer pulls a page of their local library (own + liked + saved posts they still hold), then Explore can page deeper through that peer and crawl authors those posts reveal — so one well-stocked peer seeds older content without the original authors being online.

**Sharing with testers:** publish the app, open the link in two browsers, **both log in** — they should meet via `dsocial-bootstrap` and/or the current `dsocial-meetup/*` slot with no other fiddling. Peer sync uses Trystero (Nostr + WebRTC) only.

**Legacy global room** (`dsocial-peers-v1`) is no longer exposed in Settings; prefer bootstrap + meetup slots.

**Localhost testing:** on `localhost` / `127.0.0.1`, peers also join `dsocial-dev-local`. Production hosts rely on `dsocial-bootstrap` instead.

**Signaling relays** are configurable in Settings (`custom_nostr_relays`). They only carry Trystero signaling; content and presence payloads stay on peer WebRTC. Run or use community Nostr relays — the app does not depend on a single operator. Defaults ship with several public relays for bootstrap.

**TURN** defaults to public Open Relay for ICE when direct WebRTC fails (see Settings). Override with your own servers JSON, or set `[]` / `off` to disable.

**Share links:** copy Share to get `/#/post/<cid>?a=<authorIpns>`. Guests load from (1) author home shard if the author is online anywhere in the app, (2) content room `dsocial-cid/<cid>` (any peer with the blocks), (3) want shards `dsocial-want/<0..31>` that summon holders with **own**, **Liked**, or **Saved** CIDs into the content room — post UI need not be open. A like is a serve commitment (pins post + full media). At most 2 want rooms per holder; content sticky ≤ 1 viewed CID.

**Mesh debug:** set `localStorage.dsocial_debug_mesh = '1'` or open with `?debugMesh=1`, then inspect `window.__dsocialMesh` (sticky topics, `contentTopics`, peers/room, sync ok/fail). Console snapshots log every 30s.

### Quick two-browser check (IPFS or localhost)

1. Open the app in two browsers/profiles. Both **log in**. Bootstrap room left on (default). Use `?debugMesh=1`.
2. Confirm `window.__dsocialMesh.stickyTopics` includes `dsocial-bootstrap` and length ≤ 8. With `?debugMesh=1`, `meetupTopics` should list the current `dsocial-meetup/<n>` lobby.
3. Testers should see each other in Explore / online peers without following. Optional: follow for circle rooms.
4. To isolate shards later: uncheck “Public bootstrap room” in Settings on both, reload — strangers stop meeting unless they follow.

### Guest share-link check

1. Logged-in browser A: stay on the **home feed** (do not open the post). Copy Share on a post you authored (URL includes `?a=`).
2. Logged-out browser B: open that link (gateways left off).
3. Post + media should arrive via author home-shard P2P without A having the post open.
4. Optional: A offline, B has Liked or Saved the post and is online on the feed — guest bare/share link should still load after want summons B.

## TODO
- following not possible when on public gateway hosted url (guest / no write path)
- allow creating user aliases
- export/import of user's private key
- moderator features / filter disliked posts of followed users in the role of moderators
- scale through users - the more users cache (view) and pin (like) content, the faster the network will become.
