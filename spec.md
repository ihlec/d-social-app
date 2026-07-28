# d-social — current architecture

> Fresh-start stack (no Helia/IPFS network). For setup and mesh details see [README.md](README.md).

## Stack

| Layer | Role |
|--------|------|
| **Local CAS** (IndexedDB) | Content-addressed bytes (`bafkrei…` = CIDv1 raw sha2-256), pins/GC |
| **WebCrypto identity** | ECDSA P-256; peer id = hash of SPKI; local tip pointer (replaces IPNS) |
| **Trystero** | Online presence, tip/feed sync, media bytes (WebRTC + Nostr signaling) |

No Helia, no Kubo, no public IPNS. Session type remains `helia` in storage for compatibility.

## Identifiers

- **User** = peer public id (`bafkrei…`). Routes: `/profile/:key`
- **Post / media / state head** = content CID. Routes: `/post/:cid`
- Day-to-day UI hides raw keys/CIDs; copy from sidebar **Identity & debug** or Share on a profile.

## Access model

- **Logged-in:** home / explore feeds, follows, likes, sticky shard/circle presence.
- **Guests:** single-object viewers only — `/post/:cid` and `/profile/:key`. No guest feed crawl.

## Sync model

1. Write locally to CAS; update local tip for the peer id.
2. Announce tip over Trystero; peers pull full `UserState` + recent posts + media over WebRTC.
3. Share links prefer `/post/<cid>?a=<authorId>`: guest pulls via author home-shard `syncPost`/`syncMedia` while the author is online (any screen). Fallback: content room `dsocial-cid/<cid>` and want shards `dsocial-want/<shard>`.
4. Public gateways are not part of the write path; content lives in peers’ CAS + Trystero.

## Presence

Hash-sharded rooms + follow-circles (capped sticky rooms). Default-on `dsocial-bootstrap` for stranger discovery on production hosts (Settings opt-out). Localhost also joins `dsocial-dev-local`. Meetup slots (`dsocial-meetup/<0..3>`) for time-sliced stranger collision.

## Out of scope here

Historical Kubo / Helia / Bitswap / public IPNS designs are obsolete. Old identities and UnixFS CIDs from prior builds will not resolve — treat as a fresh network.
