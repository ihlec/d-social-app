This is a comprehensive roadmap to refactor **dSocial** from a "Linked-List Snapshot" model to a "Delta State CRDT" architecture. This plan is designed to be executed in **four phases**, allowing you to maintain a working application at each stage while progressively upgrading the core engine.

### **Phase 1: The Data Foundation (The "Brain" Transplant)**

*Goal: Replace the monolithic JSON storage with an append-only Merkle Clock.*

**1. Define the Delta Schema**
Stop thinking in "States" (e.g., "The Profile") and start thinking in "Ops" (e.g., "Set Name"). Create a standardized IPLD block structure for every action.

* **Action:** Create a TypeScript interface for the Delta Block.
```typescript
interface DeltaOp {
  // The CRDT Operation
  op: "POST_CREATE" | "PROFILE_UPDATE" | "FOLLOW_ADD";
  payload: any; // e.g., { text: "Hello World", cid: "..." }

  // The Merkle Clock Metadata
  author: string; // IPNS Public Key
  timestamp: number; // Logical clock (Lamport) or Wall clock
  deps: string[]; // Array of parent Delta CIDs (The "Heads" known at creation)
}

```



**2. Implement the Local Append Log**
You need a local manager that accepts an operation and turns it into an IPFS DAG node.

* **Action:** Implement `DeltaLog.ts`.
* **Input:** User types a post.
* **Process:**
1. Fetch currently known local "Heads" (most recent Delta CIDs).
2. Construct the `DeltaOp` object with these `deps`.
3. `ipfs.dag.put(deltaOp)` to get the new CID.
4. Update local "Heads" to this new CID.
5. **Critically:** Do *not* publish to IPNS yet (batching comes later).





**3. The CRDT Reducer (The "View" Builder)**
You need a function that reads a list of Deltas and reconstructs the current state.

* **Action:** Write a pure function `reduceDeltas(existingState, newDeltas[])`.
* It iterates through deltas chronologically.
* Applies changes (e.g., adds post CID to the feed array, updates profile bio).
* *Result:* This proves you can rebuild the "Old JSON" from the "New Deltas."



---

### **Phase 2: The Sync Engine (Networking & Resolution)**

*Goal: Enable two nodes to exchange Deltas and reach consistency.*

**1. Upgrade the IPNS Pointer**

* **Change:** Your IPNS record currently points to `UserState`. Now, it must point to a **"Manifest"** block containing your current `Heads`.
* **Why:** If you made edits on two devices, you might have multiple heads (a fork). The Manifest lists them all so followers can merge them.

**2. Implement "Smart Sync" (The Fetcher)**
Replace your current "Fetch User" logic with a recursive fetcher.

* **Logic:**
1. **Resolve IPNS:** Get the remote `Heads`.
2. **Check Local:** Do I have these CIDs?
3. **Recursive Fetch:** If missing, fetch the block via IPFS. Look at its `deps`. Fetch those.
4. **Stop Condition:** Stop when you hit a CID you already have in your local cache or a Snapshot.



**3. Integration with "Race Strategy"**

* **Action:** Modify your existing 300ms Race Strategy.
* Instead of racing to get the *Content*, race to get the **Manifest (Heads)**.
* Once you have the Heads, the actual content syncing happens via Bitswap (which is naturally fast/p2p).



---

### **Phase 3: Real-Time & Discovery (The "Nervous System")**

*Goal: Make it fast (PubSub) and discoverable (DHT).*

**1. Integrate Libp2p PubSub**

* **Action:**
* On startup, `ipfs.pubsub.subscribe('/dsocial/update/' + followedUserKey)`.
* When you create a delta: `ipfs.pubsub.publish(topic, JSON.stringify({ head: newCID }))`.
* **Handler:** When receiving a message, immediately trigger the "Smart Sync" for that specific CID.



**2. Implement Reply Discovery (DHT Providers)**

* **Action:** Create a wrapper for "Posting a Reply."
* **Step A:** Create the Reply Delta (as normal).
* **Step B:** Calculate the "Rendezvous Key": `const key = sha256("replies/" + parentPostCID)`.
* **Step C:** Announce: `ipfs.dht.provide(key)`.


* **Action:** Create a "Load Comments" hook.
* `ipfs.dht.findProviders(key)` -> Get Peer IDs -> Connect -> Request their Reply CIDs.



---

### **Phase 4: Optimization & Maintenance**

*Goal: Ensure the system doesn't get slower over time.*

**1. Snapshots (Checkpointing)**

* **Problem:** After 1 year, you don't want to fetch 10,000 deltas to see a profile.
* **Solution:** Every 50 updates, the client:
1. Runs `reduceDeltas` to get the full state.
2. Saves this State JSON to IPFS.
3. Creates a special Delta of type `SNAPSHOT` that points to this JSON.
4. New followers load the Snapshot + only the Deltas *after* it.



**2. Garbage Collection Strategy**

* **Action:** Configure your IPFS repo GC.
* Pin your own Deltas (Recursive Pin on your Heads).
* Pin the "Heads" of people you follow.
* Allow IPFS to garbage collect old history blocks of friends if disk space is tight (lazy re-fetching).



---

### **Suggested Architecture Diagram**

Below is how the new flow works for a **Write** operation vs. a **Read** operation.

**Recommended Next Step:**
Start **Phase 1, Step 1**. Define that `DeltaOp` interface in your TypeScript project today. Once that data structure is solid, the rest of the logic follows naturally. Would you like me to generate the **TypeScript interface definitions** for the Delta system to get you started?