// fileName: src/pages/HomePage.tsx
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/useAppStorage';
import Sidebar from '../components/Sidebar';
import NewPostForm from '../features/feed/NewPostForm';
import Feed from '../features/feed/Feed';
import FeedSelector from '../features/feed/FeedSelector';
import { Post, NewPostData, Follow } from '../types';
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


type FeedType = 'myFeed' | 'explore';


const HomePage: React.FC = () => {
    const navigate = useNavigate();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [selectedFeed, setSelectedFeed] = useState<FeedType>('myFeed');

    const {
        userState, myIpnsKey, latestStateCID, isLoadingFeed, isProcessing, isCoolingDown, countdown,
        addPost, likePost, dislikePost, followUser, unfollowUser, refreshFeed, logout,
        isLoadingExplore, loadMoreExplore, refreshExploreFeed,
        unresolvedFollows, 
        // --- FIX: Use single, consolidated maps ---
        allPostsMap, 
        userProfilesMap,
        // --- END FIX ---
        otherUsers,
        ensurePostsAreFetched,
    } = useAppState();

    // --- FIX: No longer need to combine maps ---
    // const combinedPosts: Map<string, Post> = useMemo(() => new Map([...allPostsMap, ...exploreAllPostsMap]), [allPostsMap, exploreAllPostsMap]);
    // --- END FIX ---

    const [loadMoreRef, isLoadMoreVisible] = useIntersectionObserver({ threshold: 0.1 });
    const exploreInitialized = useRef(false);
    const prevSelectedFeedRef = useRef<FeedType | undefined>(undefined);

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
            // Only run refresh if feed *changed* to myFeed
            if (selectedFeed !== prevSelectedFeed && selectedFeed === 'myFeed') {
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
    const handleSelectFeed = (feed: FeedType) => { /* ... */ setSelectedFeed(feed); };
    const handleAddPost = (postData: NewPostData) => { /* ... */ addPost(postData); };

    // Determine which posts and profiles to display
    const displayData = useMemo(() => {
        const dislikedSet = new Set(userState?.dislikedPostCIDs || []);
        
        // --- FIX: Always build tree from the *full* allPostsMap ---
        const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(allPostsMap);
        // --- END FIX ---
        
        const followedKeys = new Set(userState?.follows?.map((f: Follow) => f.ipnsKey) ?? []);

        let finalTopLevelIds: string[] = [];
        switch (selectedFeed) {
            case 'explore':
                // Filter top level IDs: not disliked
                finalTopLevelIds = allTopLevelIds.filter(id => !dislikedSet.has(id));
                break;
            case 'myFeed':
            default:
                finalTopLevelIds = allTopLevelIds.filter(id => {
                    const post = postsWithReplies.get(id);
                    if (!post) return false;

                    // Always hide posts disliked by me
                    if (dislikedSet.has(id)) {
                        return false;
                    }
                    
                    // Show if I wrote it or I follow the author
                    return post.authorKey === myIpnsKey || followedKeys.has(post.authorKey);
                });
                break;
        } 
        
        const sortedTopLevelIds = finalTopLevelIds.sort((a, b) => getLatestActivityTimestamp(b, postsWithReplies) - getLatestActivityTimestamp(a, postsWithReplies));

        // --- FIX: Return single maps ---
        return { topLevelPostIds: sortedTopLevelIds, allPostsMap: postsWithReplies, userProfilesMap: userProfilesMap };
        // --- END FIX ---
    // --- FIX: Update dependencies ---
    }, [selectedFeed, allPostsMap, myIpnsKey, userState?.dislikedPostCIDs, userState?.follows, userProfilesMap]);
    // --- END FIX ---

     const isLoading = isLoadingFeed || (selectedFeed === 'explore' && isLoadingExplore);
     const showLoadMore = selectedFeed === 'explore';


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
                 <> {/* ... header + feed selector ... */ }
                    <div className="feed-header"> <button className="refresh-button" onClick={() => selectedFeed === 'explore' ? refreshExploreFeed() : refreshFeed(true)} disabled={isLoading || isProcessing} title={selectedFeed === 'explore' ? "Refresh Explore Feed" : "Refresh Feed"} > <RefreshIcon /> </button> </div>
                    <FeedSelector selectedFeed={selectedFeed} onSelectFeed={handleSelectFeed} />
                 </>

                 {selectedFeed === 'myFeed' && userState && (
                     <NewPostForm
                        replyingToPost={null}
                        replyingToAuthorName={null}
                        onAddPost={handleAddPost}
                        isProcessing={isProcessing}
                        isCoolingDown={isCoolingDown}
                        countdown={countdown}
                     />
                 )}

                {/* Feed */}
                <Feed /* ... props ... */
                    isLoading={isLoading}
                    topLevelPostIds={displayData.topLevelPostIds || []}
                    allPostsMap={displayData.allPostsMap}
                    userProfilesMap={displayData.userProfilesMap}
                    onViewProfile={handleViewProfile}
                    onLikePost={likePost}
                    onDislikePost={dislikePost}
                    currentUserState={userState}
                    myIpnsKey={myIpnsKey}
                    ensurePostsAreFetched={ensurePostsAreFetched}
                    footerComponent={showLoadMore ? <div ref={loadMoreRef} className="load-more-trigger">{isLoadingExplore && <p className="loading">Loading More...</p>}</div> : undefined}
                />
            </div>
        </div>
    );
};

export default HomePage;