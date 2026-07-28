import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Post, UserProfile } from '../types';
import { fetchPost } from '../api/ipfsIpns';
import { isPeerId } from '../lib/utils';
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
    globalProfilesMap: Map<string, UserProfile>,
    /** Author peer id from share link `?a=` — enables home-shard fetch without post UI open. */
    authorHint?: string
) => {
    const [data, setData] = useState<ThreadData>({
        threadPosts: new Map(),
        threadProfiles: new Map(),
        isLoading: true,
        error: null,
    });

    const isMounted = useRef(true);
    const loadGen = useRef(0);
    const globalPostsRef = useRef(globalPostsMap);
    const globalProfilesRef = useRef(globalProfilesMap);
    globalPostsRef.current = globalPostsMap;
    globalProfilesRef.current = globalProfilesMap;

    const loadThread = useCallback(async () => {
        if (!displayCid) return;

        const gen = ++loadGen.current;
        const stillCurrent = () => isMounted.current && loadGen.current === gen;
        const author = isPeerId(authorHint) ? authorHint!.trim() : undefined;

        setData((prev) => ({ ...prev, isLoading: true, error: null }));

        const localPosts = new Map<string, Post>();
        const localProfiles = new Map<string, UserProfile>();
        const cidsToFetch = new Set<string>([displayCid]);
        const authorsToFetch = new Set<string>();
        const processedCids = new Set<string>();

        try {
            while (cidsToFetch.size > 0) {
                if (!stillCurrent()) return;

                const currentCid = cidsToFetch.values().next().value as string;
                cidsToFetch.delete(currentCid);

                if (processedCids.has(currentCid)) continue;
                processedCids.add(currentCid);

                let post = globalPostsRef.current.get(currentCid) || localPosts.get(currentCid);

                // Local CAS → author home-shard → content room (if already joined) → optional gateway
                if (!post) {
                    try {
                        const fetched = await fetchPost(currentCid, author);
                        if (fetched && fetched.id) {
                            post = fetched as Post;
                        }
                    } catch {
                        console.warn(`[useThreadFetcher] Failed to fetch ${currentCid}`);
                    }
                }

                // Content room may join after fetchPost's isContentRoomJoined check (PostPage sticky).
                // Only pay this path when the room was not already joined during fetchPost.
                if (!post) {
                    try {
                        const {
                            isContentRoomJoined,
                            requestContentPost,
                            publishContentWant,
                        } = await import('../api/pubsub');
                        void publishContentWant(currentCid);
                        if (!isContentRoomJoined(currentCid)) {
                            for (let i = 0; i < 8 && !isContentRoomJoined(currentCid); i++) {
                                await new Promise((r) => setTimeout(r, 250));
                                if (!stillCurrent()) return;
                            }
                            const p2p = await requestContentPost(currentCid);
                            if (p2p?.id) post = p2p;
                        }
                    } catch (e) {
                        console.debug(
                            `[useThreadFetcher] content-room miss ${currentCid.slice(0, 12)}`,
                            e
                        );
                    }
                }

                if (post) {
                    localPosts.set(post.id, post);
                    if (post.authorKey) authorsToFetch.add(post.authorKey);
                    else if (author) authorsToFetch.add(author);

                    if (post.referenceCID) {
                        cidsToFetch.add(post.referenceCID);
                    }
                }
            }

            if (!stillCurrent()) return;

            for (const authorKey of authorsToFetch) {
                if (!stillCurrent()) return;
                if (globalProfilesRef.current.has(authorKey)) {
                    localProfiles.set(authorKey, globalProfilesRef.current.get(authorKey)!);
                } else {
                    try {
                        const profile = await fetchUserProfile(authorKey);
                        if (profile) localProfiles.set(authorKey, profile);
                    } catch {
                        /* ignore */
                    }
                }
            }

            if (stillCurrent()) {
                setData({
                    threadPosts: localPosts,
                    threadProfiles: localProfiles,
                    isLoading: false,
                    error: localPosts.has(displayCid) ? null : 'Post not found',
                });
            }
        } catch (err) {
            console.error('Thread load failed', err);
            if (stillCurrent()) {
                setData((prev) => ({
                    ...prev,
                    isLoading: false,
                    error: 'Failed to load conversation.',
                }));
                toast.error('Could not load thread.');
            }
        }
    }, [displayCid, authorHint]);

    useEffect(() => {
        isMounted.current = true;
        loadThread();
        return () => {
            isMounted.current = false;
            loadGen.current += 1;
        };
    }, [loadThread]);

    return {
        ...data,
        reloadThread: loadThread,
    };
};
