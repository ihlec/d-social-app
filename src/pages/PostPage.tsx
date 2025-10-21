import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import PostComponent from '../components/Feed/Post';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { useAppState } from '../hooks/useAppState';
import { fetchPost, resolveIpns, fetchUserState } from '../lib/ipfs'; // Keep using lib directly
import { Post, UserProfile } from '../types';

// Helper to recursively fetch thread (parents + reconstruct replies)
const fetchThread = async (
    startCid: string,
    existingPosts: Map<string, Post>,
    existingProfiles: Map<string, UserProfile>
): Promise<{ postMap: Map<string, Post>, profileMap: Map<string, UserProfile> }> => {

    const postMap = new Map<string, Post>(existingPosts);
    const profileMap = new Map<string, UserProfile>(existingProfiles);
    const CIDsToFetch = new Set<string>();
    const authorsToFetch = new Set<string>();

    if (!postMap.has(startCid)) {
        CIDsToFetch.add(startCid);
    }
    const startPostInitial = postMap.get(startCid);
    if (startPostInitial?.referenceCID && !postMap.has(startPostInitial.referenceCID)) {
         CIDsToFetch.add(startPostInitial.referenceCID);
    }

    const processedCIDs = new Set<string>(existingPosts.keys());

    console.log(`[fetchThread] Starting thread fetch for ${startCid}. Initial queue size: ${CIDsToFetch.size}`);

    while (CIDsToFetch.size > 0) {
        const currentCid = CIDsToFetch.values().next().value as string;
        CIDsToFetch.delete(currentCid);
        if (processedCIDs.has(currentCid)) continue;
        processedCIDs.add(currentCid);

        console.log(`[fetchThread] Processing CID: ${currentCid}`);

        try {
            const postData = await fetchPost(currentCid);
            if (!postData || typeof postData !== 'object' || !postData.authorKey) {
                throw new Error(`Invalid or missing post data returned for CID ${currentCid}`);
            }
             // Ensure replies array exists, even if empty from fetch
             const post: Post = { ...postData, id: currentCid, replies: postData.replies || [] };
             postMap.set(currentCid, post);
             console.log(`[fetchThread] Fetched post ${currentCid}, Author: ${post.authorKey}`);

             if (post.authorKey && !profileMap.has(post.authorKey)) {
                authorsToFetch.add(post.authorKey);
                console.log(`[fetchThread] Added author ${post.authorKey} to fetch queue.`);
            }
             if (post.referenceCID && !processedCIDs.has(post.referenceCID)) {
                CIDsToFetch.add(post.referenceCID);
                 console.log(`[fetchThread] Added parent ${post.referenceCID} to fetch queue.`);
            }

        } catch (error) {
            console.error(`[fetchThread] Failed to fetch or process post ${currentCid}:`, error);
            toast.error(`Could not load part of the thread (CID: ${currentCid.substring(0,8)}...).`);
             if (!postMap.has(currentCid)) {
                 postMap.set(currentCid, { id: currentCid, authorKey: 'unknown', content: '[Content load failed]', timestamp: 0, replies: [] });
             }
        }
    }
     console.log(`[fetchThread] Finished fetching post chain. Total posts in map: ${postMap.size}`);

    if (authorsToFetch.size > 0) {
        console.log(`[fetchThread] Fetching ${authorsToFetch.size} missing author profiles...`);
        await Promise.allSettled(Array.from(authorsToFetch).map(async (authorKey) => {
            if (profileMap.has(authorKey)) return;
            try {
                const profileCid = await resolveIpns(authorKey);
                const authorState = await fetchUserState(profileCid);
                if (authorState?.profile) { profileMap.set(authorKey, authorState.profile); }
                else { profileMap.set(authorKey, { name: `Unknown (${authorKey.substring(0,6)}...)` }); }
            } catch (error) { console.warn(`[fetchThread] Failed to fetch profile for author ${authorKey}`, error); profileMap.set(authorKey, { name: `Unknown (${authorKey.substring(0,6)}...)` }); }
        }));
         console.log(`[fetchThread] Finished fetching profiles. Total profiles in map: ${profileMap.size}`);
    } else {
         console.log(`[fetchThread] No new author profiles to fetch.`);
    }

    // --- Reconstruction of Replies ---
    const finalPostMap = new Map<string, Post>();
    postMap.forEach((post, id) => {
        finalPostMap.set(id, { ...post, replies: [] }); // Initialize replies array
    });

    finalPostMap.forEach(post => {
         if (post.referenceCID) {
             const parentPost = finalPostMap.get(post.referenceCID);
             if (parentPost) {
                 // --- FIX: Ensure replies array exists before push ---
                 if (!parentPost.replies) {
                     parentPost.replies = [];
                 }
                 // --- End Fix ---
                 parentPost.replies.push(post.id);
             }
         }
     });
    console.log(`[fetchThread] Reply reconstruction complete.`);
    // --- End Reconstruction ---

    return { postMap: finalPostMap, profileMap };
};


const PostPage: React.FC = () => {
    // ... (rest of the component remains the same)
    const { cid } = useParams<{ cid: string }>();
    const navigate = useNavigate();
    const { allPostsMap: globalPostsMap, userProfilesMap: globalProfilesMap, exploreAllPostsMap, exploreUserProfilesMap, likePost, dislikePost, followUser, userState, myIpnsKey } = useAppState();
    const [threadPosts, setThreadPosts] = useState<Map<string, Post>>(new Map());
    const [threadProfiles, setThreadProfiles] = useState<Map<string, UserProfile>>(new Map());
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const initialCombinedPosts = useMemo(() => new Map([...globalPostsMap, ...exploreAllPostsMap]), [globalPostsMap, exploreAllPostsMap]);
    const initialCombinedProfiles = useMemo(() => new Map([...globalProfilesMap, ...exploreUserProfilesMap]), [globalProfilesMap, exploreUserProfilesMap]);

    useEffect(() => {
        if (!cid) { setError("No post ID provided."); setIsLoading(false); navigate("/"); return; }
        const loadThread = async () => { setIsLoading(true); setError(null); console.log(`[PostPage] Loading thread for CID: ${cid}`); try { const { postMap, profileMap } = await fetchThread(cid, initialCombinedPosts, initialCombinedProfiles); console.log(`[PostPage] Thread fetch complete. Posts: ${postMap.size}, Profiles: ${profileMap.size}`); setThreadPosts(postMap); setThreadProfiles(profileMap); if (!postMap.has(cid)) { throw new Error("Target post not found after fetch attempt."); } } catch (err) { console.error("[PostPage] Error loading post page:", err); const errorMsg = err instanceof Error ? err.message : "Failed to load post thread."; setError(errorMsg); toast.error(`Could not load post: ${errorMsg}`); } finally { setIsLoading(false); } };
        loadThread();
    }, [cid, initialCombinedPosts, initialCombinedProfiles, navigate]);

    if (isLoading) return <LoadingSpinner />;
    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;

    let displayCid = cid;
    if (displayCid && threadPosts.has(displayCid)) {
        let currentPost = threadPosts.get(displayCid);
        while (currentPost?.referenceCID && threadPosts.has(currentPost.referenceCID)) { displayCid = currentPost.referenceCID; currentPost = threadPosts.get(displayCid); if (!currentPost) break; }
    } else { return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Post not found ({cid?.substring(0,8)}...).</p></div>; }
    console.log(`[PostPage] Rendering thread starting from root CID: ${displayCid}`);

    return (
        <div className="public-view-container post-page">
            <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
            <PostComponent postId={displayCid} allPostsMap={threadPosts} userProfilesMap={threadProfiles} onViewProfile={(key) => navigate(`/profile/${key}`)} onLikePost={likePost} onDislikePost={dislikePost} currentUserState={userState} myIpnsKey={myIpnsKey} onFollowPostAuthor={followUser} />
        </div>
    );
};

export default PostPage;