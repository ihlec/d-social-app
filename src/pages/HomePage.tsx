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

// --- getLatestActivityTimestamp and buildPostTree remain the same ---
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
        loadMoreMyFeed,
        canLoadMoreMyFeed,
    } = useAppState();

    const exploreInitialized = useRef(false);
    const prevSelectedFeedRef = useRef<FeedType | undefined>(undefined);
    const isInitialLoad = useRef(true);
    const loaderRef = useRef<HTMLDivElement>(null);
    const [isLoaderVisible, setIsLoaderVisible] = useState(false);

    // --- useEffect for feed switching remains the same ---
    useEffect(() => {
        console.log("[HomePage useEffect] Running effect. isInitialLoad:", isInitialLoad.current, "SelectedFeed:", selectedFeed);
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
                    refreshFeed(false);
                } else {
                     console.warn("[HomePage useEffect] Skipping refresh on feed switch, no user state yet.");
                }
            } else {
                 console.log(`[HomePage useEffect] Feed is ${selectedFeed}, but didn't switch to it. No refresh triggered.`);
            }
        } else { // selectedFeed === 'explore'
            if (userState && !exploreInitialized.current) {
                console.log("[HomePage useEffect] Switching to Explore or userState loaded, initializing...");
                exploreInitialized.current = true;
                refreshExploreFeed();
            } else {
                 console.log(`[HomePage useEffect] Explore selected. Initialized: ${exploreInitialized.current}. Has userState: ${!!userState}`);
            }
        }
        console.log("[HomePage useEffect] Effect finished.");
    }, [selectedFeed, userState, refreshExploreFeed, refreshFeed]);


    const handleViewProfile = (key: string) => { setIsSidebarOpen(false); navigate(`/profile/${key}`); };
    const handleSelectFeed = (feed: FeedType) => { setSelectedFeed(feed); };
    const handleAddPost = (postData: NewPostData) => { addPost(postData); };

    // --- displayData useMemo remains the same ---
    const displayData = useMemo(() => {
        console.log("[HomePage useMemo] Calculating displayData...");
        const dislikedSet = new Set(userState?.dislikedPostCIDs || []);
        const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(allPostsMap);
         console.log(`[HomePage useMemo] built tree. allTopLevelIds: ${allTopLevelIds.length}, postsWithReplies: ${postsWithReplies.size}`);
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
         console.log(`[HomePage useMemo] Filtered topLevelIds for ${selectedFeed}: ${finalTopLevelIds.length}`);

        const sortedTopLevelIds = finalTopLevelIds.sort((a, b) => getLatestActivityTimestamp(b, postsWithReplies) - getLatestActivityTimestamp(a, postsWithReplies));
         console.log("[HomePage useMemo] Sorting complete. Returning displayData.");

        return { topLevelIds: sortedTopLevelIds, allPostsMap: postsWithReplies, userProfilesMap: userProfilesMap };
    }, [selectedFeed, allPostsMap, myIpnsKey, userState?.dislikedPostCIDs, userState?.follows, userProfilesMap]);

    // --- loading/canLoadMore logic remains the same ---
     const isLoading = isLoadingFeed || (selectedFeed === 'explore' && isLoadingExplore);
     const isLoadingMore = selectedFeed === 'myFeed' ? isLoadingFeed : isLoadingExplore;
     const canLoadMore =
        (selectedFeed === 'myFeed' && canLoadMoreMyFeed) ||
        (selectedFeed === 'explore' && canLoadMoreExplore);
     const loadMoreHandler = selectedFeed === 'myFeed' ? loadMoreMyFeed : loadMoreExplore;

    // --- Observer useEffect (sets visibility) ---
    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                const firstEntry = entries[0];
                setIsLoaderVisible(firstEntry.isIntersecting);
                console.log(`[IntersectionObserver HomePage] Visibility Changed: ${firstEntry.isIntersecting}`);
            },
            {
                threshold: 0,
                // --- START MODIFICATION: Correct rootMargin to expand bottom ---
                rootMargin: '0px 0px 200px 0px'
                // --- END MODIFICATION ---
            }
        );

        const currentLoaderRef = loaderRef.current;
        if (currentLoaderRef) { observer.observe(currentLoaderRef); }

        return () => {
            if (currentLoaderRef) { observer.unobserve(currentLoaderRef); }
            setIsLoaderVisible(false);
        };
    }, [selectedFeed]); // Re-observe when feed type changes

    // --- Trigger useEffect remains the same (calls loadMoreHandler) ---
    useEffect(() => {
        console.log(`[LoadMore Trigger Check HomePage] isLoaderVisible: ${isLoaderVisible}, canLoadMore: ${canLoadMore}, isLoadingMore: ${isLoadingMore}, selectedFeed: ${selectedFeed}`);
        if (isLoaderVisible && canLoadMore && !isLoadingMore) {
            console.log("[LoadMore Trigger HomePage] Conditions met, calling loadMoreHandler...");
            loadMoreHandler();
        }
    }, [isLoaderVisible, canLoadMore, isLoadingMore, loadMoreHandler, selectedFeed]);


    return (
        <div className="app-container">
            {/* --- Sidebar and Logo remain the same --- */}
             <div className="logo-container" onClick={() => setIsSidebarOpen(!isSidebarOpen)}> <img src={logo} alt="Logo" /> </div>
             <Sidebar isOpen={isSidebarOpen} userState={userState} ipnsKey={myIpnsKey} latestCid={latestStateCID} unresolvedFollows={unresolvedFollows} otherUsers={otherUsers} onFollow={followUser} onUnfollow={unfollowUser} onViewProfile={handleViewProfile} onLogout={logout} />

            <div className={`main-content ${isSidebarOpen ? 'sidebar-open' : ''}`}>
                 {/* --- Header, FeedSelector, NewPostForm remain the same --- */}
                 <> <div className="feed-header"> <button className="refresh-button" onClick={() => selectedFeed === 'explore' ? refreshExploreFeed() : refreshFeed(true)} disabled={isLoading || isProcessing} title={selectedFeed === 'explore' ? "Refresh Explore Feed" : "Refresh Feed"} > <RefreshIcon /> </button> </div> <FeedSelector selectedFeed={selectedFeed} onSelectFeed={handleSelectFeed} /> </>
                 {selectedFeed === 'myFeed' && userState && ( <NewPostForm replyingToPost={null} replyingToAuthorName={null} onAddPost={handleAddPost} isProcessing={isProcessing} isCoolingDown={isCoolingDown} countdown={countdown} /> )}

                {/* --- Feed component remains the same --- */}
                <Feed isLoading={isLoading && displayData.topLevelIds.length === 0} topLevelIds={displayData.topLevelIds || []} allPostsMap={displayData.allPostsMap} userProfilesMap={displayData.userProfilesMap} onViewProfile={handleViewProfile} onLikePost={likePost} onDislikePost={dislikePost} currentUserState={userState} myIpnsKey={myIpnsKey} ensurePostsAreFetched={ensurePostsAreFetched} />

                {/* --- Loader ref and indicator remain the same --- */}
                <div ref={loaderRef} style={{ height: '50px', marginTop: '1rem', width: '100%' }}>
                    {isLoadingMore && ( <p className="loading">Loading More...</p> )}
                    {!isLoadingMore && !canLoadMore && displayData.topLevelIds.length > 0 && ( null )}
                </div>
            </div>
        </div>
    );
};

export default HomePage;