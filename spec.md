# d-social — current architecture

> This replaces the old Kubo-era specification. For setup and mesh details see [README.md](README.md).

## Stack

| Layer | Role |
|--------|------|
| **Helia** (browser) | Identity (keychain → IPNS `k51…`), local UnixFS content (CIDs), local IPNS tip, pins/GC |
| **Trystero** | Online presence, tip/feed sync, media bytes (WebRTC + Nostr signaling) |
| **Public gateways** | Off by default (Settings opt-in). Cold fallback only — browser-published content is often not on the public network |

No local Kubo node. Session type is Helia-only.

## Identifiers

- **User** = IPNS name (pubkey). Routes: `/profile/:key`
- **Post / media / state head** = content CID. Routes: `/post/:cid`
- Day-to-day UI hides raw keys/CIDs; copy from sidebar **Identity & debug** or Share on a profile.

## Access model

- **Logged-in:** home / explore feeds, follows, likes, sticky shard/circle presence.
- **Guests:** single-object viewers only — `/post/:cid` and `/profile/:key`. No guest feed crawl.

## Sync model

1. Write locally to Helia; publish IPNS tip locally (network put best-effort).
2. Announce tip over Trystero; peers pull full `UserState` + recent posts + media over WebRTC.
3. Share links prefer `/post/<cid>?a=<authorIpns>`: guest pulls via author home-shard `syncPost`/`syncMedia` while the author is online (any screen). Fallback: content room `dsocial-cid/<cid>` (any peer with blocks) and want shards `dsocial-want/<shard>` that summon own/Liked/Saved holders into the content room. A like is a serve commitment (pin post + full media). Max 2 want rooms; max 1 sticky content CID while viewing.
4. Public gateways only if Settings enables fallback — do not assume they have browser-only CIDs.

## Presence

Hash-sharded rooms + follow-circles (capped sticky rooms). Default-on `dsocial-bootstrap` for stranger discovery on production hosts (Settings opt-out). Legacy global room is Settings opt-in only. Localhost also joins `dsocial-dev-local`. Content rooms are not part of the sticky identity budget except the one currently viewed CID.

## Out of scope here

Historical Kubo RPC / guest-gateway-first designs are obsolete. Guest home/explore feeds and Bitswap/DHT as gateway replacement are out of scope. Liked CIDs join want shards ephemerally (same as saved); sticky content rooms remain capped at the viewed CID. Future CRDT/full-DAG ideas are not part of the current runtime.
