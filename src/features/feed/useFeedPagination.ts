import { useCallback, useRef, useMemo } from 'react';

interface UseFeedPaginationArgs {
    followCursors: Map<string, string | null>;
    setFollowCursors: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
    fetchStateAndPosts: (cursorValue: string, authorIpns: string, isBackgroundRefresh?: boolean) => Promise<{ nextCursor: string | null; stateChunk: any } | null>;
    setIsLoadingFeed: (loading: boolean) => void;
}

export const useFeedPagination = ({
    followCursors,
    setFollowCursors,
    fetchStateAndPosts,
    setIsLoadingFeed
}: UseFeedPaginationArgs) => {
    
    const cursorOffset = useRef(0); // Track round-robin position

    const loadMoreMyFeed = useCallback(async () => {
        setIsLoadingFeed(true);
        // Process active cursors with Round-Robin to prevent starvation
        const BATCH_SIZE = 20; 
        
        const cursorArray = Array.from(followCursors.entries()).filter(([_, cursor]) => cursor !== null && cursor !== undefined) as [string, string][];
        
        if (cursorArray.length === 0) {
            setIsLoadingFeed(false);
            return;
        }

        // Circular Slice
        const total = cursorArray.length;
        let batch: [string, string][] = [];
        let currentIdx = cursorOffset.current % total;

        for (let i = 0; i < BATCH_SIZE; i++) {
            batch.push(cursorArray[currentIdx]);
            currentIdx = (currentIdx + 1) % total;
            // Break if we've covered everyone
            if (batch.length === total) break;
        }

        // Advance offset for next time
        cursorOffset.current = currentIdx;

        const newCursors = new Map<string, string | null>();
        
        const batchPromises = batch.map(async ([ipnsKey, cursorVal]) => {
             const result = await fetchStateAndPosts(cursorVal, ipnsKey, false);
             if (result) {
                 newCursors.set(ipnsKey, result.nextCursor);
             } else {
                 newCursors.set(ipnsKey, null); 
             }
        });

        await Promise.allSettled(batchPromises);

        setFollowCursors(prev => {
            const next = new Map(prev);
            newCursors.forEach((val, key) => next.set(key, val));
            return next;
        });

        setIsLoadingFeed(false);
    }, [followCursors, fetchStateAndPosts, setFollowCursors, setIsLoadingFeed]);


    const canLoadMoreMyFeed = useMemo(() => {
        for (const val of followCursors.values()) {
            if (val !== null && val !== undefined) return true;
        }
        return false;
    }, [followCursors]);

    return {
        loadMoreMyFeed,
        canLoadMoreMyFeed
    };
};
