import { useCallback, useRef } from 'react';
import { UserState, Follow, OnlinePeer, Post, UserProfile } from '../../types';
import { resolveIpns, requestPeerFeed } from '../../api/ipfsIpns';
import type { PeerFeedSnapshot } from '../../api/pubsub';
import { FEED_FOLLOW_BATCH_SIZE } from '../../constants';
import { shouldSkipIpnsRevalidate, markIpnsRevalidated } from '../../lib/ipnsRevalidate';

interface UseFeedSyncArgs {
    fetchStateAndPosts: (cursorValue: string, authorIpns: string, isBackgroundRefresh?: boolean) => Promise<{ nextCursor: string | null; stateChunk: any } | null>;
    setFollowCursors: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
    followCursors: Map<string, string | null>;
    setUnresolvedFollows: React.Dispatch<React.SetStateAction<string[]>>;
    updateFollowMetadata: (updatedFollows: Follow[]) => Promise<void>;
    myIpnsKey: string;
    myLatestStateCID: string;
    setIsLoadingFeed: (loading: boolean) => void;
    /** Online peers for P2P tip resolve before public IPNS. */
    otherUsers: OnlinePeer[];
    /** Apply syncFeed state/posts immediately (do not discard snapshot). */
    ingestPeerFeed?: (ipnsKey: string, snap: PeerFeedSnapshot) => Promise<void> | void;
}

export const useFeedSync = ({
    fetchStateAndPosts,
    setFollowCursors,
    followCursors,
    setUnresolvedFollows,
    updateFollowMetadata,
    myIpnsKey,
    myLatestStateCID,
    setIsLoadingFeed,
    otherUsers,
    ingestPeerFeed,
}: UseFeedSyncArgs) => {
    const otherUsersRef = useRef(otherUsers);
    otherUsersRef.current = otherUsers;
    const ingestRef = useRef(ingestPeerFeed);
    ingestRef.current = ingestPeerFeed;

    const processMainFeed = useCallback(async (currentState: UserState) => {
        if (!currentState || !currentState.follows) return;
        setIsLoadingFeed(true);

        const follows = currentState.follows || [];
        const initialCursors = new Map<string, string | null>();
        const followsToUpdate: Follow[] = [];
        
        console.debug(`[Feed] Processing ${follows.length} follows using Stale-While-Revalidate...`);

        // Await each batch so concurrency stays bounded
        const BATCH_SIZE = FEED_FOLLOW_BATCH_SIZE;
        
        for (let i = 0; i < follows.length; i += BATCH_SIZE) {
            const batch = follows.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(batch.map(async (follow) => {
                if (!follow.ipnsKey) return;

                if (initialCursors.has(follow.ipnsKey)) return;

                initialCursors.set(follow.ipnsKey, null); 

                if (follow.lastSeenCid) {
                    const { pinCid } = await import('../../api/admin');
                    pinCid(follow.lastSeenCid).catch(() => {});
                    
                    const result = await fetchStateAndPosts(`${follow.lastSeenCid}|0`, follow.ipnsKey, false);
                    if (result) {
                         initialCursors.set(follow.ipnsKey, result.nextCursor);
                    }
                }
            }));

            // Flush cursors incrementally so UI can update between batches
            if (initialCursors.size > 0) {
                setFollowCursors(prev => new Map([...prev, ...initialCursors]));
            }
        }

        // ALSO: Process MY OWN feed (Self-Follow)
        if (myIpnsKey && myLatestStateCID) {
            if (!initialCursors.has(myIpnsKey) && !followCursors.has(myIpnsKey)) {
                const { pinCid } = await import('../../api/admin');
                pinCid(myLatestStateCID).catch(() => {});
                
                const result = await fetchStateAndPosts(`${myLatestStateCID}|0`, myIpnsKey, false);
                if (result) {
                    initialCursors.set(myIpnsKey, result.nextCursor);
                } else {
                    initialCursors.set(myIpnsKey, null);
                }
            }
        }

        if (initialCursors.size > 0) {
            setFollowCursors(prev => new Map([...prev, ...initialCursors]));
        }
        
        setIsLoadingFeed(false); 

        const needsRevalidate = follows.filter(f => f.ipnsKey && !shouldSkipIpnsRevalidate(f.ipnsKey));
        console.debug(`[Feed] Phase 2: revalidating ${needsRevalidate.length}/${follows.length} follows (TTL skip applied)`);

        for (let i = 0; i < needsRevalidate.length; i += BATCH_SIZE) {
            const batch = needsRevalidate.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(batch.map(async (follow) => {
                if (!follow.ipnsKey) return;
                
                try {
                    // Prefer Trystero tip when the follow is online (public IPNS often missing).
                    let realHeadCid: string | null = null;
                    let tipFromP2p = false;
                    let p2pSnap: PeerFeedSnapshot | null = null;
                    const online = otherUsersRef.current.find((u) => u.ipnsKey === follow.ipnsKey);

                    if (online) {
                        let p2p = await requestPeerFeed(follow.ipnsKey);
                        if (!p2p?.ok) {
                            for (let attempt = 0; attempt < 2 && !p2p?.ok; attempt++) {
                                await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
                                p2p = await requestPeerFeed(follow.ipnsKey);
                            }
                        }
                        if (p2p?.ok && (p2p.stateCid || p2p.state)) {
                            tipFromP2p = true;
                            p2pSnap = p2p;
                            realHeadCid = p2p.stateCid || online.stateCid || null;
                            // Apply full snapshot — do not wait for state-CID Helia/gateway reload
                            if (ingestRef.current) {
                                await ingestRef.current(follow.ipnsKey, p2p);
                            }
                        } else if (online.stateCid) {
                            tipFromP2p = true;
                            realHeadCid = online.stateCid;
                        }
                    }

                    if (!realHeadCid) {
                        realHeadCid = await resolveIpns(follow.ipnsKey);
                    }
                    markIpnsRevalidated(follow.ipnsKey);
                    
                    const isNameBroken = !follow.name || follow.name === follow.ipnsKey || follow.name.startsWith('k51');
                    const hasNewContent = !!realHeadCid && realHeadCid !== follow.lastSeenCid;
                    const p2pName = p2pSnap?.state?.profile?.name;

                    if (realHeadCid && (hasNewContent || isNameBroken || tipFromP2p)) {
                        console.debug(`[Feed] Repairing/Updating ${follow.ipnsKey}${tipFromP2p ? ' (P2P tip)' : ''}...`);
                        
                        // Supplement with Helia/gateway only when useful; P2P already ingested
                        const result = await fetchStateAndPosts(`${realHeadCid}|0`, follow.ipnsKey, true);
                        
                        if (result) {
                            setFollowCursors(prev => new Map(prev).set(follow.ipnsKey, result.nextCursor));
                        } else if (p2pSnap?.state?.postCIDs?.length) {
                            // Pagination can continue from local map; mark author cursor exhausted for now
                            setFollowCursors(prev => new Map(prev).set(follow.ipnsKey, null));
                        }

                        const foundName = result?.stateChunk?.profile?.name || p2pName;
                        
                        if (foundName && (foundName !== follow.name || hasNewContent)) {
                            followsToUpdate.push({
                                ...follow,
                                lastSeenCid: realHeadCid,
                                updatedAt: Date.now(),
                                name: foundName 
                            });
                        } else if (hasNewContent || (tipFromP2p && realHeadCid !== follow.lastSeenCid)) {
                            followsToUpdate.push({
                                ...follow,
                                lastSeenCid: realHeadCid,
                                updatedAt: Date.now(),
                            });
                        } else if (tipFromP2p && p2pName && p2pName !== follow.name) {
                            followsToUpdate.push({
                                ...follow,
                                lastSeenCid: realHeadCid || follow.lastSeenCid,
                                updatedAt: Date.now(),
                                name: p2pName,
                            });
                        }

                        setUnresolvedFollows((prev) => prev.filter((k) => k !== follow.ipnsKey));
                    } else if (!realHeadCid && !follow.lastSeenCid) {
                        // Only show pending when we have no tip at all (IPNS + P2P failed).
                        setUnresolvedFollows((prev) =>
                            prev.includes(follow.ipnsKey) ? prev : [...prev, follow.ipnsKey]
                        );
                    } else if (!realHeadCid && follow.lastSeenCid) {
                        // Stale tip still usable — do not keep the orange banner.
                        setUnresolvedFollows((prev) => prev.filter((k) => k !== follow.ipnsKey));
                    }
                } catch (e) {
                    // Ignore background errors
                }
            }));
        }

        if (followsToUpdate.length > 0) {
            console.debug(`[Feed] Background revalidation complete. Queuing ${followsToUpdate.length} stale follow pointers.`);
            updateFollowMetadata(followsToUpdate);
        } else {
            console.debug("[Feed] Background revalidation complete. No updates needed.");
        }

    }, [setFollowCursors, fetchStateAndPosts, setUnresolvedFollows, updateFollowMetadata, myIpnsKey, myLatestStateCID, followCursors, setIsLoadingFeed]);

    return { processMainFeed };
};

/** Shared helper: merge a PeerFeedSnapshot into post/profile maps. */
export function mergePeerFeedIntoMaps(
    ipnsKey: string,
    snap: PeerFeedSnapshot,
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>,
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>,
): void {
    if (snap.state?.profile) {
        setUserProfilesMap((prev) => new Map(prev).set(ipnsKey, snap.state!.profile!));
    }
    if (snap.posts?.length) {
        setAllPostsMap((prev) => {
            const next = new Map(prev);
            for (const p of snap.posts) {
                if (p?.id && p.timestamp !== 0) {
                    next.set(p.id, { ...p, authorKey: p.authorKey || ipnsKey });
                }
            }
            return next;
        });
    }
}
