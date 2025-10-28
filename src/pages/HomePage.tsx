// fileName: src/pages/HomePage.tsx
import React, { useState, useMemo, useEffect, useRef, useLayoutEffect, useCallback } from 'react'; // ADDED useCallback
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

    // --- START SCROLL LOCK & RESTORATION STATE ---
    const [isScrollLocked, setIsScrollLocked] = useState(false);
    const feedContainerRef = useRef<HTMLDivElement>(null);
    const scrollAnchorRef = useRef<{ id: string | null; top: number }>({ id: null, top: 0 });
    const isRestoringScroll = useRef(false);
    const wasLoadingMore = useRef(false);
    // --- END SCROLL LOCK & RESTORATION STATE ---

    // --- useEffect for scroll locking/unlocking ---
    useEffect(() => {
        if (isScrollLocked) {
            document.body.style.overflowY = 'hidden';
            const unlockTimeout = setTimeout(() => {
                document.body.style.overflowY = 'auto';
                setIsScrollLocked(false);
            }, 200);
            return () => clearTimeout(unlockTimeout);
        } else {
            document.body.style.overflowY = 'auto';
        }
    }, [isScrollLocked]);
    // --- End scroll locking effect ---


    // --- useEffect for feed switching remains the same ---
    useEffect(() => {
        // ... (effect logic unchanged) ...
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
        // ... (memo logic unchanged) ...
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

    // --- loading/canLoadMore logic ---
     const isLoading = isLoadingFeed || (selectedFeed === 'explore' && isLoadingExplore);
     const isLoadingMore = selectedFeed === 'myFeed' ? isLoadingFeed : isLoadingExplore;
     const canLoadMore =
        (selectedFeed === 'myFeed' && canLoadMoreMyFeed) ||
        (selectedFeed === 'explore' && canLoadMoreExplore);
     
     // --- START MODIFICATION: Load More Handler with Scroll Lock ---
     const wrappedLoadMoreHandler = useCallback(() => {
        if (canLoadMore && !isLoadingMore) {
            // 1. Capture Anchor
            if (feedContainerRef.current) {
                const posts = feedContainerRef.current.querySelectorAll('.post[data-post-id]');
                let bestCandidate: { id: string | null, top: number } = { id: null, top: Infinity };
                posts.forEach(postElement => {
                    const rect = postElement.getBoundingClientRect();
                    if (rect.bottom > -50 && rect.top < bestCandidate.top) {
                        bestCandidate = { id: postElement.getAttribute('data-post-id'), top: rect.top };
                    }
                });
                 if (bestCandidate.id) {
                     scrollAnchorRef.current = bestCandidate;
                     console.log(`[Scroll Anchor Set] ID: ${bestCandidate.id}, Top: ${bestCandidate.top}`);
                 } else {
                     scrollAnchorRef.current = { id: null, top: 0 };
                 }
            } else {
                 scrollAnchorRef.current = { id: null, top: 0 };
            }

            // 2. Start Lock and Loading
            wasLoadingMore.current = true;
            setIsScrollLocked(true); // Disable scrolling for 1 second
            
            console.log("[LoadMore Trigger HomePage] Conditions met, calling loadMoreHandler...");
            (selectedFeed === 'myFeed' ? loadMoreMyFeed : loadMoreExplore)();
        }
     }, [canLoadMore, isLoadingMore, loadMoreMyFeed, loadMoreExplore, selectedFeed]);
     // --- END MODIFICATION ---


    // --- Observer useEffect remains the same (sets visibility) ---
    useEffect(() => {
        // ... (effect logic unchanged) ...
        const observer = new IntersectionObserver(
            (entries) => {
                const firstEntry = entries[0];
                setIsLoaderVisible(firstEntry.isIntersecting);
                console.log(`[IntersectionObserver HomePage] Visibility Changed: ${firstEntry.isIntersecting}`);
            },
            {
                threshold: 0
            }
        );

        const currentLoaderRef = loaderRef.current;
        if (currentLoaderRef) { observer.observe(currentLoaderRef); }

        return () => {
            if (currentLoaderRef) { observer.unobserve(currentLoaderRef); }
            setIsLoaderVisible(false);
        };
    }, [selectedFeed]);

    // --- Trigger useEffect (calls wrappedLoadMoreHandler) ---
    useEffect(() => {
        console.log(`[LoadMore Trigger Check HomePage] isLoaderVisible: ${isLoaderVisible}, canLoadMore: ${canLoadMore}, isLoadingMore: ${isLoadingMore}, selectedFeed: ${selectedFeed}`);
        // Call wrapped handler, checking scroll lock state
        if (isLoaderVisible && canLoadMore && !isLoadingMore && !isScrollLocked) {
             wrappedLoadMoreHandler();
        }
    }, [isLoaderVisible, canLoadMore, isLoadingMore, wrappedLoadMoreHandler, selectedFeed, isScrollLocked]);

    // --- START SCROLL RESTORATION: useLayoutEffect to restore position ---
    useLayoutEffect(() => {
        // Only run if we *were* loading, are not *anymore*, have an anchor ID, and are not *currently* restoring
        if (wasLoadingMore.current && !isLoadingMore && scrollAnchorRef.current.id && !isRestoringScroll.current) {
            const anchorId = scrollAnchorRef.current.id;
            const storedTop = scrollAnchorRef.current.top;
            console.log(`[Scroll Restore Attempt] Anchor ID: ${anchorId}, Stored Top: ${storedTop}`);

            // --- Wrap in requestAnimationFrame ---
            const rafId = requestAnimationFrame(() => {
                const anchorElement = feedContainerRef.current?.querySelector(`[data-post-id="${anchorId}"]`);

                if (anchorElement) {
                    const newRect = anchorElement.getBoundingClientRect();
                    const scrollOffset = newRect.top - storedTop;
                    console.log(`[Scroll Restore Calc] New Top: ${newRect.top}, Diff: ${scrollOffset}`);

                    if (Math.abs(scrollOffset) > 1) { // Avoid tiny adjustments
                        isRestoringScroll.current = true; // Prevent triggering effect again
                        window.scrollBy({ top: scrollOffset, left: 0, behavior: 'instant' }); // Use instant behavior
                        console.log(`[Scroll Restore Action] Scrolled by ${scrollOffset}px`);
                        // Use another rAF to release the lock after the scroll should have happened
                        requestAnimationFrame(() => { isRestoringScroll.current = false; });
                    } else {
                        isRestoringScroll.current = false; // Release lock if no scroll needed
                    }
                } else {
                    console.warn(`[Scroll Restore Failed] Anchor element ${anchorId} not found after load.`);
                    isRestoringScroll.current = false; // Release lock if element not found
                }
            });
            // --- End wrap ---

            // Reset wasLoadingMore immediately, anchor reset happens inside rAF logic implicitly
            wasLoadingMore.current = false;
            scrollAnchorRef.current = { id: null, top: 0 }; // Reset anchor ref after scheduling

            // Cleanup function for the effect to cancel the frame if component unmounts
            return () => {
                cancelAnimationFrame(rafId);
                 isRestoringScroll.current = false; // Ensure lock is released on unmount/re-run
            };
        } else if (!isLoadingMore && wasLoadingMore.current) {
             // If loading finished but we didn't have an anchor or were already restoring, reset the flag
             wasLoadingMore.current = false;
             scrollAnchorRef.current = { id: null, top: 0 };
        }
    }, [isLoadingMore, displayData.topLevelIds]);
    // --- END SCROLL RESTORATION ---


    return (
        <div className="app-container">
            {/* --- Sidebar and Logo --- */}
             <div className="logo-container" onClick={() => setIsSidebarOpen(!isSidebarOpen)}> <img src={logo} alt="Logo" /> </div>
             <Sidebar isOpen={isSidebarOpen} userState={userState} ipnsKey={myIpnsKey} latestCid={latestStateCID} unresolvedFollows={unresolvedFollows} otherUsers={otherUsers} onFollow={followUser} onUnfollow={unfollowUser} onViewProfile={handleViewProfile} onLogout={logout} />

            {/* --- Add ref to main content --- */}
            <div ref={feedContainerRef} className={`main-content ${isSidebarOpen ? 'sidebar-open' : ''}`}>
                 {/* --- Header, FeedSelector, NewPostForm --- */}
                 <> <div className="feed-header"> <button className="refresh-button" onClick={() => selectedFeed === 'explore' ? refreshExploreFeed() : refreshFeed(true)} disabled={isLoading || isProcessing} title={selectedFeed === 'explore' ? "Refresh Explore Feed" : "Refresh Feed"} > <RefreshIcon /> </button> </div> <FeedSelector selectedFeed={selectedFeed} onSelectFeed={handleSelectFeed} /> </>
                 {selectedFeed === 'myFeed' && userState && ( <NewPostForm replyingToPost={null} replyingToAuthorName={null} onAddPost={handleAddPost} isProcessing={isProcessing} isCoolingDown={isCoolingDown} countdown={countdown} /> )}

                {/* --- Feed component --- */}
                <Feed isLoading={isLoading && displayData.topLevelIds.length === 0} topLevelIds={displayData.topLevelIds || []} allPostsMap={displayData.allPostsMap} userProfilesMap={displayData.userProfilesMap} onViewProfile={handleViewProfile} onLikePost={likePost} onDislikePost={dislikePost} currentUserState={userState} myIpnsKey={myIpnsKey} ensurePostsAreFetched={ensurePostsAreFetched} />

                {/* --- Loader ref and indicator --- */}
                <div ref={loaderRef} style={{ height: '50px', marginTop: '1rem', width: '100%' }}>
                    {isLoadingMore && ( <p className="loading">Loading More...</p> )}
                    {!isLoadingMore && !canLoadMore && displayData.topLevelIds.length > 0 && ( null )}
                </div>
            </div>
        </div>
    );
};

export default HomePage;