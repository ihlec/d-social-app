// fileName: src/features/profile/ProfilePage.tsx
import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { useParams, useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import ProfileHeader from './ProfileHeader'; // Corrected path
import Feed from '../feed/Feed'; // Corrected path
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAppState } from '../../state/useAppStorage';
import { resolveIpns, fetchUserStateChunk, invalidateSpecificIpnsCacheEntry } from '../../api/ipfsIpns';
import { UserState, Post, UserProfile, NewPostData } from '../../types';
import NewPostForm from '../feed/NewPostForm'; // Corrected path

// --- Feed types, helpers, DisplayData interface remain the same ---
type ProfileFeedType = 'posts' | 'likes' | 'dislikes';
const profileFeedOptions: { label: string; value: ProfileFeedType }[] = [
    { label: 'Posts', value: 'posts' }, { label: 'Likes', value: 'likes' }, { label: 'Dislikes', value: 'dislikes' },
];
const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post || post.timestamp === 0) return 0;
    let latestTimestamp = post.timestamp;
    if (post.replies && post.replies.length > 0) {
        for (const replyId of post.replies) {
            if (replyId) {
                const replyTimestamp = getLatestActivityTimestamp(replyId, postsMap);
                if (replyTimestamp > 0 && replyTimestamp > latestTimestamp) {
                    latestTimestamp = replyTimestamp;
                }
            }
        }
    }
    return latestTimestamp;
};

const buildPostTree = (postMap: Map<string, Post>): { topLevelIds: string[], postsWithReplies: Map<string, Post> } => {
    const postsWithReplies = new Map<string, Post>();
    const topLevelIds = new Set<string>();
    postMap.forEach((post, id) => {
        if (post && id) {
            postsWithReplies.set(id, { ...post, replies: [] });
            topLevelIds.add(id);
        }
    });
    postsWithReplies.forEach(post => {
        if (post && post.referenceCID && postsWithReplies.has(post.referenceCID)) {
            const parent = postsWithReplies.get(post.referenceCID);
            if (parent) {
                if (!parent.replies) parent.replies = [];
                if (post.id) {
                    parent.replies.push(post.id);
                    topLevelIds.delete(post.id);
                }
            }
        }
    });
    return { topLevelIds: Array.from(topLevelIds), postsWithReplies };
};
interface DisplayData {
    topLevelIds: string[];
    postsWithReplies: Map<string, Post>;
    userProfilesMap: Map<string, UserProfile>;
}

interface PaginatedCidState {
    postCIDs: string[];
    likedPostCIDs: string[];
    dislikedPostCIDs: string[];
}


const ProfilePage: React.FC = () => {
    const { key: profileKey } = useParams<{ key: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const location = useLocation();
    const {
        myIpnsKey, userState: currentUserState,
        allPostsMap,
        userProfilesMap,
        likePost, dislikePost,
        addPost, isProcessing, isCoolingDown, countdown,
        ensurePostsAreFetched,
    } = useAppState();

    const [profileData, setProfileData] = useState<UserProfile | null>(null);
    const [paginatedCids, setPaginatedCids] = useState<PaginatedCidState>({ postCIDs: [], likedPostCIDs: [], dislikedPostCIDs: [] });
    const [nextChunkCid, setNextChunkCid] = useState<string | null>(null);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');
    const loaderRef = useRef<HTMLDivElement>(null);
    const [isLoaderVisible, setIsLoaderVisible] = useState(false);
    const [initialPostFetchComplete, setInitialPostFetchComplete] = useState(false);

    // --- START SCROLL LOCK ---
    const [isScrollLocked, setIsScrollLocked] = useState(false);
    // --- END SCROLL LOCK ---

    // --- START SCROLL RESTORATION ---
    const feedContainerRef = useRef<HTMLDivElement>(null);
    const scrollAnchorRef = useRef<{ id: string | null; top: number }>({ id: null, top: 0 });
    const isRestoringScroll = useRef(false);
    const wasLoadingMore = useRef(false);
    // --- END SCROLL RESTORATION ---

    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);

    const handleAddPost = (postData: NewPostData) => { addPost(postData); };

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

    // --- useEffect for modal navigation remains the same ---
    useEffect(() => {
        // ... (effect logic unchanged) ...
        const modalPostId = searchParams.get('modal_post');
        if (modalPostId) {
            const backgroundLoc = { ...location, search: '', };
            navigate(`/post/${modalPostId}`, { state: { backgroundLocation: backgroundLoc }, replace: true });
        }
     }, [searchParams, navigate, location]);

    // --- useEffect for initial profile load remains the same ---
     useEffect(() => {
        // ... (effect logic unchanged) ...
        if (!profileKey) {
            setError("No profile key provided."); setIsProfileLoading(false); navigate("/"); return;
        }

        setIsProfileLoading(true);
        setError(null);
        setNextChunkCid(null);
        setProfileData(null);
        setPaginatedCids({ postCIDs: [], likedPostCIDs: [], dislikedPostCIDs: [] });
        setInitialPostFetchComplete(false);
        let isMounted = true;

        const loadInitialProfileChunk = async () => {
            let userStateChunk: Partial<UserState> | null = null;
            let initialPostsToFetch: string[] = [];

            try {
                invalidateSpecificIpnsCacheEntry(profileKey);
                const profileStateCid = await resolveIpns(profileKey);
                console.log(`[ProfilePage loadProfile] Resolved ${profileKey} to CID: ${profileStateCid}`);
                userStateChunk = await fetchUserStateChunk(profileStateCid, profileKey);

                if (!isMounted) return;
                if (!userStateChunk || !userStateChunk.profile) {
                    throw new Error("Could not load user profile from head chunk.");
                }

                setProfileData(userStateChunk.profile);
                setPaginatedCids({
                    postCIDs: userStateChunk.postCIDs || [],
                    likedPostCIDs: userStateChunk.likedPostCIDs || [],
                    dislikedPostCIDs: userStateChunk.dislikedPostCIDs || []
                });
                setNextChunkCid(userStateChunk.extendedUserState || null);
                console.log(`[ProfilePage loadProfile] Initial nextChunkCid set to: ${userStateChunk.extendedUserState || null}`);

                const postCids = userStateChunk.postCIDs || [];
                const likedCids = userStateChunk.likedPostCIDs || [];
                const dislikedCids = userStateChunk.dislikedPostCIDs || [];
                const allCids = [...new Set([...postCids, ...likedCids, ...dislikedCids])];
                initialPostsToFetch = allCids.filter(cid => cid && !cid.startsWith('temp-') && !allPostsMap.has(cid));

            } catch (err) {
                 console.error("Error loading profile page:", err);
                 if (isMounted) {
                     setError(err instanceof Error ? err.message : "Failed to load profile.");
                     toast.error("Could not load this profile.");
                 }
              }
             finally { if (isMounted) { setIsProfileLoading(false); } }

            // Trigger initial post fetch (don't await)
            if (initialPostsToFetch.length > 0 && profileKey && isMounted) {
                 console.log(`[ProfilePage] Found ${initialPostsToFetch.length} initial posts to fetch (lazy)...`);
                 ensurePostsAreFetched(initialPostsToFetch, profileKey)
                     .catch(e => console.error(`[ProfilePage] Initial lazy post fetch failed: ${e}`))
                     .finally(() => {
                          if(isMounted) {
                              setInitialPostFetchComplete(true);
                              console.log("[ProfilePage] Initial post fetch complete flag set.");
                          }
                     });
            } else {
                 if(isMounted) {
                     setInitialPostFetchComplete(true);
                     console.log("[ProfilePage] No initial posts needed, complete flag set.");
                 }
            }
        };

        loadInitialProfileChunk();
        return () => { isMounted = false; };

    }, [profileKey, navigate, allPostsMap, ensurePostsAreFetched]);


    // --- loadMoreProfileChunks useCallback ---
    const loadMoreProfileChunks = useCallback(async () => {
        if (!nextChunkCid || isLoadingMore || !profileKey) return;

        console.log(`[ProfilePage] Loading next chunk: ${nextChunkCid}`);
        setIsLoadingMore(true);
        wasLoadingMore.current = true; // Set flag for scroll restoration
        // --- START MODIFICATION: Add scroll lock ---
        setIsScrollLocked(true); // Disable scrolling
        // --- END MODIFICATION ---
        let fetchedNextChunkSuccessfully = false;
        let missingNewCids: string[] = [];

        try {
            const nextChunk = await fetchUserStateChunk(nextChunkCid, profileKey);

            if (!nextChunk) {
                 console.error(`[ProfilePage] fetchUserStateChunk returned invalid data for CID: ${nextChunkCid}`);
                 throw new Error("Failed to fetch next valid chunk data.");
            }
            fetchedNextChunkSuccessfully = true;

            // Immediately update the list of CIDs the UI knows about
            setPaginatedCids(prevCids => ({
                postCIDs: [...new Set([...(prevCids.postCIDs || []), ...(nextChunk.postCIDs || [])])],
                likedPostCIDs: [...new Set([...(prevCids.likedPostCIDs || []), ...(nextChunk.likedPostCIDs || [])])],
                dislikedPostCIDs: [...new Set([...(prevCids.dislikedPostCIDs || []), ...(nextChunk.dislikedPostCIDs || [])])],
            }));

            // Set the *next* cursor based ONLY on the successfully fetched chunk
            const nextCursor = nextChunk.extendedUserState || null;
            setNextChunkCid(nextCursor);
            console.log(`[ProfilePage] Next chunk CID set to: ${nextCursor}`);

            // Identify content needing fetch
            const allNewCids = [
                ...(nextChunk.postCIDs || []),
                ...(nextChunk.likedPostCIDs || []),
                ...(nextChunk.dislikedPostCIDs || [])
            ];
            missingNewCids = [...new Set(allNewCids)].filter(
                (cid): cid is string => !!cid && !cid.startsWith('temp-') && !allPostsMap.has(cid)
            );

            // Await ensurePostsAreFetched
            if (missingNewCids.length > 0) {
                 console.log(`[ProfilePage] Found ${missingNewCids.length} new posts in chunk to fetch... AWAITING FETCH.`);
                await ensurePostsAreFetched(missingNewCids, profileKey); // Wait for content
                 console.log(`[ProfilePage] Finished fetching ${missingNewCids.length} new posts.`);
            } else {
                 console.log("[ProfilePage] Load more checked, no new posts found in chunk.");
            }

        } catch (e) {
            console.error("[ProfilePage] Failed to load or process next chunk:", e);
            toast.error(e instanceof Error ? e.message : "Failed to load more content.");
             wasLoadingMore.current = false; // Reset flag on error
            if (!fetchedNextChunkSuccessfully) {
                 console.warn("[ProfilePage] Keeping existing nextChunkCid due to chunk fetch failure.");
            }
        } finally {
             setIsLoadingMore(false);
             console.log("[ProfilePage] Finished loading more attempt, isLoadingMore set to false.");
        }
    }, [nextChunkCid, isLoadingMore, profileKey, allPostsMap, ensurePostsAreFetched]);


    // --- displayData useMemo remains the same ---
     const displayData = useMemo((): DisplayData => {
        // ... (memo logic unchanged) ...
        const profileMapToUse: Map<string, UserProfile> = userProfilesMap;

        if (!profileData) {
            return { topLevelIds: [], postsWithReplies: new Map(), userProfilesMap: profileMapToUse };
        }

        const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(allPostsMap);

        let targetCids: Set<string>;
        let filteredTopLevelIds: string[];
        const dislikedSet = new Set(currentUserState?.dislikedPostCIDs || []);

        switch (selectedFeed) {
            case 'posts':
                targetCids = new Set<string>();
                allPostsMap.forEach((post, cid) => {
                    if (post.authorKey === profileKey) { targetCids.add(cid); }
                });
                filteredTopLevelIds = allTopLevelIds.filter(id =>
                    (paginatedCids.postCIDs || []).includes(id) && targetCids.has(id)
                );
                break;
            case 'likes':
                targetCids = new Set(paginatedCids.likedPostCIDs || []);
                filteredTopLevelIds = allTopLevelIds
                    .filter(id => targetCids.has(id))
                    .filter(id => !dislikedSet.has(id));
                break;
            case 'dislikes':
                targetCids = new Set(paginatedCids.dislikedPostCIDs || []);
                filteredTopLevelIds = allTopLevelIds.filter(id => targetCids.has(id));
                break;
            default:
                filteredTopLevelIds = [];
        }

        const sortedTopLevelIds = filteredTopLevelIds.sort((a, b) => {
            const latestA = getLatestActivityTimestamp(a, postsWithReplies);
            const latestB = getLatestActivityTimestamp(b, postsWithReplies);
            return latestB - latestA;
        });

        if (profileKey && !profileMapToUse.has(profileKey) && profileData) {
            const newProfileMap = new Map(profileMapToUse);
            newProfileMap.set(profileKey, profileData);
            return { topLevelIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: newProfileMap };
        }
        return { topLevelIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: profileMapToUse };
     }, [paginatedCids, profileData, selectedFeed, profileKey, allPostsMap, userProfilesMap, currentUserState?.dislikedPostCIDs]);

    // --- Observer useEffect remains the same ---
     useEffect(() => {
        // ... (effect logic unchanged) ...
        const observer = new IntersectionObserver(
            (entries) => {
                const firstEntry = entries[0];
                setIsLoaderVisible(firstEntry.isIntersecting);
                console.log(`[IntersectionObserver ProfilePage] Visibility Changed: ${firstEntry.isIntersecting}`);
            },
            { threshold: 0 }
        );

        const currentLoaderRef = loaderRef.current;
        if (currentLoaderRef) {
            console.log("[IntersectionObserver ProfilePage] Attaching observer...");
            observer.observe(currentLoaderRef);
        } else {
             console.log("[IntersectionObserver ProfilePage] Ref not ready, not attaching observer.");
        }

        return () => {
            if (currentLoaderRef) {
                console.log("[IntersectionObserver ProfilePage] Detaching observer...");
                observer.unobserve(currentLoaderRef);
            }
            setIsLoaderVisible(false);
        };
    }, [profileKey, isProfileLoading, profileData]);

    // --- Trigger useEffect remains the same ---
     useEffect(() => {
        // ... (effect logic unchanged, including anchor capture) ...
        if (isLoaderVisible && initialPostFetchComplete) {
            const canLoadMoreNow = nextChunkCid !== null;
            console.log(`[LoadMore Trigger Check ProfilePage] Loader is visible! canLoadMoreNow: ${canLoadMoreNow}, isLoadingMore: ${isLoadingMore}`);

            // --- START MODIFICATION: Add scroll lock condition ---
            if (canLoadMoreNow && !isLoadingMore && !isScrollLocked) {
            // --- END MODIFICATION ---
                // --- START SCROLL RESTORATION: Capture anchor before loading ---
                if (feedContainerRef.current) {
                    const posts = feedContainerRef.current.querySelectorAll('.post[data-post-id]');
                    let bestCandidate: { id: string | null, top: number } = { id: null, top: Infinity };
                    posts.forEach(postElement => {
                        const rect = postElement.getBoundingClientRect();
                        if (rect.bottom > -50 && rect.top < bestCandidate.top) { // Allow slightly above viewport
                            bestCandidate = { id: postElement.getAttribute('data-post-id'), top: rect.top };
                        }
                    });
                     if (bestCandidate.id) {
                         scrollAnchorRef.current = bestCandidate;
                         console.log(`[Scroll Anchor Set - Profile] ID: ${bestCandidate.id}, Top: ${bestCandidate.top}`);
                     } else {
                         scrollAnchorRef.current = { id: null, top: 0 };
                         console.log("[Scroll Anchor Set - Profile] No suitable anchor found.");
                     }
                } else {
                     scrollAnchorRef.current = { id: null, top: 0 };
                     console.log("[Scroll Anchor Set - Profile] Feed container ref not found.");
                }
                // --- END SCROLL RESTORATION ---

                console.log("[LoadMore Trigger ProfilePage] Conditions met, calling loadMoreProfileChunks...");
                // wasLoadingMore.current is set inside loadMoreProfileChunks now
                loadMoreProfileChunks();
            }
        } else if (isLoaderVisible) {
             console.log(`[LoadMore Trigger Check ProfilePage] Loader visible but initialPostFetchComplete is ${initialPostFetchComplete}`);
        }
    }, [isLoaderVisible, isLoadingMore, loadMoreProfileChunks, initialPostFetchComplete, nextChunkCid, isScrollLocked]);

    // --- Scroll Restoration useLayoutEffect remains the same ---
     useLayoutEffect(() => {
        // ... (effect logic unchanged, using requestAnimationFrame) ...
        if (wasLoadingMore.current && !isLoadingMore && scrollAnchorRef.current.id && !isRestoringScroll.current) {
            const anchorId = scrollAnchorRef.current.id;
            const storedTop = scrollAnchorRef.current.top;
            console.log(`[Scroll Restore Attempt - Profile] Anchor ID: ${anchorId}, Stored Top: ${storedTop}`);

            const rafId = requestAnimationFrame(() => {
                const anchorElement = feedContainerRef.current?.querySelector(`[data-post-id="${anchorId}"]`);

                if (anchorElement) {
                    const newRect = anchorElement.getBoundingClientRect();
                    const scrollOffset = newRect.top - storedTop;
                    console.log(`[Scroll Restore Calc - Profile] New Top: ${newRect.top}, Diff: ${scrollOffset}`);

                    if (Math.abs(scrollOffset) > 1) {
                        isRestoringScroll.current = true;
                        window.scrollBy({ top: scrollOffset, left: 0, behavior: 'instant' });
                        console.log(`[Scroll Restore Action - Profile] Scrolled by ${scrollOffset}px`);
                        requestAnimationFrame(() => { isRestoringScroll.current = false; });
                    } else {
                        isRestoringScroll.current = false;
                    }
                } else {
                    console.warn(`[Scroll Restore Failed - Profile] Anchor element ${anchorId} not found after load.`);
                    isRestoringScroll.current = false;
                }
            });

            wasLoadingMore.current = false;
            scrollAnchorRef.current = { id: null, top: 0 };

            return () => {
                cancelAnimationFrame(rafId);
                 isRestoringScroll.current = false;
            };
        } else if (!isLoadingMore && wasLoadingMore.current) {
             wasLoadingMore.current = false;
             scrollAnchorRef.current = { id: null, top: 0 };
        }
    }, [isLoadingMore, displayData.topLevelIds, paginatedCids]);


    // --- Loading/Error checks remain the same ---
    if (!profileKey) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: No profile key provided.</p></div>;
    if (isProfileLoading && !profileData) return <LoadingSpinner />;
    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;
    if (!profileData) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Profile not found.</p></div>;

    const canLoadMore = nextChunkCid !== null;

    return (
        <div className="app-container">
            {/* --- Add ref to main content --- */}
            <div ref={feedContainerRef} className="main-content">
                <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
                {profileData && (
                    <ProfileHeader profileKey={profileKey} profile={profileData} isMyProfile={isMyProfile} />
                )}
                {isMyProfile && ( <NewPostForm
                    replyingToPost={null} replyingToAuthorName={null}
                    onAddPost={handleAddPost}
                    isProcessing={isProcessing}
                    isCoolingDown={isCoolingDown}
                    countdown={countdown}
                /> )}
                <>
                    <div className="feed-selector">
                        {profileFeedOptions.map(option => (
                            <button key={option.value} className={selectedFeed === option.value ? 'active' : ''}
                                onClick={() => setSelectedFeed(option.value)} >
                                {option.label}
                            </button>
                        ))}
                    </div>
                    {/* --- Feed component --- */}
                    <Feed
                        isLoading={isProfileLoading && displayData.topLevelIds.length === 0}
                        topLevelIds={displayData.topLevelIds || []}
                        allPostsMap={displayData.postsWithReplies}
                        userProfilesMap={displayData.userProfilesMap}
                        onViewProfile={(key) => navigate(`/profile/${key}`)} currentUserState={currentUserState}
                        myIpnsKey={myIpnsKey} onLikePost={currentUserState ? likePost : undefined}
                        onDislikePost={currentUserState ? dislikePost : undefined}
                        ensurePostsAreFetched={ensurePostsAreFetched}
                    />
                    {/* --- Loader ref and indicator --- */}
                    <div ref={loaderRef} style={{ height: '50px', marginTop: '1rem', width: '100%' }}>
                        {isLoadingMore && (
                            <LoadingSpinner />
                        )}
                        {!isLoadingMore && !canLoadMore && displayData.topLevelIds.length > 0 && (
                            <p style={{ color: 'var(--text-secondary-color)'}}>End of content.</p>
                        )}
                    </div>
                </>
            </div>
        </div>
    );
};

export default ProfilePage;