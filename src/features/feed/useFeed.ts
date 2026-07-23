import { useState, useCallback } from 'react';
import { Post, UserProfile, UserState, Follow, OnlinePeer } from '../../types';
import { useFeedFetch } from './useFeedFetch';
import { useFeedSync, mergePeerFeedIntoMaps } from './useFeedSync';
import { useFeedPagination } from './useFeedPagination';
import type { PeerFeedSnapshot } from '../../api/pubsub';

interface UseAppFeedArgs {
    allPostsMap: Map<string, Post>;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    setUnresolvedFollows: React.Dispatch<React.SetStateAction<string[]>>;
    fetchMissingParentPost: (parentCID: string) => Promise<void>;
    followCursors: Map<string, string | null>;
    setFollowCursors: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
    updateFollowMetadata: (updatedFollows: Follow[]) => Promise<void>;
    myIpnsKey: string;
    myLatestStateCID: string;
    allUserStatesMap?: Map<string, UserState>;
    otherUsers?: OnlinePeer[];
}

export interface UseAppFeedReturn {
    isLoadingFeed: boolean;
    processMainFeed: (currentState: UserState) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<string[]>;
    loadMoreMyFeed: () => Promise<void>;
    canLoadMoreMyFeed: boolean;
}

export const useAppFeed = ({
    allPostsMap,
    setAllPostsMap,
    setUserProfilesMap,
    setUnresolvedFollows,
    fetchMissingParentPost,
    followCursors,
    setFollowCursors,
    updateFollowMetadata,
    myIpnsKey,
    myLatestStateCID,
    allUserStatesMap,
    otherUsers = [],
}: UseAppFeedArgs): UseAppFeedReturn => {
    
    const [isLoadingFeed, setIsLoadingFeed] = useState(false);

    // 1. Fetching Logic (Low Level)
    const { fetchStateAndPosts, ensurePostsAreFetched } = useFeedFetch({
        allPostsMap,
        setAllPostsMap,
        setUserProfilesMap,
        fetchMissingParentPost,
        allUserStatesMap
    });

    const ingestPeerFeed = useCallback(async (ipnsKey: string, snap: PeerFeedSnapshot) => {
        mergePeerFeedIntoMaps(ipnsKey, snap, setAllPostsMap, setUserProfilesMap);
        const cids = snap.state?.postCIDs?.slice(0, 20) || [];
        if (cids.length > 0) {
            await ensurePostsAreFetched(cids, ipnsKey);
        }
    }, [setAllPostsMap, setUserProfilesMap, ensurePostsAreFetched]);

    // 2. Sync Logic (Initial Load & Background Refresh)
    const { processMainFeed } = useFeedSync({
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
    });

    // 3. Pagination Logic (Load More)
    const { loadMoreMyFeed, canLoadMoreMyFeed } = useFeedPagination({
        followCursors,
        setFollowCursors,
        fetchStateAndPosts,
        setIsLoadingFeed
    });

    return {
        isLoadingFeed,
        processMainFeed,
        ensurePostsAreFetched,
        loadMoreMyFeed,
        canLoadMoreMyFeed
    };
};
