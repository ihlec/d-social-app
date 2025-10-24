// fileName: src/components/PostPage.tsx
// src/components/PostPage.tsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import PostComponent from '../features/feed/PostItem';
import LoadingSpinner from './LoadingSpinner';
import { useAppState } from '../state/useAppStorage';
import { fetchPost, resolveIpns, fetchUserState } from '../api/ipfsIpns'; // Keep using lib directly
import { Post, UserProfile, NewPostData } from '../types';
import NewPostForm from '../features/feed/NewPostForm';

// --- FIX: Update fetchThread signature ---
const fetchThread = async (
    startCid: string,
    globalPostsMap: Map<string, Post>, // Pass in the globally available posts
    globalProfilesMap: Map<string, UserProfile> // Pass in global profiles
): Promise<{ postMap: Map<string, Post>, profileMap: Map<string, UserProfile> }> => {
// --- END FIX ---
    const postMap = new Map<string, Post>();
    const profileMap = new Map<string, UserProfile>();
    const CIDsToFetch = new Set<string>();
    const authorsToFetch = new Set<string>();
    CIDsToFetch.add(startCid);
    const processedCIDs = new Set<string>();
    console.log(`[fetchThread] Starting thread fetch for ${startCid}. Initial queue size: ${CIDsToFetch.size}`);
    
    while (CIDsToFetch.size > 0) {
        const currentCid = CIDsToFetch.values().next().value as string;
        CIDsToFetch.delete(currentCid);
        
        if (processedCIDs.has(currentCid)) continue;
        processedCIDs.add(currentCid);
        
        console.log(`[fetchThread] Processing CID: ${currentCid}`);
        try {
            let postData = globalPostsMap.get(currentCid);
            if (!postData) {
                console.log(`[fetchThread] Post ${currentCid} not in global map, fetching...`);
                postData = await fetchPost(currentCid);
            } else {
                 console.log(`[fetchThread] Post ${currentCid} found in global map.`);
            }

            if (!postData || typeof postData !== 'object' || !postData.authorKey) {
                if (currentCid === startCid) {
                    console.error(`[fetchThread] Failed to fetch the root post of the thread: ${startCid}`);
                    throw new Error(`Could not load the requested post (${startCid.substring(0,8)}...).`);
                }
                throw new Error(`Invalid or missing post data returned for CID ${currentCid}`);
            }
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
            if (post.replies && post.replies.length > 0) {
                post.replies.forEach(replyCid => {
                    if (replyCid && !processedCIDs.has(replyCid)) {
                        CIDsToFetch.add(replyCid);
                        console.log(`[fetchThread] Added reply ${replyCid} (from replies array) to fetch queue.`);
                    }
                });
            }

            globalPostsMap.forEach((globalPost, globalPostId) => {
                if (globalPost.referenceCID === currentCid && !processedCIDs.has(globalPostId)) {
                    CIDsToFetch.add(globalPostId);
                    console.log(`[fetchThread] Found reply ${globalPostId} for ${currentCid} from global map scan.`);
                }
            });

        } catch (error) {
             if (currentCid === startCid && error instanceof Error) {
                 throw error; // Propagate error up if the root fails
             }
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
                // --- FIX: Check global profiles map first ---
                let profile = globalProfilesMap.get(authorKey);
                // --- END FIX ---
                if (!profile) {
                    const profileCid = await resolveIpns(authorKey);
                    const authorState = await fetchUserState(profileCid); 
                    profile = authorState?.profile;
                }
                if (profile) { profileMap.set(authorKey, profile); }
                else { profileMap.set(authorKey, { name: `Unknown (${authorKey.substring(0,6)}...)` }); }
            } catch (error) { console.warn(`[fetchThread] Failed to fetch profile for author ${authorKey}`, error); profileMap.set(authorKey, { name: `Unknown (${authorKey.substring(0,6)}...)` }); }
        }));
         console.log(`[fetchThread] Finished fetching profiles. Total profiles in map: ${profileMap.size}`);
    } else {
         console.log(`[fetchThread] No new author profiles to fetch.`);
    }
    const finalPostMap = new Map<string, Post>();
    postMap.forEach((post, id) => {
        finalPostMap.set(id, { ...post, replies: post.replies || [] });
    });
    finalPostMap.forEach(post => {
         if (post.referenceCID) {
             const parentPost = finalPostMap.get(post.referenceCID);
             if (parentPost) {
                 if (!parentPost.replies) {
                     parentPost.replies = [];
                 }
                 if (!parentPost.replies.includes(post.id)) {
                     parentPost.replies.push(post.id);
                 }
             }
         }
     });
    console.log(`[fetchThread] Reply reconstruction complete.`);
    return { postMap: finalPostMap, profileMap: profileMap };
};

interface PostPageProps {
  isModal?: boolean;
}

const PostPage: React.FC<PostPageProps> = ({ isModal = false }) => {
    const { cid } = useParams<{ cid: string }>(); // Use URL CID for fetching, even in modal
    const navigate = useNavigate();
    const {
        likePost, dislikePost, userState, myIpnsKey,
        ensurePostsAreFetched,
        addPost, isProcessing, isCoolingDown, countdown,
        allPostsMap: globalPostsMap,
        exploreAllPostsMap,
        userProfilesMap
    } = useAppState();
    const [threadPosts, setThreadPosts] = useState<Map<string, Post>>(new Map());
    const [threadProfiles, setThreadProfiles] = useState<Map<string, UserProfile>>(new Map());
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const location = useLocation();
    const canGoBack = location.key !== "default";
    const backgroundLocation = location.state?.backgroundLocation;
    const [replyingToPost, setReplyingToPost] = useState<Post | null>(null);
    const [replyingToAuthorName, setReplyingToAuthorName] = useState<string | null>(null);

    // --- FIX: Add ref for modal container ---
    const modalContainerRef = useRef<HTMLDivElement>(null);
    // --- END FIX ---

    const combinedGlobalPosts = useMemo(() => new Map([...globalPostsMap, ...exploreAllPostsMap]), [globalPostsMap, exploreAllPostsMap]);

    useEffect(() => {
        // Fetch based on URL CID always
        if (!cid) { setError("No post ID provided."); setIsLoading(false); navigate("/"); return; }
        const loadThread = async () => { setIsLoading(true); setError(null); console.log(`[PostPage] Loading thread for CID: ${cid}`); try {
            const { postMap, profileMap } = await fetchThread(cid, combinedGlobalPosts, userProfilesMap);
            console.log(`[PostPage] Thread fetch complete. Posts: ${postMap.size}, Profiles: ${profileMap.size}`); 
            setThreadPosts(postMap); 
            setThreadProfiles(new Map([...userProfilesMap, ...profileMap])); 
            if (!postMap.has(cid)) { throw new Error("Target post not found after fetch attempt."); } } catch (err) { console.error("[PostPage] Error loading post page:", err); const errorMsg = err instanceof Error ? err.message : "Failed to load post thread."; setError(errorMsg); toast.error(`Could not load post: ${errorMsg}`); } finally { setIsLoading(false); } 
            setReplyingToPost(null);
            setReplyingToAuthorName(null);
        };
        loadThread();
    }, [cid, navigate, combinedGlobalPosts, userProfilesMap]); 
 
    const handleSetReplying = (post: Post | null) => {
        if (!userState) {
          toast("Please log in to reply.", { icon: '🔒' });
          navigate('/login');
          return;
        }
        setReplyingToPost(post);
        if (post) {
            const authorProfile = threadProfiles.get(post.authorKey);
            setReplyingToAuthorName(authorProfile?.name || null);
            
            // --- FIX: Scroll modal to top ---
            if (isModal && modalContainerRef.current) {
                modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
            }
            // --- END FIX ---
        } else {
             setReplyingToAuthorName(null);
        }
    };

    const handleAddPost = (postData: NewPostData) => {
        addPost(postData);
        setReplyingToPost(null);
        setReplyingToAuthorName(null);
    };

    const handleClose = () => {
        if (backgroundLocation) {
            navigate(backgroundLocation.pathname);
        } else if (canGoBack) {
            navigate(-1);
        } else {
            navigate('/');
        }
    };
 
     const renderContent = () => {
         if (isLoading) return <LoadingSpinner />;
         if (error) return <div className="public-view-container"><p>Error: {error}</p></div>;
 
         let displayCid = cid; // Start with URL CID
        
        if (replyingToPost) {
            let rootPostId = replyingToPost.id;
            let currentPost: Post | undefined = replyingToPost;
             while (currentPost?.referenceCID && threadPosts.has(currentPost.referenceCID)) {
                 rootPostId = currentPost.referenceCID;
                 currentPost = threadPosts.get(rootPostId); if (!currentPost) break;
             }
             displayCid = rootPostId;
        } 
        else if (displayCid && threadPosts.has(displayCid)) {
             let currentPost = threadPosts.get(displayCid);
             while (currentPost?.referenceCID && threadPosts.has(currentPost.referenceCID)) {
                 displayCid = currentPost.referenceCID;
                 currentPost = threadPosts.get(displayCid);
                 if (!currentPost) break;
             }
         } else { return <div className="public-view-container"><p>Post not. found ({cid?.substring(0,8)}...).</p></div>; }
         console.log(`[PostPage] Rendering thread starting from root CID: ${displayCid}`);
 
         return (
            <>
                {replyingToPost && userState && (
                     <NewPostForm
                        replyingToPost={replyingToPost}
                        replyingToAuthorName={replyingToAuthorName}
                        onAddPost={handleAddPost}
                        isProcessing={isProcessing}
                        isCoolingDown={isCoolingDown}
                        countdown={countdown}
                     />
                )}
                <PostComponent
                    postId={displayCid}
                    allPostsMap={threadPosts}
                    userProfilesMap={threadProfiles} // Pass the combined profile map
                    onViewProfile={(key) => navigate(`/profile/${key}`)}
                    onLikePost={likePost}
                    onDislikePost={dislikePost}
                    currentUserState={userState}
                    myIpnsKey={myIpnsKey}
                    ensurePostsAreFetched={ensurePostsAreFetched}
                    onSetReplyingTo={handleSetReplying} 
                    renderReplies={true} 
                    isExpandedView={true} 
                />
            </>
         );
     };

    if (isModal) {
        return (
            <div
                className="expanded-post-backdrop"
                onClick={(e) => {
                    if (e.target === e.currentTarget) {
                        handleClose();
                    }
                }}
            >
                {/* --- FIX: Attach ref --- */}
                <div 
                    ref={modalContainerRef}
                    className="expanded-post-container" 
                    onClick={(e) => e.stopPropagation()}
                >
                {/* --- END FIX --- */}
                    {renderContent()}
                </div>
            </div>
        );
    }

    // Standard full-page rendering
    return (
        <div className="public-view-container post-page">
            {canGoBack ? (
                 <button className="back-to-feed-button" onClick={handleClose}>← Back</button>
            ) : (
                 <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
            )}
            {renderContent()}
        </div>
    );
};

export default PostPage;