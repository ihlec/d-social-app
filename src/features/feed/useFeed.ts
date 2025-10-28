// fileName: src/hooks/useAppFeed.ts
import { useState, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Post, UserProfile, Follow, UserState } from '../../types';
// --- START MODIFICATION: Remove unused imports ---
import { fetchPostLocal, resolveIpns, fetchUserStateChunk } from '../../api/ipfsIpns';
// import { fetchUserStateByIpns } from './../../state/stateActions'; // <-- Removed
// --- END MODIFICATION ---

const MAX_FOLLOWS_PER_STATE = 10;
const IPNS_FETCH_TIMEOUT_MS = 5000; // 5 seconds

interface UseAppFeedArgs {
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	setUnresolvedFollows: React.Dispatch<React.SetStateAction<string[]>>;
	fetchMissingParentPost: (parentCID: string) => Promise<void>;
    followCursors: Map<string, string | null>;
    setFollowCursors: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
}

export interface UseAppFeedReturn {
    isLoadingFeed: boolean;
    processMainFeed: (currentState: UserState, myIpnsKey: string) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
    loadMoreMyFeed: () => Promise<void>;
    canLoadMoreMyFeed: boolean;
}

export const useAppFeed = ({
	allPostsMap,
	userProfilesMap,
	setAllPostsMap,
	setUserProfilesMap,
	setUnresolvedFollows,
	fetchMissingParentPost,
    followCursors,
    setFollowCursors,
}: UseAppFeedArgs): UseAppFeedReturn => {

	const [isLoadingFeed, setIsLoadingFeed] = useState<boolean>(false);

    // --- processChunkBatch remains the same ---
    const processChunkBatch = useCallback(async (
        chunksToFetch: Map<string, string>, // Map<ipnsKey, chunkCid>
        onPostsReceived: (posts: Map<string, Post>) => void,
        onCursorsReceived: (cursors: Map<string, string | null>) => void
    ): Promise<void> => {
        const newCursors = new Map<string, string | null>();
        const postFetchPromises: Promise<void>[] = [];
        const parentCIDsToFetch = new Set<string>();
        const localPostsForBatch = new Map<string, Post>();

        await Promise.all(Array.from(chunksToFetch.entries()).map(async ([ipnsKey, chunkCid]) => {
            try {
                const chunk = await fetchUserStateChunk(chunkCid);
                newCursors.set(ipnsKey, chunk.extendedUserState || null);
                (chunk.postCIDs || []).filter(pc => pc && !pc.startsWith('temp-')).forEach((pc: string) => {
                    postFetchPromises.push( (async () => {
                        try {
                            if (allPostsMap.has(pc) || localPostsForBatch.has(pc)) return;
                            const postResult = await fetchPostLocal(pc, ipnsKey);
                            if (postResult.timestamp !== 0) {
                                const finalPost = { ...postResult, authorKey: ipnsKey, id: pc };
                                localPostsForBatch.set(pc, finalPost);
                                if (finalPost.referenceCID && !allPostsMap.has(finalPost.referenceCID) && !localPostsForBatch.has(finalPost.referenceCID)) {
                                   parentCIDsToFetch.add(finalPost.referenceCID);
                                }
                            } else { console.log(`[processChunkBatch] fetchPostLocal returned placeholder for ${pc.substring(0, 10)}... (author ${ipnsKey.substring(0,6)}...), skipping.`); }
                        } catch (e) { console.warn(`[processChunkBatch] Error processing post ${pc} for ${ipnsKey}:`, e); }
                    })() );
                });
            } catch (e) {
                console.warn(`Failed to process chunk ${chunkCid} for follow ${ipnsKey}`, e);
                newCursors.set(ipnsKey, null);
            }
        }));

        if (newCursors.size > 0) onCursorsReceived(newCursors);
        await Promise.allSettled(postFetchPromises);
        if (parentCIDsToFetch.size > 0) {
            console.log(`[processChunkBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`);
            const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) );
            await Promise.allSettled(parentFetchPromises);
        }
        if (localPostsForBatch.size > 0) { onPostsReceived(localPostsForBatch); }
    }, [allPostsMap, fetchMissingParentPost]);

    // --- processFollowBatch remains the same ---
	const processFollowBatch = useCallback(async (
        batch: Follow[],
        onPostsReceived: (posts: Map<string, Post>) => void,
        onProfilesReceived: (profiles: Map<string, UserProfile>) => void,
        onUnresolvedReceived: (keys: string[]) => void,
        onCursorsReceived: (cursors: Map<string, string | null>) => void
	): Promise<void> => {
        const profiles = new Map<string, UserProfile>();
        const unresolved: string[] = [];
        const postFetchPromises: Promise<void>[] = [];
        const parentCIDsToFetch = new Set<string>();
        const localPostsForBatch = new Map<string, Post>();
        const newCursors = new Map<string, string | null>();

		await Promise.all(batch.map(async (f) => {
			try {
                let state: Partial<UserState>;
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('IPNS_TIMEOUT')), IPNS_FETCH_TIMEOUT_MS));
                const freshFetchPromise = (async () => {
                    const headCid = await resolveIpns(f.ipnsKey);
                    if (!headCid && f.lastSeenCid) {
                         console.warn(`[processFollowBatch] IPNS resolve for ${f.ipnsKey} failed. Falling back to lastSeenCid: ${f.lastSeenCid}`);
                         return await fetchUserStateChunk(f.lastSeenCid);
                    } else if (!headCid) { throw new Error(`IPNS resolve failed for ${f.ipnsKey} with no fallback CID.`); }
                    return await fetchUserStateChunk(headCid);
                })();

                try { state = await Promise.race([ freshFetchPromise, timeoutPromise as Promise<Partial<UserState>> ]); }
                catch (e) {
                    if (e instanceof Error && e.message === 'IPNS_TIMEOUT') {
                        console.warn(`[processFollowBatch] IPNS resolve/chunk fetch for ${f.ipnsKey} timed out. Falling back to lastSeenCid: ${f.lastSeenCid}`);
                        if (f.lastSeenCid) { state = await fetchUserStateChunk(f.lastSeenCid); }
                        else { throw new Error(`IPNS timeout for ${f.ipnsKey} with no fallback CID.`); }
                    } else { throw e; }
                }

                if (state.profile) profiles.set(f.ipnsKey, state.profile);
                newCursors.set(f.ipnsKey, state.extendedUserState || null);

				(state.postCIDs || []).filter(pc => pc && !pc.startsWith('temp-')).forEach((pc: string) => {
                    postFetchPromises.push( (async () => {
                        try {
                            const existingPost = allPostsMap.get(pc);
                            if (existingPost) {
                                if (existingPost.timestamp !== 0) { if (!localPostsForBatch.has(pc)) localPostsForBatch.set(pc, existingPost); }
                                return;
                            }
                            if (localPostsForBatch.has(pc)) { return; }
                            const postResult = await fetchPostLocal(pc, f.ipnsKey);
                            if (postResult.timestamp !== 0) {
                                const finalPost = { ...postResult, authorKey: f.ipnsKey, id: pc };
                                localPostsForBatch.set(pc, finalPost);
                                if (finalPost.referenceCID && !allPostsMap.has(finalPost.referenceCID) && !localPostsForBatch.has(finalPost.referenceCID)) {
                                   parentCIDsToFetch.add(finalPost.referenceCID);
                                }
                            } else { console.log(`[processFollowBatch] fetchPostLocal returned placeholder for ${pc.substring(0, 10)}... (author ${f.ipnsKey.substring(0,6)}...), skipping.`); }
                        } catch (e) { console.warn(`[processFollowBatch] Error processing post ${pc} for ${f.ipnsKey}:`, e); }
                    })() );
				});
			} catch (e) { console.warn(`Failed process follow ${f.name || f.ipnsKey}`, e); unresolved.push(f.ipnsKey); }
		}));
		if (profiles.size > 0) onProfilesReceived(profiles);
        if (unresolved.length > 0) onUnresolvedReceived(unresolved);
        if (newCursors.size > 0) onCursorsReceived(newCursors);
        await Promise.allSettled(postFetchPromises);
        if (parentCIDsToFetch.size > 0) { console.log(`[processFollowBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`); const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) ); await Promise.allSettled(parentFetchPromises); }
        if (localPostsForBatch.size > 0) { onPostsReceived(localPostsForBatch); }
	}, [allPostsMap, fetchMissingParentPost]);

    // --- lazyLoadFeed ---
    const lazyLoadFeed = useCallback(async (
        myIpnsKey: string,
        ownCidsToLazyFetch: string[],
        follows: Follow[]
    ) => {
        const processId = Date.now();
        console.log(`[lazyLoadFeed ${processId}] STAGE 2 (Lazy) Start. Fetching ${ownCidsToLazyFetch.length} own posts and ${follows.length} follows.`);
        const allLazyPromises: Promise<any>[] = [];
        let collectedUnresolved: string[] = [];
        let collectedCursors = new Map<string, string | null>();

        // --- START MODIFICATION: Fix unused variable errors ---
        for (const cid of ownCidsToLazyFetch) {
            allLazyPromises.push((async () => {
                try {
                    const existingPost = allPostsMap.get(cid);
                    // Only fetch if it's not present, or if it's a placeholder
                    if (!existingPost || existingPost.timestamp === 0) { 
                        const postResult = await fetchPostLocal(cid, myIpnsKey); // Use myIpnsKey
                        
                        if (postResult && postResult.timestamp !== 0) {
                            const finalPost = { ...postResult, authorKey: myIpnsKey, id: cid };
                            // Update the global map
                            setAllPostsMap(prev => new Map(prev).set(cid, finalPost)); 

                            // If it's a reply, fetch its parent if missing
                            if (finalPost.referenceCID && !allPostsMap.has(finalPost.referenceCID)) {
                                // Don't await, let it run in parallel
                                fetchMissingParentPost(finalPost.referenceCID);
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[lazyLoadFeed] Error processing own post ${cid}:`, e);
                }
            })());
        }
        // --- END MODIFICATION ---

        console.log(`[lazyLoadFeed ${processId}] Created ${ownCidsToLazyFetch.length} promises for own posts.`);

        if (follows.length > 0) {
            console.log(`[lazyLoadFeed ${processId}] Creating promises for ${follows.length} follows in batches...`);
            for (let i = 0; i < follows.length; i += MAX_FOLLOWS_PER_STATE) {
                allLazyPromises.push(processFollowBatch(
                    follows.slice(i, i + MAX_FOLLOWS_PER_STATE),
                    (posts: Map<string, Post>) => { setAllPostsMap(prev => new Map([...prev, ...posts])); },
                    (pr: Map<string, UserProfile>) => { setUserProfilesMap(prev => new Map([...prev, ...pr])); },
                    (un: string[]) => { collectedUnresolved = [...new Set([...collectedUnresolved, ...un])]; },
                    (cu: Map<string, string | null>) => { collectedCursors = new Map([...collectedCursors, ...cu]); }
                ));
            }
        }

        try {
            console.log(`[lazyLoadFeed ${processId}] Awaiting ${allLazyPromises.length} total lazy promises...`);
            await Promise.allSettled(allLazyPromises);
            console.log(`[lazyLoadFeed ${processId}] All lazy promises settled.`);
            setUnresolvedFollows(collectedUnresolved);
            setFollowCursors(prevCursors => new Map([...prevCursors, ...collectedCursors]));
            console.log(`[lazyLoadFeed ${processId}] Merged ${collectedCursors.size} follow cursors.`);
        } catch (e) { console.error(`[lazyLoadFeed ${processId}] Unexpected error in lazy follow processing:`, e); }
        finally { console.log(`[lazyLoadFeed ${processId}] Finished Stage 2 (lazy).`); }
    }, [allPostsMap, processFollowBatch, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, fetchMissingParentPost, setFollowCursors]);

    // --- processMainFeed remains the same ---
	const processMainFeed = useCallback(async (currentState: UserState, myIpnsKey: string) => {
        const processId = Date.now();
        console.log(`[processMainFeed ${processId}] Start processing.`);
        if (!currentState?.profile || !myIpnsKey) { console.warn(`[processMainFeed ${processId}] Invalid state or missing key, skipping.`); return; }
        if (isLoadingFeed) { console.warn(`[processMainFeed ${processId}] Already loading feed, skipping.`); return; }

        setIsLoadingFeed(true);
        console.log(`[processMainFeed ${processId}] Set isLoadingFeed = true.`);
        const postsForImmediateRender = new Map<string, Post>();
        const profilesForImmediateRender = new Map<string, UserProfile>([[myIpnsKey, currentState.profile!]]);
        const ownCidsToLazyFetch: string[] = [];
        const follows = currentState.follows || [];
        const dislikedSet = new Set(currentState.dislikedPostCIDs || []);
        const allOwnCIDs = (currentState.postCIDs || []).filter(c => c && !c.startsWith('temp-'));
        const ownCIDsToFetch = allOwnCIDs.filter(cid => !dislikedSet.has(cid));

        console.log(`[processMainFeed ${processId}] STAGE 1: Sorting ${ownCIDsToFetch.length} own posts (from head chunk).`);
        for (const cid of ownCIDsToFetch) {
            const existingPost = allPostsMap.get(cid);
            if (existingPost && existingPost.timestamp !== 0) { postsForImmediateRender.set(cid, existingPost); }
            else if (!existingPost || existingPost.timestamp === 0) {
                ownCidsToLazyFetch.push(cid);
                if (existingPost) { postsForImmediateRender.set(cid, existingPost); }
            }
        }
        console.log(`[processMainFeed ${processId}] STAGE 1: Immediate render: ${postsForImmediateRender.size} posts. Lazy fetch: ${ownCidsToLazyFetch.length} posts.`);
        setAllPostsMap(prev => new Map([...prev, ...postsForImmediateRender]));
        setUserProfilesMap(prev => new Map([...prev, ...profilesForImmediateRender]));
        setIsLoadingFeed(false);
        console.log(`[processMainFeed ${processId}] Finished Stage 1. Set isLoadingFeed = false.`);
        if (!isLoadingFeed) toast.success("Feed refreshed!");
        const ownNextChunkCid = currentState.extendedUserState;
        setFollowCursors(new Map(ownNextChunkCid ? [[myIpnsKey, ownNextChunkCid]] : []));
        lazyLoadFeed(myIpnsKey, ownCidsToLazyFetch, follows);
	}, [ isLoadingFeed, lazyLoadFeed, allPostsMap, setFollowCursors, setAllPostsMap, setUserProfilesMap ]);

    // --- ensurePostsAreFetched remains the same ---
	const ensurePostsAreFetched = useCallback(async (cidsToFetch: string[], authorHint?: string) => {
        if (isLoadingFeed && !cidsToFetch.some(cid => allPostsMap.has(cid) && allPostsMap.get(cid)?.timestamp === 0)) {
            console.warn("[ensurePostsAreFetched] Feed is loading, skipping non-placeholder fetch."); return;
        }
        const cidsToCheck = cidsToFetch.filter(cid => {
            if (!cid || cid.startsWith('temp-')) return false;
            const existingPost = allPostsMap.get(cid);
            return !existingPost || existingPost.timestamp === 0;
        });

        if (cidsToCheck.length === 0) { return; }
        console.log(`[ensurePostsAreFetched] Found ${cidsToCheck.length} missing/placeholder posts. Fetching with hint: '${authorHint}'...`, cidsToCheck);
        const fetchedPosts = new Map<string, Post>();
        const fetchedProfiles = new Map<string, UserProfile>();
        let updatedPlaceholdersCount = 0;

        const fetchPromises = cidsToCheck.map(async (cid: string) => {
             try {
                const post = await fetchPostLocal(cid, authorHint || 'unknown');
                if (!post) { console.warn(`[ensurePostsAreFetched] fetchPostLocal returned null/undefined for ${cid}`); return; }
                const author = post.authorKey || authorHint || 'unknown';
                const finalPostData = { ...post, id: cid, authorKey: author };
                fetchedPosts.set(cid, finalPostData);
                const existingPost = allPostsMap.get(cid);
                if (existingPost && existingPost.timestamp === 0 && finalPostData.timestamp !== 0) { updatedPlaceholdersCount++; }
                if (author && author !== 'unknown' && finalPostData.timestamp !== 0) {
                    if (!userProfilesMap.has(author) && !fetchedProfiles.has(author)) {
                        try {
                            const headCid = await resolveIpns(author);
                            const authorStateChunk = await fetchUserStateChunk(headCid);
                            if (authorStateChunk?.profile) { fetchedProfiles.set(author, authorStateChunk.profile); }
                            else { fetchedProfiles.set(author, { name: `Unknown (${author.substring(0, 6)}...)` }); }
                        } catch (profileError) {
                            console.warn(`[ensurePostsAreFetched] Failed to fetch profile for ${author}:`, profileError);
                             fetchedProfiles.set(author, { name: `Unknown (${author.substring(0, 6)}...)` });
                        }
                    }
                }
             } catch (error) {
                console.error(`[ensurePostsAreFetched] Failed to process post ${cid}:`, error);
                if (!fetchedPosts.has(cid)) { fetchedPosts.set(cid, { id: cid, authorKey: authorHint || 'unknown', content: '[Error loading content]', timestamp: 0, replies: [] }); }
             }
        });

        await Promise.allSettled(fetchPromises);
        if (fetchedPosts.size > 0 || fetchedProfiles.size > 0) {
            setAllPostsMap((prev) => { const newMap = new Map(prev); fetchedPosts.forEach((post, cid) => { newMap.set(cid, post); }); return newMap; });
            setUserProfilesMap((prev) => new Map([...prev, ...fetchedProfiles]));
        }
        console.log(`[ensurePostsAreFetched] Finished processing ${fetchedPosts.size} posts (updated ${updatedPlaceholdersCount} placeholders).`);
	}, [ allPostsMap, userProfilesMap, setUserProfilesMap, setAllPostsMap, isLoadingFeed ]);

    // --- canLoadMoreMyFeed and loadMoreMyFeed remain the same ---
    const canLoadMoreMyFeed = useMemo(() => {
        return Array.from(followCursors.values()).some(cid => cid !== null);
    }, [followCursors]);
    const loadMoreMyFeed = useCallback(async () => {
        if (isLoadingFeed) { console.log("[loadMoreMyFeed] Already loading feed, skipping."); return; }
        const allCursorsToFetch = Array.from(followCursors.entries()).filter(([_, cid]) => cid !== null) as [string, string][];
        if (allCursorsToFetch.length === 0) { console.log("[loadMoreMyFeed] No more chunks to load."); toast("No more posts to load.", { icon: "🏁" }); return; }

        console.log(`[loadMoreMyFeed] Loading next chunks for ${allCursorsToFetch.length} follows in batches...`);
        setIsLoadingFeed(true);
        const collectedPosts = new Map<string, Post>();
        const collectedNewCursors = new Map<string, string | null>();
        const allBatchPromises: Promise<void>[] = [];

        for (let i = 0; i < allCursorsToFetch.length; i += MAX_FOLLOWS_PER_STATE) {
            const batch = allCursorsToFetch.slice(i, i + MAX_FOLLOWS_PER_STATE);
            const batchMap = new Map(batch);
            allBatchPromises.push(
                processChunkBatch( batchMap,
                    (posts) => { posts.forEach((post, cid) => collectedPosts.set(cid, post)); },
                    (cursors) => { cursors.forEach((cid, key) => collectedNewCursors.set(key, cid)); }
                )
            );
        }

        try {
            await Promise.allSettled(allBatchPromises);
            if (collectedPosts.size > 0) { setAllPostsMap(prev => new Map([...prev, ...collectedPosts])); toast.success(`Loaded ${collectedPosts.size} new posts.`); }
            else { toast.success("Checked for new posts, feed is up to date."); }
            if (collectedNewCursors.size > 0) { setFollowCursors(prev => new Map([...prev, ...collectedNewCursors])); }
            console.log(`[loadMoreMyFeed] Finished. Loaded ${collectedPosts.size} posts, updated ${collectedNewCursors.size} cursors.`);
        } catch (e) {
            console.error("[loadMoreMyFeed] Error loading more chunks:", e); toast.error("Failed to load more posts.");
        } finally { setIsLoadingFeed(false); }
    }, [isLoadingFeed, followCursors, setFollowCursors, processChunkBatch, setAllPostsMap]);


	return {
		isLoadingFeed,
		processMainFeed,
		ensurePostsAreFetched,
        loadMoreMyFeed,
        canLoadMoreMyFeed,
	};
};