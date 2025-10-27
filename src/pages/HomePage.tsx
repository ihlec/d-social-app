// fileName: src/pages/HomePage.tsx
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/useAppStorage';
import Sidebar from '../components/Sidebar';
import NewPostForm from '../features/feed/NewPostForm';
import Feed from '../features/feed/Feed';
import FeedSelector from '../features/feed/FeedSelector';
import { Post, NewPostData, Follow } from '../types';
import { RefreshIcon } from '../components/Icons';
import logo from '/logo.png';

const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post || post.timestamp === 0) return 0;
    let latestTimestamp = post.timestamp;
    if (post.replies && post.replies.length > 0) {
        for (const replyId of post.replies) {
            const replyTimestamp = getLatestActivityTimestamp(replyId, postsMap);
            if (replyTimestamp > 0 && replyTimestamp > latestTimestamp) {
                latestTimestamp = replyTimestamp;
            }
        }
    }
    return latestTimestamp;
};

const buildPostTree = (postMap: Map<string, Post>): { topLevelIds: string[], postsWithReplies: Map<string, Post> } => {
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
        canLoadMoreExplore,
        unresolvedFollows, allPostsMap, userProfilesMap,
        otherUsers,
        ensurePostsAreFetched,
    } = useAppState();

    const exploreInitialized = useRef(false);
    const prevSelectedFeedRef = useRef<FeedType | undefined>(undefined);
    const isInitialLoad = useRef(true);

    console.log("[HomePage Render] Component rendering..."); // <-- ADDED LOG

    useEffect(() => {
        console.log("[HomePage useEffect] Running effect. isInitialLoad:", isInitialLoad.current, "SelectedFeed:", selectedFeed); // <-- ADDED LOG
        const prevSelectedFeed = prevSelectedFeedRef.current;
        prevSelectedFeedRef.current = selectedFeed;

        if (isInitialLoad.current) {
            isInitialLoad.current = false;
            console.log("[HomePage useEffect] Initial load detected, skipping effect-based refresh.");
            if (selectedFeed === 'explore' && userState && !exploreInitialized.current) {
                 console.log("[HomePage useEffect] Initializing Explore on first load.");
                 exploreInitialized.current = true;
                 refreshExploreFeed();
            }
            return;
        }


        if (selectedFeed !== 'explore') {
            exploreInitialized.current = false;
            if (selectedFeed !== prevSelectedFeed && selectedFeed === 'myFeed') {
                console.log(`[HomePage useEffect] Switched to ${selectedFeed}, triggering non-forced refresh...`);
                if (userState) {
                    // Pass force=false explicitly
                    refreshFeed(false);
                } else {
                     console.warn("[HomePage useEffect] Skipping refresh on feed switch, no user state yet.");
                }
            } else {
                 console.log(`[HomePage useEffect] Feed is ${selectedFeed}, but didn't switch to it. No refresh triggered.`); // <-- ADDED LOG
            }
        } else { // selectedFeed === 'explore'
            if (userState && !exploreInitialized.current) {
                console.log("[HomePage useEffect] Switching to Explore or userState loaded, initializing...");
                exploreInitialized.current = true;
                refreshExploreFeed();
            } else {
                 console.log(`[HomePage useEffect] Explore selected. Initialized: ${exploreInitialized.current}. Has userState: ${!!userState}`); // <-- MODIFIED LOG
            }
        }
        console.log("[HomePage useEffect] Effect finished."); // <-- ADDED LOG
    }, [selectedFeed, userState, refreshExploreFeed, refreshFeed]);


    const handleViewProfile = (key: string) => { setIsSidebarOpen(false); navigate(`/profile/${key}`); };
    const handleSelectFeed = (feed: FeedType) => { setSelectedFeed(feed); };
    const handleAddPost = (postData: NewPostData) => { addPost(postData); };

    const displayData = useMemo(() => {
        console.log("[HomePage useMemo] Calculating displayData..."); // <-- ADDED LOG
        const dislikedSet = new Set(userState?.dislikedPostCIDs || []);
        const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(allPostsMap);
         console.log(`[HomePage useMemo] built tree. allTopLevelIds: ${allTopLevelIds.length}, postsWithReplies: ${postsWithReplies.size}`); // <-- ADDED LOG
        const followedKeys = new Set(userState?.follows?.map((f: Follow) => f.ipnsKey) ?? []);

        let finalTopLevelIds: string[] = [];
        switch (selectedFeed) {
            case 'explore':
                finalTopLevelIds = allTopLevelIds.filter(id => {
                    const post = postsWithReplies.get(id);
                    if (!post || post.timestamp === 0) return false;
                    return !dislikedSet.has(id) &&
                           post.authorKey !== myIpnsKey &&
                           !followedKeys.has(post.authorKey);
                });
                break;
            case 'myFeed':
            default:
                finalTopLevelIds = allTopLevelIds.filter(id => {
                    const post = postsWithReplies.get(id);
                    if (!post || post.timestamp === 0) return false;
                    if (dislikedSet.has(id)) return false;
                    return post.authorKey === myIpnsKey || followedKeys.has(post.authorKey);
                });
                break;
        }
         console.log(`[HomePage useMemo] Filtered topLevelIds for ${selectedFeed}: ${finalTopLevelIds.length}`); // <-- ADDED LOG

        const sortedTopLevelIds = finalTopLevelIds.sort((a, b) => getLatestActivityTimestamp(b, postsWithReplies) - getLatestActivityTimestamp(a, postsWithReplies));
         console.log("[HomePage useMemo] Sorting complete. Returning displayData."); // <-- ADDED LOG

        return { topLevelIds: sortedTopLevelIds, allPostsMap: postsWithReplies, userProfilesMap: userProfilesMap };
    }, [selectedFeed, allPostsMap, myIpnsKey, userState?.dislikedPostCIDs, userState?.follows, userProfilesMap]);

     const isLoading = isLoadingFeed || (selectedFeed === 'explore' && isLoadingExplore);
     const showLoadMoreButton = selectedFeed === 'explore' && canLoadMoreExplore && !isLoadingExplore;


    return (
        <div className="app-container">
            <div className="logo-container" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                <img src={logo} alt="Logo" />
            </div>
            <Sidebar
                isOpen={isSidebarOpen} userState={userState} ipnsKey={myIpnsKey} latestCid={latestStateCID} unresolvedFollows={unresolvedFollows} otherUsers={otherUsers} onFollow={followUser} onUnfollow={unfollowUser} onViewProfile={handleViewProfile} onLogout={logout}
            />
            <div className={`main-content ${isSidebarOpen ? 'sidebar-open' : ''}`}>
                 <>
                    <div className="feed-header">
                        {/* Explicitly pass force=true */}
                        <button className="refresh-button" onClick={() => selectedFeed === 'explore' ? refreshExploreFeed() : refreshFeed(true)} disabled={isLoading || isProcessing} title={selectedFeed === 'explore' ? "Refresh Explore Feed" : "Refresh Feed"} > <RefreshIcon /> </button>
                    </div>
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
                <Feed
                    isLoading={isLoading}
                    topLevelIds={displayData.topLevelIds || []} // Corrected prop name
                    allPostsMap={displayData.allPostsMap}
                    userProfilesMap={displayData.userProfilesMap}
                    onViewProfile={handleViewProfile}
                    onLikePost={likePost}
                    onDislikePost={dislikePost}
                    currentUserState={userState}
                    myIpnsKey={myIpnsKey}
                    ensurePostsAreFetched={ensurePostsAreFetched}
                />
                {selectedFeed === 'explore' && (
                    <div style={{ padding: '1rem', textAlign: 'center' }}>
                        {isLoadingExplore ? (
                            <p className="loading">Loading More...</p>
                        ) : showLoadMoreButton ? (
                             <button
                                onClick={loadMoreExplore}
                                disabled={isLoadingExplore}
                                className="new-post-button"
                                style={{ width: 'auto', padding: '0.5em 1.5em' }}
                             >
                                Load More
                             </button>
                        ) : null
                        }
                    </div>
                )}
            </div>
        </div>
    );
};

export default HomePage;