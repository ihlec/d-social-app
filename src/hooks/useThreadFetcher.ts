// fileName: src/hooks/useThreadFetcher.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Post, UserProfile } from '../types';
import { fetchPost } from '../api/ipfsIpns';
import { fetchUserProfile } from '../state/stateActions';

interface ThreadData {
    threadPosts: Map<string, Post>;
    threadProfiles: Map<string, UserProfile>;
    isLoading: boolean;
    error: string | null;
}

export const useThreadFetcher = (
    displayCid: string | undefined, 
    globalPostsMap: Map<string, Post>,
    globalProfilesMap: Map<string, UserProfile>
) => {
    const [data, setData] = useState<ThreadData>({
        threadPosts: new Map(),
        threadProfiles: new Map(),
        isLoading: true,
        error: null
    });

    const isMounted = useRef(true);

    const loadThread = useCallback(async () => {
        if (!displayCid) return;
        
        setData(prev => ({ ...prev, isLoading: true, error: null }));
        
        const localPosts = new Map<string, Post>();
        const localProfiles = new Map<string, UserProfile>();
        const cidsToFetch = new Set<string>([displayCid]);
        const authorsToFetch = new Set<string>();
        const processedCids = new Set<string>();

        try {
            // Iterative fetch loop to fetch post + ancestors
            while (cidsToFetch.size > 0) {
                const currentCid = cidsToFetch.values().next().value as string;
                cidsToFetch.delete(currentCid);
                
                if (processedCids.has(currentCid)) continue;
                processedCids.add(currentCid);

                // 1. Check Global Cache first
                let post = globalPostsMap.get(currentCid) || localPosts.get(currentCid);

                // 2. Fetch if missing
                if (!post) {
                    try {
                        const fetched = await fetchPost(currentCid);
                        if (fetched && fetched.id) {
                            post = fetched as Post;
                        }
                    } catch (e) {
                        console.warn(`[useThreadFetcher] Failed to fetch ${currentCid}`);
                    }
                }

                if (post) {
                    localPosts.set(post.id, post);
                    if (post.authorKey) authorsToFetch.add(post.authorKey);
                    
                    // Add parent to queue if it exists
                    if (post.referenceCID) {
                        cidsToFetch.add(post.referenceCID);
                    }
                }
            }

            // 3. Fetch Missing Profiles
            for (const authorKey of authorsToFetch) {
                if (globalProfilesMap.has(authorKey)) {
                    localProfiles.set(authorKey, globalProfilesMap.get(authorKey)!);
                } else {
                    const profile = await fetchUserProfile(authorKey);
                    if (profile) localProfiles.set(authorKey, profile);
                }
            }

            if (isMounted.current) {
                setData({
                    threadPosts: localPosts,
                    threadProfiles: localProfiles,
                    isLoading: false,
                    error: localPosts.has(displayCid) ? null : "Post not found"
                });
            }

        } catch (err) {
            console.error("Thread load failed", err);
            if (isMounted.current) {
                setData(prev => ({ ...prev, isLoading: false, error: "Failed to load conversation." }));
                toast.error("Could not load thread.");
            }
        }
    }, [displayCid, globalPostsMap, globalProfilesMap]);

    useEffect(() => {
        isMounted.current = true;
        loadThread();
        return () => { isMounted.current = false; };
    }, [loadThread]);

    return { 
        ...data, 
        reloadThread: loadThread 
    };
};