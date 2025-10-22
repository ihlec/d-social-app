// src/pages/HomePage.tsx
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/useAppStorage';
import Sidebar from '../components/Sidebar';
import NewPostForm from '../features/feed/NewPostForm';
import Feed from '../features/feed/Feed';
import FeedSelector from '../features/feed/FeedSelector';
import { Post, NewPostData, UserProfile, Follow } from '../types';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { RefreshIcon } from '../components/Icons';
import logo from '/logo.png';

// ... (helper functions: getLatestActivityTimestamp, buildPostTree remain the same) ...
const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => { /* ... */
    const post = postsMap.get(postId); if (!post) return 0; let latestTimestamp = post.timestamp; if (post.replies && post.replies.length > 0) { for (const replyId of post.replies) { const replyTimestamp = getLatestActivityTimestamp(replyId, postsMap); if (replyTimestamp > latestTimestamp) { latestTimestamp = replyTimestamp; } } } return latestTimestamp;
};
const buildPostTree = (postMap: Map<string, Post>): { topLevelIds: string[], postsWithReplies: Map<string, Post> } => { /* ... */
    const postsWithReplies = new Map<string, Post>(); const topLevelIds = new Set<string>(); postMap.forEach((post, id) => { postsWithReplies.set(id, { ...post, replies: [] }); topLevelIds.add(id); }); postsWithReplies.forEach((post) => { if (post.referenceCID && postsWithReplies.has(post.referenceCID)) { postsWithReplies.get(post.referenceCID)?.replies?.push(post.id); topLevelIds.delete(post.id); } else if (post.referenceCID) { /* console.warn(...) */ } }); return { topLevelIds: Array.from(topLevelIds), postsWithReplies };
};


type FeedType = 'myPosts' | 'myFeed' | 'explore';

const HomePage: React.FC = () => {
    const navigate = useNavigate();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [selectedFeed, setSelectedFeed] = useState<FeedType>('myFeed');
    const [replyingToPost, setReplyingToPost] = useState<Post | null>(null);

    const {
        userState, myIpnsKey, latestStateCID, isLoadingFeed, isProcessing, isCoolingDown, countdown,
        addPost, likePost, dislikePost, followUser, unfollowUser, refreshFeed, logout,
        isLoadingExplore, loadMoreExplore, refreshExploreFeed,
        unresolvedFollows, allPostsMap, userProfilesMap, exploreAllPostsMap, exploreUserProfilesMap, otherUsers
    } = useAppState();

    const [loadMoreRef, isLoadMoreVisible] = useIntersectionObserver({ threshold: 0.1 });
    const exploreInitialized = useRef(false);
    // --- FIX: Initialize useRef ---
    const prevSelectedFeedRef = useRef<FeedType | undefined>(undefined);
    // --- End Fix ---

    // Load more explore items
    useEffect(() => {
         if (isLoadMoreVisible && selectedFeed === 'explore' && !isLoadingExplore) { loadMoreExplore(); }
    }, [isLoadMoreVisible, selectedFeed, isLoadingExplore, loadMoreExplore]);

    // Combined useEffect for feed switching/initialization
    useEffect(() => {
        const prevSelectedFeed = prevSelectedFeedRef.current;
        prevSelectedFeedRef.current = selectedFeed; // Update ref

        if (selectedFeed !== 'explore') {
            exploreInitialized.current = false;
            // Only run refresh if feed *changed* to myFeed/myPosts
            if (selectedFeed !== prevSelectedFeed && (selectedFeed === 'myFeed' || selectedFeed === 'myPosts')) {
                console.log(`[HomePage useEffect] Switched to ${selectedFeed}, triggering non-forced refresh...`);
                if (userState) {
                    refreshFeed();
                } else {
                     console.warn("[HomePage useEffect] Skipping refresh on feed switch, no user state yet.");
                }
            }
        } else { // selectedFeed === 'explore'
            if (userState && !exploreInitialized.current) {
                console.log("[HomePage useEffect] Switching to Explore, initializing...");
                exploreInitialized.current = true;
                refreshExploreFeed();
            } else {
                 console.log("[HomePage useEffect] Switching to Explore, already initialized or no user state.");
            }
        }
    // Depend only on selectedFeed and userState (for explore init).
    }, [selectedFeed, userState, refreshExploreFeed, refreshFeed]);


    // Interactions
    const handleViewProfile = (key: string) => { /* ... */ setIsSidebarOpen(false); navigate(`/profile/${key}`); };
    const handleSelectFeed = (feed: FeedType) => { /* ... */ setReplyingToPost(null); setSelectedFeed(feed); };
    const handleSetReplying = (post: Post | null) => { /* ... */ setReplyingToPost(post); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const handleAddPost = (postData: NewPostData) => { /* ... */ addPost(postData); setReplyingToPost(null); };

    // Determine which posts and profiles to display
    const displayData = useMemo(() => {
        // ... (useMemo implementation remains the same) ...
        // --- FIX: Removed allowFollow logic ---
        const combinedProfiles: Map<string, UserProfile> = new Map([...userProfilesMap, ...exploreUserProfilesMap]); const dislikedSet = new Set(userState?.dislikedPostCIDs || []); let preliminaryMap: Map<string, Post>; if (selectedFeed === 'explore') { preliminaryMap = exploreAllPostsMap; } else { preliminaryMap = allPostsMap; } const filteredMap = new Map<string, Post>(); preliminaryMap.forEach((post, id) => { if (!dislikedSet.has(id)) { filteredMap.set(id, post); } }); const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(filteredMap); const hasMyCommentRecursive = (p: Post | undefined): boolean => { if (!p || !p.replies) return false; for (const rId of p.replies) { const reply = postsWithReplies.get(rId); if (!reply) continue; if (reply.authorKey === myIpnsKey) return true; if (hasMyCommentRecursive(reply)) return true; } return false; }; const hasOtherCommentRecursive = (p: Post | undefined): boolean => { if (!p || !p.replies) return false; for (const rId of p.replies) { const reply = postsWithReplies.get(rId); if (!reply) continue; if (reply.authorKey !== myIpnsKey) return true; if (hasOtherCommentRecursive(reply)) return true; } return false; }; if (replyingToPost) { let rootPostId = replyingToPost.id; let currentPost: Post | undefined = replyingToPost; const fullCombinedMapForReply: Map<string, Post> = new Map([...allPostsMap, ...exploreAllPostsMap]); while (currentPost?.referenceCID && fullCombinedMapForReply.has(currentPost.referenceCID)) { rootPostId = currentPost.referenceCID; currentPost = fullCombinedMapForReply.get(rootPostId); if (!currentPost) break; } const { postsWithReplies: fullTree } = buildPostTree(fullCombinedMapForReply); return { topLevelPostIds: [rootPostId], allPostsMap: fullTree, userProfilesMap: combinedProfiles }; } let finalTopLevelIds: string[] = []; switch (selectedFeed) { case 'myPosts': finalTopLevelIds = allTopLevelIds.filter(id => { const post = postsWithReplies.get(id); if (!post) return false; return post.authorKey === myIpnsKey || hasMyCommentRecursive(post); }); break; case 'explore': finalTopLevelIds = allTopLevelIds; break; case 'myFeed': default: finalTopLevelIds = allTopLevelIds.filter(id => { const post = postsWithReplies.get(id); if (!post) return false; const isFollowed = userState?.follows?.some((f: Follow) => f.ipnsKey === post.authorKey); const isMyPostWithOtherComment = (post.authorKey === myIpnsKey && hasOtherCommentRecursive(post)); return isFollowed || isMyPostWithOtherComment; }); break; } const sortedTopLevelIds = finalTopLevelIds.sort((a, b) => getLatestActivityTimestamp(b, postsWithReplies) - getLatestActivityTimestamp(a, postsWithReplies)); return { topLevelPostIds: sortedTopLevelIds, allPostsMap: postsWithReplies, userProfilesMap: combinedProfiles };
        // --- End Fix ---
    }, [selectedFeed, replyingToPost, allPostsMap, exploreAllPostsMap, userProfilesMap, exploreUserProfilesMap, myIpnsKey, userState?.dislikedPostCIDs, userState?.follows]);

     const isLoading = isLoadingFeed || (selectedFeed === 'explore' && isLoadingExplore);
     const showLoadMore = !replyingToPost && selectedFeed === 'explore';


    // HTML Components
    return (
        <div className="app-container">
            {/* Logo/Hamburger */}
            <div className="logo-container" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                <img src={logo} alt="Logo" />
            </div>

            {/* Sidebar */}
            <Sidebar /* ... props ... */
                isOpen={isSidebarOpen} userState={userState} ipnsKey={myIpnsKey} latestCid={latestStateCID} unresolvedFollows={unresolvedFollows} otherUsers={otherUsers} onFollow={followUser} onUnfollow={unfollowUser} onViewProfile={handleViewProfile} onLogout={logout}
            />

            {/* Main Content */}
            <div className={`main-content ${isSidebarOpen ? 'sidebar-open' : ''}`}>
                 {replyingToPost ? ( /* ... back button ... */
                     <button className="back-to-feed-button" onClick={() => handleSetReplying(null)}> ← Back to Feed </button>
                 ) : (
                     <> {/* ... header + feed selector ... */ }
                        <div className="feed-header"> <button className="refresh-button" onClick={() => selectedFeed === 'explore' ? refreshExploreFeed() : refreshFeed(true)} disabled={isLoading || isProcessing} title={selectedFeed === 'explore' ? "Refresh Explore Feed" : "Refresh Feed"} > <RefreshIcon /> </button> </div>
                        <FeedSelector selectedFeed={selectedFeed} onSelectFeed={handleSelectFeed} />
                     </>
                 )}

                 {/* New Post Form */}
                 {(selectedFeed === 'myPosts' || selectedFeed === 'myFeed' || replyingToPost) && ( /* ... */
                     <NewPostForm replyingToPost={replyingToPost} onAddPost={handleAddPost} isProcessing={isProcessing} isCoolingDown={isCoolingDown} countdown={countdown} />
                 )}

                {/* Feed */}
                <Feed /* ... props ... */
                    isLoading={isLoading} topLevelPostIds={displayData.topLevelPostIds} allPostsMap={displayData.allPostsMap} userProfilesMap={displayData.userProfilesMap} onSetReplyingTo={handleSetReplying} onViewProfile={handleViewProfile} onLikePost={likePost} onDislikePost={dislikePost} currentUserState={userState} myIpnsKey={myIpnsKey}
                    // --- FIX: Removed onFollowPostAuthor ---
                    // onFollowPostAuthor={displayData.allowFollow ? followUser : undefined} 
                    // --- End Fix ---
                    footerComponent={showLoadMore ? <div ref={loadMoreRef} className="load-more-trigger">{isLoadingExplore && <p className="loading">Loading More...</p>}</div> : undefined}
                />
            </div>
        </div>
    );
};

export default HomePage;