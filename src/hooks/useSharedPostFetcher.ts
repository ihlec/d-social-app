import { useCallback, useRef } from 'react';
import { Post, UserProfile } from '../types';
import { fetchPost, resolveIpns, fetchUserState } from '../api/ipfsIpns'; 
import { shouldSkipRequest, reportFetchFailure, reportFetchSuccess } from '../lib/fetchBackoff';

interface ParentFetcherArgs {
    allPostsMap: Map<string, Post>;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    userProfilesMap: Map<string, UserProfile>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
}

export const useParentPostFetcher = ({
    allPostsMap,
    setAllPostsMap,
    userProfilesMap,
    setUserProfilesMap
}: ParentFetcherArgs) => {

    const pendingRequests = useRef<Set<string>>(new Set());

    const fetchMissingParentPost = useCallback(async (parentCID: string) => {
        if (!parentCID || allPostsMap.has(parentCID)) return;
        if (pendingRequests.current.has(parentCID)) return;
        if (shouldSkipRequest(parentCID)) return;

        pendingRequests.current.add(parentCID);

        try {
            const postData = await fetchPost(parentCID);
            if (postData && postData.id) {
                setAllPostsMap(prev => new Map(prev).set(postData.id, postData as Post));
                reportFetchSuccess(parentCID);

                const authorKey = postData.authorKey;
                if (authorKey && !userProfilesMap.has(authorKey)) {
                     try {
                        const profileCid = await resolveIpns(authorKey);
                        if (profileCid) {
                            const state = await fetchUserState(profileCid, authorKey);
                            if (state.profile) {
                                setUserProfilesMap(prev => new Map(prev).set(authorKey, state.profile));
                            }
                        }
                     } catch { /* ignore */ }
                }
            } else {
                reportFetchFailure(parentCID);
            }
        } catch {
            reportFetchFailure(parentCID);
        } finally {
            pendingRequests.current.delete(parentCID);
        }
    }, [allPostsMap, setAllPostsMap, userProfilesMap, setUserProfilesMap]);

    return { fetchMissingParentPost };
};
