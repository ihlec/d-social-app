// fileName: src/pages/HomePage.tsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../state/useAppStorage';
import Sidebar from '../components/Sidebar';
import NewPostForm from '../features/feed/NewPostForm';
import Feed from '../features/feed/Feed';
import { NewPostData } from '../types';
import logo from '/logo.png';
import { useScrollRestoration } from '../hooks/useScrollRestoration';
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
        // myFeedPosts, // <-- IGNORING THIS (It is pre-sorted by date)
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

    // --- Unified Feed Logic (Load Order / Appended) ---
    // Capture initial dislikes to only filter out historical dislikes, 
    // allowing new ones to remain in the list (handled by PostItem)
    const initialDislikesRef = useRef<Set<string> | null>(null);
    useEffect(() => {
        if (!initialDislikesRef.current && userState?.dislikedPostCIDs) {
             initialDislikesRef.current = new Set(userState.dislikedPostCIDs);
        }
    }, [userState]);

    const unifiedTopLevelIds = useMemo(() => {
        // Only filter using the initial set, so new dislikes don't disappear immediately
        const dislikedIds = initialDislikesRef.current || new Set(userState?.dislikedPostCIDs || []);
        const blockedUsers = new Set(userState?.blockedUsers || []);
        
        // Helper: Is this a top-level post we want to see?
        const isValidRootPost = (p: any) => !p.referenceCID && !dislikedIds.has(p.id) && !blockedUsers.has(p.authorKey);

        // 1. Define "My Feed" based on Follows (excluding Self by default now)
        // We do this manually here to use allPostsMap's insertion order (Load Order)
        // instead of the pre-sorted 'myFeedPosts' array.
        const followingSet = new Set(userState?.follows?.map(f => f.ipnsKey) || []);
        
        // 2. Iterate map values (Preserves Insertion Order -> Appended behavior)
        const myIds: string[] = [];
        for (const post of allPostsMap.values()) {
            // Determine if this is "my" post (checking both keys for safety)
            const isMyPost = (myIpnsKey && post.authorKey === myIpnsKey) || (myPeerId && post.authorKey === myPeerId);
            const isFollowed = followingSet.has(post.authorKey);

            if (!isValidRootPost(post)) continue;
            
            let shouldInclude = false;

            if (isFollowed) {
                shouldInclude = true;
            } else if (isMyPost) {
                 // Always show my own posts in the Home Feed
                 shouldInclude = true;
            }

            if (shouldInclude) {
                myIds.push(post.id);
            }
        }

        // 3. Merge Explore (Deduplicated)
        // We append Explore posts at the end of My Feed content
        const myIdsSet = new Set(myIds);
        const exploreIds = exploreFeedPosts
            .filter(p => isValidRootPost(p) && !myIdsSet.has(p.id))
            .map(p => p.id);

        return [...myIds, ...exploreIds];
    }, [allPostsMap, exploreFeedPosts, userState, myIpnsKey]);

    // --- Scroll Restoration ---
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