import { useCallback, useEffect, useRef } from 'react';
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
    const postsMapRef = useRef(allPostsMap);
    const profilesMapRef = useRef(userProfilesMap);

    useEffect(() => {
        postsMapRef.current = allPostsMap;
    }, [allPostsMap]);

    useEffect(() => {
        profilesMapRef.current = userProfilesMap;
    }, [userProfilesMap]);

    const fetchMissingParentPost = useCallback(async (parentCID: string) => {
        const walk = async (cid: string) => {
            if (!cid) return;
            if (postsMapRef.current.has(cid)) return;
            if (pendingRequests.current.has(cid)) return;
            if (shouldSkipRequest(cid)) return;

            pendingRequests.current.add(cid);

            try {
                const postData = await fetchPost(cid);
                if (postData && postData.id) {
                    setAllPostsMap((prev) => new Map(prev).set(postData.id, postData as Post));
                    postsMapRef.current = new Map(postsMapRef.current).set(postData.id, postData as Post);
                    reportFetchSuccess(cid);

                    const authorKey = postData.authorKey;
                    if (authorKey && !profilesMapRef.current.has(authorKey)) {
                        try {
                            const profileCid = await resolveIpns(authorKey);
                            if (profileCid) {
                                const state = await fetchUserState(profileCid, authorKey);
                                if (state.profile) {
                                    setUserProfilesMap((prev) =>
                                        new Map(prev).set(authorKey, state.profile)
                                    );
                                }
                            }
                        } catch { /* ignore */ }
                    }

                    // Walk full parent chain so follow-replies can promote the true root
                    if (postData.referenceCID) {
                        await walk(postData.referenceCID);
                    }
                } else {
                    reportFetchFailure(cid);
                }
            } catch {
                reportFetchFailure(cid);
            } finally {
                pendingRequests.current.delete(cid);
            }
        };

        await walk(parentCID);
    }, [setAllPostsMap, setUserProfilesMap]);

    return { fetchMissingParentPost };
};
