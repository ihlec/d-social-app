import { useCallback } from 'react';
import { UserState, Follow } from '../../types';
import { resolveIpns } from '../../api/ipfsIpns';
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
}

export const useFeedSync = ({
    fetchStateAndPosts,
    setFollowCursors,
    followCursors,
    setUnresolvedFollows,
    updateFollowMetadata,
    myIpnsKey,
    myLatestStateCID,
    setIsLoadingFeed
}: UseFeedSyncArgs) => {

    const processMainFeed = useCallback(async (currentState: UserState) => {
        if (!currentState || !currentState.follows) return;
        setIsLoadingFeed(true);

        const follows = currentState.follows || [];
        const initialCursors = new Map<string, string | null>();
        const followsToUpdate: Follow[] = [];
        
        console.log(`[Feed] Processing ${follows.length} follows using Stale-While-Revalidate...`);

        // --- PHASE 1: INSTANT RENDER (Optimistic) ---
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

        // --- PHASE 2: BACKGROUND REVALIDATION (TTL-gated, batched) ---
        const needsRevalidate = follows.filter(f => f.ipnsKey && !shouldSkipIpnsRevalidate(f.ipnsKey));
        console.log(`[Feed] Phase 2: revalidating ${needsRevalidate.length}/${follows.length} follows (TTL skip applied)`);

        for (let i = 0; i < needsRevalidate.length; i += BATCH_SIZE) {
            const batch = needsRevalidate.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(batch.map(async (follow) => {
                if (!follow.ipnsKey) return;
                
                try {
                    const realHeadCid = await resolveIpns(follow.ipnsKey);
                    markIpnsRevalidated(follow.ipnsKey);
                    
                    const isNameBroken = !follow.name || follow.name === follow.ipnsKey || follow.name.startsWith('k51');
                    const hasNewContent = realHeadCid && realHeadCid !== follow.lastSeenCid;

                    if (realHeadCid && (hasNewContent || isNameBroken)) {
                        console.log(`[Feed] Repairing/Updating ${follow.ipnsKey}...`);
                        
                        const result = await fetchStateAndPosts(`${realHeadCid}|0`, follow.ipnsKey, true);
                        
                        if (result) {
                            setFollowCursors(prev => new Map(prev).set(follow.ipnsKey, result.nextCursor));
                        }

                        const foundName = result?.stateChunk?.profile?.name;
                        
                        if (foundName && (foundName !== follow.name || hasNewContent)) {
                            followsToUpdate.push({
                                ...follow,
                                lastSeenCid: realHeadCid,
                                updatedAt: Date.now(),
                                name: foundName 
                            });
                        }

                    } else if (!realHeadCid) {
                         setUnresolvedFollows(prev => [...prev, follow.ipnsKey]);
                    }
                } catch (e) {
                    // Ignore background errors
                }
            }));
        }

        if (followsToUpdate.length > 0) {
            console.log(`[Feed] Background revalidation complete. Queuing ${followsToUpdate.length} stale follow pointers.`);
            updateFollowMetadata(followsToUpdate);
        } else {
            console.log("[Feed] Background revalidation complete. No updates needed.");
        }

    }, [setFollowCursors, fetchStateAndPosts, setUnresolvedFollows, updateFollowMetadata, myIpnsKey, myLatestStateCID, followCursors, setIsLoadingFeed]);

    return { processMainFeed };
};
