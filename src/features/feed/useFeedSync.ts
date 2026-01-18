import { useCallback } from 'react';
import { UserState, Follow } from '../../types';
import { resolveIpns } from '../../api/ipfsIpns';

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
        // OPTIMIZATION: Process follows in parallel batches to avoid overwhelming gateway
        const BATCH_SIZE = 4;
        const optimisticPromises: Promise<void>[] = [];
        
        for (let i = 0; i < follows.length; i += BATCH_SIZE) {
            const batch = follows.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (follow) => {
                if (!follow.ipnsKey) return;

                // If we already have a cursor for this follow, keep it (unless reset)
                if (initialCursors.has(follow.ipnsKey)) return;

                initialCursors.set(follow.ipnsKey, null); 

                if (follow.lastSeenCid) {
                    // Pin the lastSeenCid to avoid waiting for IPNS resolution in future
                    const { pinCid } = await import('../../api/admin');
                    pinCid(follow.lastSeenCid).catch(() => {}); // Fire-and-forget, don't block
                    
                    // Start at index 0 of the last seen CID
                    const result = await fetchStateAndPosts(`${follow.lastSeenCid}|0`, follow.ipnsKey, false);
                    if (result) {
                         initialCursors.set(follow.ipnsKey, result.nextCursor);
                    }
                }
            });
            optimisticPromises.push(...batchPromises);
        }

        // ALSO: Process MY OWN feed (Self-Follow)
        if (myIpnsKey && myLatestStateCID) {
            // Treat "Me" as a followed user to ensure history is fetched
            if (!initialCursors.has(myIpnsKey) && !followCursors.has(myIpnsKey)) {
                // Pin the latest state CID to avoid waiting for IPNS resolution in future
                const { pinCid } = await import('../../api/admin');
                pinCid(myLatestStateCID).catch(() => {}); // Fire-and-forget, don't block
                
                // Initialize my cursor with current state
                const result = await fetchStateAndPosts(`${myLatestStateCID}|0`, myIpnsKey, false);
                if (result) {
                    initialCursors.set(myIpnsKey, result.nextCursor);
                } else {
                    initialCursors.set(myIpnsKey, null);
                }
            }
        }

        await Promise.allSettled(optimisticPromises);
        
        if (initialCursors.size > 0) {
            setFollowCursors(prev => new Map([...prev, ...initialCursors]));
        }
        
        setIsLoadingFeed(false); 


        // --- PHASE 2: BACKGROUND REVALIDATION (Live Update & Self-Healing) ---
        const revalidationPromises = follows.map(async (follow) => {
            if (!follow.ipnsKey) return;
            
            try {
                const realHeadCid = await resolveIpns(follow.ipnsKey);
                
                const isNameBroken = !follow.name || follow.name === follow.ipnsKey || follow.name.startsWith('k51');
                const hasNewContent = realHeadCid && realHeadCid !== follow.lastSeenCid;

                if (realHeadCid && (hasNewContent || isNameBroken)) {
                    console.log(`[Feed] Repairing/Updating ${follow.ipnsKey}...`);
                    
                    // Fetch new head
                    const result = await fetchStateAndPosts(`${realHeadCid}|0`, follow.ipnsKey, true);
                    
                    if (result) {
                        // Reset cursor to the new head
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
        });

        Promise.allSettled(revalidationPromises).then(() => {
             if (followsToUpdate.length > 0) {
                 console.log(`[Feed] Background revalidation complete. Queuing ${followsToUpdate.length} stale follow pointers.`);
                 updateFollowMetadata(followsToUpdate);
             } else {
                 console.log("[Feed] Background revalidation complete. No updates needed.");
             }
        });

    }, [setFollowCursors, fetchStateAndPosts, setUnresolvedFollows, updateFollowMetadata, myIpnsKey, myLatestStateCID, followCursors, setIsLoadingFeed]);

    return { processMainFeed };
};
