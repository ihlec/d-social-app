import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import PostComponent from '../features/feed/PostItem';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAppState } from '../state/useAppStorage';
import { Post } from '../types';
import NewPostForm from '../features/feed/NewPostForm';
import { useThreadFetcher } from '../hooks/useThreadFetcher';
import { isPeerId, sanitizeText } from '../lib/utils';
import { startHelia } from '../api/heliaNode';
import { ensureContentRoom, leaveContentRoom, publishContentWant } from '../api/pubsub';
import { WANT_PUBLISH_MIN_INTERVAL_MS } from '../constants';

const PostPage: React.FC = () => {
    const { cid: routeCid } = useParams<{ cid: string }>();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const location = useLocation();
    const modalContainerRef = useRef<HTMLDivElement>(null);

    const displayCid = routeCid;
    const authorFromShare = (() => {
        const a = (searchParams.get('a') || '').trim();
        return isPeerId(a) ? a : '';
    })();

    const {
        allPostsMap,
        userProfilesMap: globalProfilesMap,
        addPost,
        userState,
        myPeerId,
        isLoggedIn,
        isProcessing,
        isCoolingDown,
        countdown,
        loadMoreExplore,
        isLoadingExplore,
        canLoadMoreExplore,
        unifiedIds,
        loadMoreFeed,
        likePost,
        dislikePost,
        savePost,
        ensurePostsAreFetched,
    } = useAppState();

    const [contentRoomReady, setContentRoomReady] = useState(false);

    // Thread fetch runs immediately (local CAS / author `?a=`). Content room joins in parallel.
    const {
        threadPosts,
        threadProfiles,
        isLoading,
        error,
        reloadThread,
    } = useThreadFetcher(displayCid, allPostsMap, globalProfilesMap, authorFromShare);

    const hasPost = !!(displayCid && (threadPosts.has(displayCid) || allPostsMap.has(displayCid)));

    useEffect(() => {
        if (!displayCid) {
            setContentRoomReady(false);
            return;
        }
        let cancelled = false;
        setContentRoomReady(false);

        const run = async () => {
            try {
                await startHelia();
                if (cancelled) return;
                // One retry only — join budget is tight when arrow-key navigating.
                let joined = await ensureContentRoom(displayCid, { sticky: true });
                if (!joined && !cancelled) {
                    await new Promise((r) => setTimeout(r, 500));
                    if (!cancelled) joined = await ensureContentRoom(displayCid, { sticky: true });
                }
                if (cancelled) {
                    await leaveContentRoom(displayCid);
                    return;
                }
                void publishContentWant(displayCid);
                setContentRoomReady(true);
            } catch (e) {
                console.debug('[PostPage] content room join failed', e);
                if (!cancelled) setContentRoomReady(true);
            }
        };

        void run();
        return () => {
            cancelled = true;
            void leaveContentRoom(displayCid);
        };
    }, [displayCid]);

    // After sticky join, retry once if local/author path missed (holder may now be in-room).
    const roomRetryCidRef = useRef<string | null>(null);
    useEffect(() => {
        if (!displayCid || !contentRoomReady || hasPost || isLoading) return;
        if (roomRetryCidRef.current === displayCid) return;
        roomRetryCidRef.current = displayCid;
        void reloadThread();
    }, [displayCid, contentRoomReady, hasPost, isLoading, reloadThread]);

    useEffect(() => {
        roomRetryCidRef.current = null;
    }, [displayCid]);

    // PostPage owns want pulses for the open root CID until the post arrives.
    useEffect(() => {
        if (!displayCid || hasPost) return;
        let cancelled = false;
        const tick = () => {
            if (!cancelled) void publishContentWant(displayCid);
        };
        tick();
        const id = window.setInterval(tick, WANT_PUBLISH_MIN_INTERVAL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [displayCid, hasPost]);

    const postsForRender = useMemo(() => {
        const map = new Map([...allPostsMap, ...threadPosts]);
        const parentIndex = new Map<string, string[]>();

        map.forEach((post) => {
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
            patchedMap.set(id, { ...post, replies: combinedReplies });
        });

        return patchedMap;
    }, [allPostsMap, threadPosts]);

    /** Nearest renderable ancestor (or the post itself) so UI can show before full thread arrives. */
    const rootPostId = useMemo(() => {
        if (!displayCid) return null;

        let currentId = displayCid;
        let safety = 0;
        let foundTrueRoot = false;

        while (postsForRender.has(currentId) && safety < 100) {
            const p = postsForRender.get(currentId);
            if (!p || !p.referenceCID) {
                foundTrueRoot = true;
                break;
            }
            if (!postsForRender.has(p.referenceCID)) break;
            currentId = p.referenceCID;
            safety++;
        }

        if (postsForRender.has(displayCid)) {
            return foundTrueRoot ? currentId : (postsForRender.has(currentId) ? currentId : displayCid);
        }

        return null;
    }, [displayCid, postsForRender]);

    const combinedProfilesMap = useMemo(() => {
        return new Map([...(globalProfilesMap || []), ...threadProfiles]);
    }, [globalProfilesMap, threadProfiles]);

    const [replyingToPost, setReplyingToPost] = useState<Post | null>(null);

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

    const backgroundPath = location.state?.backgroundLocation?.pathname;
    const isHomeFeedMode = !backgroundPath || backgroundPath === '/' || backgroundPath === '';

    useEffect(() => {
        if (!isLoggedIn) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

            let contextIds: string[] | undefined = location.state?.contextIds;
            let loadMoreFn: (() => Promise<void>) | null = null;

            if (isHomeFeedMode && unifiedIds.length > 0) {
                contextIds = unifiedIds;
                loadMoreFn = loadMoreFeed;
            }

            if (e.key === 'Escape') {
                if (location.state?.backgroundLocation) navigate(-1);
                else navigate('/');
                return;
            }

            if (!contextIds) return;

            let currentIndex = contextIds.indexOf(displayCid || '');
            if (currentIndex === -1 && rootPostId) {
                currentIndex = contextIds.indexOf(rootPostId);
            }

            if (currentIndex === -1 && location.state?.contextIds && contextIds !== location.state.contextIds) {
                contextIds = location.state.contextIds;
                currentIndex = contextIds ? contextIds.indexOf(displayCid || '') : -1;
                if (currentIndex === -1 && rootPostId && contextIds) {
                    currentIndex = contextIds.indexOf(rootPostId);
                }
                loadMoreFn = null;
            }

            if (currentIndex === -1 || !contextIds) return;

            if (e.key === 'ArrowRight') {
                if (loadMoreFn && currentIndex + 5 >= contextIds.length) {
                    loadMoreFn();
                }
                if (currentIndex + 1 < contextIds.length) {
                    const nextId = contextIds[currentIndex + 1];
                    navigate(`/post/${nextId}`, {
                        replace: true,
                        state: { ...location.state },
                    });
                }
            } else if (e.key === 'ArrowLeft') {
                if (currentIndex > 0) {
                    const prevId = contextIds[currentIndex - 1];
                    navigate(`/post/${prevId}`, {
                        replace: true,
                        state: { ...location.state },
                    });
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [location.state, rootPostId, navigate, displayCid, unifiedIds, loadMoreFeed, isHomeFeedMode, isLoggedIn]);

    const loaderRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isLoggedIn) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const target = entries[0];
                if (target.isIntersecting && canLoadMoreExplore && !isLoadingExplore) {
                    loadMoreExplore();
                }
            },
            { root: modalContainerRef.current, rootMargin: '200px', threshold: 0.1 }
        );

        if (loaderRef.current) observer.observe(loaderRef.current);
        return () => {
            if (loaderRef.current) observer.unobserve(loaderRef.current);
        };
    }, [canLoadMoreExplore, isLoadingExplore, loadMoreExplore, isLoggedIn]);

    const handleClose = () => {
        if (location.state?.backgroundLocation) navigate(-1);
        else if (isLoggedIn) navigate('/');
        else navigate('/login');
    };

    const guestLoginCta = !isLoggedIn ? (
        <div
            style={{
                margin: '1rem 0',
                padding: '0.75rem 1rem',
                textAlign: 'center',
                borderTop: '1px solid rgba(128,128,128,0.25)',
            }}
        >
            <p style={{ margin: '0 0 0.5rem', color: '#888', fontSize: '0.9rem' }}>
                Log in to follow, like, and use your feed.
            </p>
            <button type="button" className="save-button" onClick={() => navigate('/login')}>
                Log in
            </button>
        </div>
    ) : null;

    const offlineEmpty = (
        <div className="error-message" style={{ textAlign: 'center' }}>
            <p>Peer offline — not cached.</p>
            <p style={{ color: '#888', fontSize: '0.9rem', maxWidth: '28rem', margin: '0.5rem auto 1rem' }}>
                The author or someone who Saved this must be online. They do not need this post open.
                Share links from the Share button include the author (<code>?a=</code>) for a faster path.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                    type="button"
                    className="save-button"
                    onClick={() => {
                        void publishContentWant(displayCid || '');
                        void reloadThread();
                    }}
                >
                    Retry
                </button>
                {!isLoggedIn ? (
                    <button type="button" className="cancel-button" onClick={() => navigate('/login')}>
                        Log in
                    </button>
                ) : (
                    <button type="button" className="cancel-button" onClick={handleClose}>
                        Go Home
                    </button>
                )}
            </div>
        </div>
    );

    const renderContent = () => {
        if (error && !rootPostId) return offlineEmpty;

        if (isLoading && !rootPostId) {
            return (
                <div className="center-screen-loader">
                    <LoadingSpinner />
                    <p style={{ marginTop: '1rem', color: '#888' }}>
                        Waiting for a peer who has this…
                    </p>
                    <p style={{ marginTop: '0.5rem', color: '#666', fontSize: '0.85rem' }}>
                        {authorFromShare
                            ? 'Contacting the author, then peers who Saved this…'
                            : 'Contacting peers who Saved this…'}
                    </p>
                </div>
            );
        }

        if (!rootPostId) return offlineEmpty;

        return (
            <>
                <div style={{ paddingTop: '1rem' }}>
                    <PostComponent
                        postId={rootPostId}
                        allPostsMap={postsForRender}
                        userProfilesMap={combinedProfilesMap}
                        currentUserState={userState}
                        myPeerId={myPeerId}
                        onSetReplyingTo={isLoggedIn ? setReplyingToPost : undefined}
                        onViewProfile={(key) => navigate(`/profile/${key}`)}
                        onLikePost={isLoggedIn ? likePost : undefined}
                        onDislikePost={isLoggedIn ? dislikePost : undefined}
                        onSavePost={isLoggedIn ? savePost : undefined}
                        ensurePostsAreFetched={ensurePostsAreFetched}
                        isExpandedView={true}
                        renderReplies={true}
                    />
                </div>

                {guestLoginCta}

                {isLoggedIn && (
                    <div
                        ref={loaderRef}
                        className="thread-explore-loader"
                        style={{ padding: '2rem 0', textAlign: 'center', opacity: 0.7 }}
                    >
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
                )}

                {userState && replyingToPost && (
                    <div className="reply-form-container">
                        <NewPostForm
                            replyingToPost={replyingToPost}
                            replyingToAuthorName={
                                replyingToPost
                                    ? sanitizeText(combinedProfilesMap.get(replyingToPost.authorKey)?.name) || 'Unknown'
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
