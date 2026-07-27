import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/useAppStorage';
import Sidebar from '../components/Sidebar';
import NewPostForm from '../features/feed/NewPostForm';
import Feed from '../features/feed/Feed';
import { NewPostData } from '../types';
import logo from '/logo.png';
import { useScrollRestoration } from '../hooks/useScrollRestoration';
import { collectHomeFeedRootIds } from '../lib/feedRoots';
import { saveHomeFeedSnapshot } from '../lib/contentCache';
import './HomePage.css';

const HomePage: React.FC = () => {
    const {
        userState,
        myIpnsKey,
        myPeerId,
        latestStateCID,
        isProcessing,
        isCoolingDown,
        countdown,
        addPost,
        likePost,
        dislikePost,
        savePost,
        followUser,
        unfollowUser,
        
        // Feed Data & State
        allPostsMap,
        userProfilesMap,
        otherUsers,
        unresolvedFollows,
        logout,
        ensurePostsAreFetched,
        
        // Hybrid Feed Props
        exploreFeedPosts,
        loadMoreMyFeed,
        loadMoreExplore,
        canLoadMoreMyFeed,
        canLoadMoreExplore,
        isLoadingFeed,
        isLoadingExplore,
        refreshFeed
    } = useAppState();

    const navigate = useNavigate();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    // Capture initial dislikes to only filter out historical dislikes, 
    // allowing new ones to remain in the list (handled by PostItem)
    const initialDislikesRef = useRef<Set<string> | null>(null);
    useEffect(() => {
        if (!initialDislikesRef.current && userState?.dislikedPostCIDs) {
             initialDislikesRef.current = new Set(userState.dislikedPostCIDs);
        }
    }, [userState]);

    const { homeRootIds, missingParentIds } = useMemo(() => {
        // Only filter using the initial set, so new dislikes don't disappear immediately
        const dislikedIds = initialDislikesRef.current || new Set(userState?.dislikedPostCIDs || []);
        const { rootIds, missingParentIds: missing } = collectHomeFeedRootIds(allPostsMap, {
            myKeys: [myIpnsKey, myPeerId],
            followingKeys: (userState?.follows || []).map((f) => f.ipnsKey),
            blockedKeys: userState?.blockedUsers || [],
            dislikedIds,
        });
        return { homeRootIds: rootIds, missingParentIds: missing };
    }, [allPostsMap, userState, myIpnsKey, myPeerId]);

    // Fetch missing parents so follow-replies can promote stranger roots into Home
    useEffect(() => {
        if (missingParentIds.length === 0) return;
        void ensurePostsAreFetched(missingParentIds);
    }, [missingParentIds, ensurePostsAreFetched]);

    // Remember last Home roots so the next refresh paints immediately from IDB
    useEffect(() => {
        if (homeRootIds.length === 0) return;
        const t = window.setTimeout(() => saveHomeFeedSnapshot(homeRootIds), 400);
        return () => window.clearTimeout(t);
    }, [homeRootIds]);

    const unifiedTopLevelIds = useMemo(() => {
        const dislikedIds = initialDislikesRef.current || new Set(userState?.dislikedPostCIDs || []);
        const blockedUsers = new Set(userState?.blockedUsers || []);
        const isValidRootPost = (p: { referenceCID?: string; id: string; authorKey: string }) =>
            !p.referenceCID && !dislikedIds.has(p.id) && !blockedUsers.has(p.authorKey);

        const myIdsSet = new Set(homeRootIds);
        const exploreIds = exploreFeedPosts
            .filter((p) => isValidRootPost(p) && !myIdsSet.has(p.id))
            .map((p) => p.id);

        return [...homeRootIds, ...exploreIds];
    }, [homeRootIds, exploreFeedPosts, userState]);

    const feedContainerRef = useRef<HTMLDivElement>(null);
    const isAnyLoading = isLoadingFeed || isLoadingExplore;

    const { captureScrollAnchor, isScrollLocked } = useScrollRestoration(
        feedContainerRef,
        isAnyLoading,
        [unifiedTopLevelIds.length]
    );

    const handleAddPost = async (postData: NewPostData) => {
        await addPost(postData);
    };

    const handleLoadMore = () => {
        // Trigger load more if we are near bottom
        if (canLoadMoreMyFeed) loadMoreMyFeed();
        if (canLoadMoreExplore) loadMoreExplore();
    };

    const handleRefreshHome = () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        refreshFeed(true).catch(console.error);
    };

    const loaderRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const observer = new IntersectionObserver(
            entries => {
                const target = entries[0];
                if (target.isIntersecting) {
                    if ((canLoadMoreMyFeed || canLoadMoreExplore) && !isAnyLoading) {
                        captureScrollAnchor();
                        handleLoadMore();
                    }
                }
            },
            { root: null, rootMargin: '1500px', threshold: 0.1 }
        );

        if (loaderRef.current) observer.observe(loaderRef.current);
        return () => {
            if (loaderRef.current) observer.unobserve(loaderRef.current);
        };
    }, [canLoadMoreMyFeed, canLoadMoreExplore, isAnyLoading, captureScrollAnchor]);

    return (
        <div className="app-container">
            <button
                className="sidebar-toggle-button"
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                title={isSidebarOpen ? "Close Sidebar" : "Open Sidebar"}
            >
                <img src={logo} alt="D. Social" crossOrigin="anonymous"/>
            </button>

            <Sidebar 
                isOpen={isSidebarOpen} 
                onClose={() => setIsSidebarOpen(false)}
                userState={userState}
                ipnsKey={myIpnsKey}
                peerId={myPeerId}
                latestCid={latestStateCID}
                unresolvedFollows={unresolvedFollows}
                otherUsers={otherUsers}
                onLogout={logout}
                onFollow={followUser}
                onUnfollow={unfollowUser}
                onViewProfile={(key) => {
                    navigate(`/profile/${key}`);
                    setIsSidebarOpen(false);
                }}
                onRefreshHome={handleRefreshHome}
            />

            <div
                className={`main-content ${isSidebarOpen ? 'shifted' : ''} ${isScrollLocked ? 'scroll-locked' : ''}`}
                ref={feedContainerRef}
            >
                {userState && (
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
                    isLoading={isAnyLoading && unifiedTopLevelIds.length === 0}
                    topLevelIds={unifiedTopLevelIds}
                    allPostsMap={allPostsMap}
                    userProfilesMap={userProfilesMap}
                    onViewProfile={(key) => navigate(`/profile/${key}`)}
                    onLikePost={likePost}
                    onDislikePost={dislikePost}
                    onSavePost={savePost}
                    currentUserState={userState}
                    myPeerId={myPeerId}
                    ensurePostsAreFetched={ensurePostsAreFetched}
                />

                <div ref={loaderRef} className="feed-loader-container">
                    {isAnyLoading && (<div className="loading-spinner"></div>)}

                    {!isAnyLoading && (canLoadMoreMyFeed || canLoadMoreExplore) && (
                        <button 
                            className="load-more-button"
                            onClick={() => {
                                captureScrollAnchor();
                                handleLoadMore();
                            }}
                        >
                            Load More
                        </button>
                    )}
                    
                    {!isAnyLoading && !canLoadMoreMyFeed && !canLoadMoreExplore && unifiedTopLevelIds.length > 0 && (
                        <div className="end-of-feed">
                            You've reached the end of the known network.
                        </div>
                    )}
                    
                    {!isAnyLoading && unifiedTopLevelIds.length === 0 && (
                        <div className="end-of-feed">
                            <p>No posts found.</p>
                            <p>Follow people or wait for the network to sync!</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default HomePage;