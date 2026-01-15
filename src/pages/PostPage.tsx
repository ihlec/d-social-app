// fileName: src/components/PostPage.tsx
import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import PostComponent from '../features/feed/PostItem';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAppState } from '../state/useAppStorage';
import { Post } from '../types';
import NewPostForm from '../features/feed/NewPostForm';
import { useThreadFetcher } from '../hooks/useThreadFetcher';

const PostPage: React.FC = () => {
    // Keep 'cid' to match your router configuration provided in the snippet
    const { cid: routeCid } = useParams<{ cid: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const modalContainerRef = useRef<HTMLDivElement>(null);
    
    const displayCid = routeCid;
    
    const { 
        allPostsMap, 
        userProfilesMap: globalProfilesMap, 
        addPost, 
        userState, 
        myPeerId,
        isProcessing,
        isCoolingDown,
        countdown,
        loadMoreExplore,
        isLoadingExplore,
        canLoadMoreExplore,
        unifiedIds,
        loadMoreFeed,
        // --- INTEGRATED: Missing Actions ---
        likePost,
        dislikePost,
        ensurePostsAreFetched
    } = useAppState();

    const { 
        threadPosts, 
        threadProfiles, 
        isLoading, 
        error 
    } = useThreadFetcher(displayCid || '', allPostsMap, globalProfilesMap);

    // --- Downward Link Synthesis ---
    const postsForRender = useMemo(() => {
        const map = new Map([...allPostsMap, ...threadPosts]);
        const parentIndex = new Map<string, string[]>();
        
        map.forEach(post => {
            if (post.referenceCID) {
                const existing = parentIndex.get(post.referenceCID) || [];
                if (!existing.includes(post.id)) {
                    existing.push(post.id);
                    parentIndex.set(post.referenceCID, existing);
                }
            }
        });

        const patchedMap = new Map<string, Post>();
        map.forEach((post, id) => {
            const localReplies = parentIndex.get(id) || [];
            const combinedReplies = Array.from(new Set([...(post.replies || []), ...localReplies]));
            
            patchedMap.set(id, { 
                ...post, 
                replies: combinedReplies 
            });
        });
        
        return patchedMap;
    }, [allPostsMap, threadPosts]);

    // --- INTEGRATED: Optimistic Root Logic ---
    // Fixes "Eternal Spinner" by showing the requested post immediately 
    // even if the parent thread is still loading or failed.
    const rootPostId = useMemo(() => {
        if (!displayCid) return null;
        
        let currentId = displayCid;
        let safety = 0;
        let foundTrueRoot = false;
        
        // Walk up the chain to find the Root
        while (postsForRender.has(currentId) && safety < 100) {
            const p = postsForRender.get(currentId);
            if (!p || !p.referenceCID) {
                foundTrueRoot = true;
                break; // Found root
            } 
            if (!postsForRender.has(p.referenceCID)) break; // Parent missing, stop here
            currentId = p.referenceCID;
            safety++;
        }

        // Fallback: If we have the requested post in memory, allow rendering it
        if (postsForRender.has(displayCid)) {
            // If we found a valid root, use it. Otherwise, use the farthest parent we found (or the post itself).
            return foundTrueRoot ? currentId : (postsForRender.has(currentId) ? currentId : displayCid);
        }

        return null;
    }, [displayCid, postsForRender]);

    const combinedProfilesMap = useMemo(() => {
        return new Map([...(globalProfilesMap || []), ...threadProfiles]);
    }, [globalProfilesMap, threadProfiles]);

    const [replyingToPost, setReplyingToPost] = useState<Post | null>(null);

    // --- Auto-Reply & Scroll Logic ---
    useEffect(() => {
        if (!displayCid || !postsForRender.size) return;

        if (location.state?.autoReply) {
             const target = postsForRender.get(displayCid);
             if (target) {
                 setReplyingToPost(target);
                 window.history.replaceState({ ...window.history.state, autoReply: false }, '');
             }
        }
        
        if (location.state?.scrollToId) {
             setTimeout(() => {
                 const el = document.getElementById(`post-${location.state.scrollToId}`);
                 if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
             }, 100);
        }
    }, [location.state, displayCid, postsForRender]);

    // --- KEYBOARD NAVIGATION (Arrow Keys) ---
    // Detect if we are in "Home Feed" mode (or direct link which defaults to main feed)
    const backgroundPath = location.state?.backgroundLocation?.pathname;
    const isHomeFeedMode = !backgroundPath || backgroundPath === '/' || backgroundPath === '';

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input/textarea
            if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

            let contextIds: string[] | undefined = location.state?.contextIds;
            let loadMoreFn: (() => Promise<void>) | null = null;

            // Priority: Live Unified Feed (if Home) -> Snapshot
            if (isHomeFeedMode && unifiedIds.length > 0) {
                contextIds = unifiedIds;
                loadMoreFn = loadMoreFeed;
            }

            if (e.key === 'Escape') {
                if (location.state?.backgroundLocation) {
                    navigate(-1);
                } else {
                    navigate('/');
                }
                return;
            }

            if (!contextIds) return;

            // Hybrid Search: Try Display ID first (My Feed), then Root ID (Explore Feed)
            // This handles cases where the feed contains replies directly vs just roots.
            let currentIndex = contextIds.indexOf(displayCid || '');
            if (currentIndex === -1 && rootPostId) {
                currentIndex = contextIds.indexOf(rootPostId);
            }

            // Fallback: If not found in unifiedIds, try the snapshot (e.g. Profile Page or Search)
            if (currentIndex === -1 && location.state?.contextIds && contextIds !== location.state.contextIds) {
                 contextIds = location.state.contextIds;
                 currentIndex = contextIds ? contextIds.indexOf(displayCid || '') : -1;
                 if (currentIndex === -1 && rootPostId && contextIds) currentIndex = contextIds.indexOf(rootPostId);
                 // Reset loadMoreFn as we are back to snapshot
                 loadMoreFn = null;
            }

            if (currentIndex === -1 || !contextIds) return;

            if (e.key === 'ArrowRight') {
                // Trigger Load More if near end
                if (loadMoreFn && currentIndex + 5 >= contextIds.length) {
                    loadMoreFn();
                }

                // Next Post
                if (currentIndex + 1 < contextIds.length) {
                    const nextId = contextIds[currentIndex + 1];
                    navigate(`/post/${nextId}`, { 
                        replace: true, // <--- Replace history entry instead of pushing
                        state: { ...location.state } 
                    });
                }
            } else if (e.key === 'ArrowLeft') {
                // Previous Post
                if (currentIndex > 0) {
                    const prevId = contextIds[currentIndex - 1];
                    navigate(`/post/${prevId}`, { 
                        replace: true, // <--- Replace history entry instead of pushing
                        state: { ...location.state } 
                    });
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [location.state, rootPostId, navigate, displayCid, unifiedIds, loadMoreFeed, isHomeFeedMode]);

    // Auto-Explore on Scroll
    const loaderRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const observer = new IntersectionObserver(
            entries => {
                const target = entries[0];
                if (target.isIntersecting && canLoadMoreExplore && !isLoadingExplore) {
                    loadMoreExplore();
                }
            },
            { root: modalContainerRef.current, rootMargin: '200px', threshold: 0.1 }
        );

        if (loaderRef.current) observer.observe(loaderRef.current);
        return () => { if (loaderRef.current) observer.unobserve(loaderRef.current); };
    }, [canLoadMoreExplore, isLoadingExplore, loadMoreExplore]);


    const handleClose = () => {
        if (location.state?.backgroundLocation) {
            navigate(-1);
        } else {
            navigate('/');
        }
    };

    const renderContent = () => {
        if (error) return (
            <div className="error-message">
                <p>{error}</p>
                <button onClick={() => navigate('/')}>Go Home</button>
            </div>
        );

        // OPTIMISTIC LOADING CHECK:
        // Only show spinner if we have absolutely nothing to show (no root, no target).
        // If we have 'rootPostId', we can render content while background fetches continue.
        if (isLoading && !rootPostId) return (
            <div className="center-screen-loader">
                <LoadingSpinner />
                <p style={{ marginTop: '1rem', color: '#888' }}>Fetching conversation...</p>
            </div>
        );

        if (!rootPostId) return (
            <div className="error-message">
                <p>Post not found.</p>
                <button onClick={() => navigate('/')}>Go Home</button>
            </div>
        );

        return (
            <>
                <div style={{ paddingTop: '1rem' }}>
                    <PostComponent
                        postId={rootPostId}
                        allPostsMap={postsForRender}
                        userProfilesMap={combinedProfilesMap}
                        currentUserState={userState}
                        myPeerId={myPeerId}
                        
                        onSetReplyingTo={setReplyingToPost}
                        onViewProfile={(key) => navigate(`/profile/${key}`)}
                        
                        // --- INTEGRATED: Pass Actions ---
                        onLikePost={likePost}
                        onDislikePost={dislikePost}
                        ensurePostsAreFetched={ensurePostsAreFetched}
                        // --------------------------------
                        
                        isExpandedView={true}
                        renderReplies={true} 
                    />
                </div>

                <div ref={loaderRef} className="thread-explore-loader" style={{ padding: '2rem 0', textAlign: 'center', opacity: 0.7 }}>
                    {isLoadingExplore ? (
                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem' }}>
                            <LoadingSpinner /> 
                            <small>Scanning network...</small>
                        </div>
                    ) : canLoadMoreExplore ? (
                        <small>Scroll to explore...</small>
                    ) : (
                        <small>End of exploration.</small>
                    )}
                </div>

                {userState && replyingToPost && (
                    <div className="reply-form-container">
                        <NewPostForm 
                            replyingToPost={replyingToPost}
                            replyingToAuthorName={
                                replyingToPost ? 
                                (combinedProfilesMap.get(replyingToPost.authorKey)?.name || 'Unknown') 
                                : null
                            }
                            onAddPost={async (data) => {
                                await addPost(data);
                                setReplyingToPost(null); 
                            }}
                            onCancel={() => setReplyingToPost(null)}
                            isProcessing={isProcessing}
                            isCoolingDown={isCoolingDown}
                            countdown={countdown}
                        />
                    </div>
                )}
            </>
         );
     };

    return (
        <div
            className="expanded-post-backdrop"
            onClick={(e) => {
                if (e.target === e.currentTarget) handleClose();
            }}
        >
            <div
                ref={modalContainerRef}
                className="expanded-post-container"
                onClick={(e) => e.stopPropagation()}
            >
                {renderContent()}
            </div>
        </div>
    );
};

export default PostPage;