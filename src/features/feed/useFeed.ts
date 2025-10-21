// src/hooks/useAppFeed.ts
import { useState, useCallback } from 'react'; // Removed useEffect, useRef
import toast from 'react-hot-toast';
import { Post, UserProfile, Follow, UserState } from '../../types';
import { fetchPost } from '../../api/ipfs';
import { fetchUserStateByIpns, fetchUserProfile } from './../../state/stateActions';

const MAX_FOLLOWS_PER_STATE = 10;

interface UseAppFeedArgs {
	myIpnsKey: string;
	allPostsMap: Map<string, Post>;
	userProfilesMap: Map<string, UserProfile>;
	setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
	setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
	setUnresolvedFollows: React.Dispatch<React.SetStateAction<string[]>>;
	fetchMissingParentPost: (parentCID: string) => Promise<void>;
}

export interface UseAppFeedReturn {
    isLoadingFeed: boolean;
    processMainFeed: (currentState: UserState) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[]) => Promise<void>;
}

/**
 * Manages the main user feed state and logic.
 */
export const useAppFeed = ({
	myIpnsKey,
	allPostsMap,
	userProfilesMap,
	setAllPostsMap,
	setUserProfilesMap,
	setUnresolvedFollows,
	fetchMissingParentPost,
}: UseAppFeedArgs): UseAppFeedReturn => {

	const [isLoadingFeed, setIsLoadingFeed] = useState<boolean>(false);
	const [isFetchingMissingPosts, setIsFetchingMissingPosts] = useState(false);


	const processFollowBatch = useCallback(async (
        // ... (processFollowBatch remains the same)
        batch: Follow[], localPostsMap: Map<string, Post>, onProfilesReceived: (profiles: Map<string, UserProfile>) => void, onUnresolvedReceived: (keys: string[]) => void
	): Promise<void> => {
        const profiles = new Map<string, UserProfile>(); const unresolved: string[] = []; const postFetchPromises: Promise<void>[] = []; const parentCIDsToFetch = new Set<string>();
		await Promise.all(batch.map(async (f) => {
			try {
				const state = await fetchUserStateByIpns(f.ipnsKey); if (state.profile) profiles.set(f.ipnsKey, state.profile);
				(state.postCIDs || []).filter(pc => pc && !pc.startsWith('temp-')).forEach((pc: string) => {
                    postFetchPromises.push( (async () => { try { if (!localPostsMap.has(pc) && !allPostsMap.has(pc)) { const data = await fetchPost(pc); if (data) { const post: Post = { ...data, authorKey: f.ipnsKey, id: pc }; localPostsMap.set(pc, post); if (post.referenceCID && !localPostsMap.has(post.referenceCID) && !allPostsMap.has(post.referenceCID)) { parentCIDsToFetch.add(post.referenceCID); } } } else if (allPostsMap.has(pc) && !localPostsMap.has(pc)) { localPostsMap.set(pc, allPostsMap.get(pc)!); } } catch (e) { console.warn(`Failed fetch post ${pc} for ${f.ipnsKey}:`, e); } })() );
				});
			} catch (e) { console.warn(`Failed process follow ${f.name || f.ipnsKey}`, e); unresolved.push(f.ipnsKey); }
		}));
		if (profiles.size > 0) onProfilesReceived(profiles); if (unresolved.length > 0) onUnresolvedReceived(unresolved);
        await Promise.allSettled(postFetchPromises);
        if (parentCIDsToFetch.size > 0) { console.log(`[processFollowBatch] Fetching ${parentCIDsToFetch.size} missing parent posts...`); const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) ); await Promise.allSettled(parentFetchPromises); }
	}, [fetchUserStateByIpns, allPostsMap, fetchMissingParentPost]);

	const processMainFeed = useCallback(async (currentState: UserState) => {
        // ... (processMainFeed remains the same)
        if (!currentState?.profile || !myIpnsKey) { console.warn("[processMainFeed] Invalid state or missing key, skipping."); return; } if (isLoadingFeed) { console.warn("[processMainFeed] Already loading, skipping."); return; } setIsLoadingFeed(true); console.log("[processMainFeed] Starting..."); const localPostsMap = new Map<string, Post>(); const localProfilesMap = new Map<string, UserProfile>([[myIpnsKey, currentState.profile!]]); let localUnresolved: string[] = []; const ownCIDs = (currentState.postCIDs || []).filter(c => c && !c.startsWith('temp-')); const follows = currentState.follows || []; const followBatchPromises: Promise<void>[] = []; const parentCIDsToFetch = new Set<string>(); console.log(`[processMainFeed] Processing ${ownCIDs.length} own posts and ${follows.length} follows.`); for (let i = 0; i < follows.length; i += MAX_FOLLOWS_PER_STATE) { followBatchPromises.push(processFollowBatch( follows.slice(i, i + MAX_FOLLOWS_PER_STATE), localPostsMap, pr => pr.forEach((p, k) => localProfilesMap.set(k, p)), un => localUnresolved = [...new Set([...localUnresolved, ...un])] )); } const ownPostPromises = ownCIDs.map(async (cid: string) => { try { if (!localPostsMap.has(cid) && !allPostsMap.has(cid)) { const data = await fetchPost(cid); if (data) { const post: Post = { ...data, authorKey: myIpnsKey, id: cid }; localPostsMap.set(cid, post); if (post.referenceCID && !localPostsMap.has(post.referenceCID) && !allPostsMap.has(post.referenceCID)) { parentCIDsToFetch.add(post.referenceCID); } } else { console.warn(`[processMainFeed] Own post ${cid} fetch returned no data.`); } } else if (allPostsMap.has(cid) && !localPostsMap.has(cid)) { localPostsMap.set(cid, allPostsMap.get(cid)!); } } catch (e) { console.warn(`[processMainFeed] Failed fetch own post ${cid}:`, e); } }); try { console.log(`[processMainFeed] Awaiting ${ownPostPromises.length} own post fetches and ${followBatchPromises.length} follow batch processes.`); const results = await Promise.allSettled([...ownPostPromises, ...followBatchPromises]); results.forEach((result, index) => { if (result.status === 'rejected') { console.error(`[processMainFeed] Main fetch operation ${index} failed:`, result.reason); } }); console.log(`[processMainFeed] Main fetches settled.`); if (parentCIDsToFetch.size > 0) { console.log(`[processMainFeed] Fetching ${parentCIDsToFetch.size} missing parent posts for own posts...`); const parentFetchPromises = Array.from(parentCIDsToFetch).map(cid => fetchMissingParentPost(cid) ); await Promise.allSettled(parentFetchPromises); } console.log(`[processMainFeed] Updating global state with ${localPostsMap.size} posts, ${localProfilesMap.size} profiles.`); setAllPostsMap(localPostsMap); setUserProfilesMap(localProfilesMap); setUnresolvedFollows(localUnresolved); toast.success("Feed refreshed!"); } catch (e) { console.error("[processMainFeed] Unexpected error during final processing stages:", e); toast.error("Error finalizing feed."); } finally { setIsLoadingFeed(false); console.log(`[processMainFeed] Finished. isLoadingFeed: false.`); }
	}, [ myIpnsKey, isLoadingFeed, processFollowBatch, setAllPostsMap, setUserProfilesMap, setUnresolvedFollows, allPostsMap, fetchMissingParentPost ]);


	const ensurePostsAreFetched = useCallback(async (postCids: string[]) => {
        // ... (ensurePostsAreFetched remains the same)
        if (isLoadingFeed || isFetchingMissingPosts) { console.warn("[ensurePostsAreFetched] Feed is already loading, skipping."); return; } if (!myIpnsKey) return; const missingCids = postCids.filter(cid => cid && !cid.startsWith('temp-') && !allPostsMap.has(cid)); if (missingCids.length === 0) return; console.log(`[ensurePostsAreFetched] Found ${missingCids.length} missing posts. Fetching...`, missingCids); setIsFetchingMissingPosts(true); const fetchedPosts: Post[] = []; const fetchedProfiles = new Map<string, UserProfile>(); const fetchPromises = missingCids.map(async (cid: string) => { try { const post = await fetchPost(cid); if (post && post.authorKey) { if (!userProfilesMap.has(post.authorKey)) { try { const profile = await fetchUserProfile(post.authorKey); fetchedProfiles.set(post.authorKey, profile); } catch (profileError) { console.warn(`[ensurePostsAreFetched] Failed to fetch profile for ${post.authorKey}:`, profileError); } } fetchedPosts.push({ ...post, id: cid }); } else { console.warn(`[ensurePostsAreFetched] Invalid data fetched for post ${cid}`); } } catch (error) { console.error(`[ensurePostsAreFetched] Failed to fetch post ${cid}:`, error); toast.error(`Failed to load post ${cid.substring(0, 8)}...`); } }); await Promise.allSettled(fetchPromises); if (fetchedPosts.length > 0 || fetchedProfiles.size > 0) { setAllPostsMap((prev) => { const newMap = new Map(prev); fetchedPosts.forEach(post => newMap.set(post.id, post)); return newMap; }); setUserProfilesMap((prev) => new Map([...prev, ...fetchedProfiles])); } setIsFetchingMissingPosts(false); console.log(`[ensurePostsAreFetched] Finished fetching ${fetchedPosts.length} posts.`);
	}, [ allPostsMap, myIpnsKey, userProfilesMap, setUserProfilesMap, setAllPostsMap, isLoadingFeed, isFetchingMissingPosts ]);


	return {
		isLoadingFeed: isLoadingFeed || isFetchingMissingPosts,
		processMainFeed,
		ensurePostsAreFetched
	};
};