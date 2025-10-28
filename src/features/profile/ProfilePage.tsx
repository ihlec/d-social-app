// fileName: src/features/profile/ProfilePage.tsx
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import ProfileHeader from './ProfileHeader'; // Corrected path
import Feed from '../feed/Feed'; // Corrected path
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAppState } from '../../state/useAppStorage';
import { resolveIpns, fetchUserStateChunk } from '../../api/ipfsIpns';
import { UserState, Post, UserProfile, NewPostData } from '../../types';
import NewPostForm from '../feed/NewPostForm'; // Corrected path

// --- Feed types and helper functions remain the same ---
type ProfileFeedType = 'posts' | 'likes' | 'dislikes';
const profileFeedOptions: { label: string; value: ProfileFeedType }[] = [
    { label: 'Posts', value: 'posts' }, { label: 'Likes', value: 'likes' }, { label: 'Dislikes', value: 'dislikes' },
];
const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post) return 0;
    let latestTimestamp = post.timestamp;
    if (post.replies && post.replies.length > 0) {
        for (const replyId of post.replies) {
            const replyTimestamp = getLatestActivityTimestamp(replyId, postsMap);
            if (replyTimestamp > latestTimestamp) {
                latestTimestamp = replyTimestamp;
            }
        }
    }
    return latestTimestamp;
};

const buildPostTree = (postMap: Map<string, Post>): { topLevelIds: string[], postsWithReplies: Map<string, Post> } => {
    const postsWithReplies = new Map<string, Post>();
    const topLevelIds = new Set<string>();
    postMap.forEach((post, id) => {
        postsWithReplies.set(id, { ...post, replies: [] }); // Initialize replies
        topLevelIds.add(id); // Assume all are top-level initially
    });
    postsWithReplies.forEach(post => {
        if (post.referenceCID && postsWithReplies.has(post.referenceCID)) {
            const parent = postsWithReplies.get(post.referenceCID);
            if (parent) {
                if (!parent.replies) parent.replies = [];
                parent.replies.push(post.id);
                topLevelIds.delete(post.id); // It's a reply, not top-level
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

    const [profileUserState, setProfileUserState] = useState<UserState | null>(null);
    const [nextChunkCid, setNextChunkCid] = useState<string | null>(null);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');
    const loaderRef = useRef<HTMLDivElement>(null);
    const [isLoaderVisible, setIsLoaderVisible] = useState(false);

    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);

    const handleAddPost = (postData: NewPostData) => { addPost(postData); };

    // --- useEffect for modal navigation remains the same ---
    useEffect(() => {
        const modalPostId = searchParams.get('modal_post');
        if (modalPostId) {
            const backgroundLoc = { ...location, search: '', };
            navigate(`/post/${modalPostId}`, { state: { backgroundLocation: backgroundLoc }, replace: true });
        }
     }, [searchParams, navigate, location]);

    // --- useEffect for initial profile load remains the same ---
    useEffect(() => {
        if (!profileKey) {
            setError("No profile key provided."); setIsProfileLoading(false); navigate("/"); return;
        }
        const loadProfile = async () => {
             setIsProfileLoading(true); setError(null);
             setNextChunkCid(null); // Reset chunk state
             let userStateChunk: Partial<UserState> | null = null;
             try {
                 const profileStateCid = await resolveIpns(profileKey);
                 userStateChunk = await fetchUserStateChunk(profileStateCid, profileKey);

                 if (!userStateChunk || !userStateChunk.profile) throw new Error("Could not load user profile from head chunk.");

                 setProfileUserState(userStateChunk as UserState);
                 setNextChunkCid(userStateChunk.extendedUserState || null);

             } catch (err) {
                 console.error("Error loading profile page:", err);
                 setError(err instanceof Error ? err.message : "Failed to load profile.");
                 toast.error("Could not load this profile.");
              }
             finally { setIsProfileLoading(false); }

             if (userStateChunk) {
                const postCids = userStateChunk.postCIDs || [];
                const likedCids = userStateChunk.likedPostCIDs || [];
                const dislikedCids = userStateChunk.dislikedPostCIDs || [];

                const allCids = [...new Set([...postCids, ...likedCids, ...dislikedCids])];

                const missingCids = allCids.filter(cid => cid && !cid.startsWith('temp-') && !allPostsMap.has(cid));

                if (missingCids.length > 0) {
                    console.log(`[ProfilePage] Found ${missingCids.length} posts to fetch (lazy)...`);
                    ensurePostsAreFetched(missingCids, profileKey)
                        .catch(e => console.error(`[ProfilePage] Lazy fetch failed: ${e}`));
                }
             }
        };
        loadProfile();
    }, [profileKey, navigate, ensurePostsAreFetched, allPostsMap]); // Ensure dependencies are minimal for profile change

    // --- loadMoreProfileChunks useCallback remains the same ---
    const loadMoreProfileChunks = useCallback(async () => {
        // Condition check at the beginning remains crucial
        if (!nextChunkCid || isLoadingMore || !profileKey) return;

        console.log(`[ProfilePage] Loading next chunk: ${nextChunkCid}`);
        setIsLoadingMore(true);
        let fetchedNextChunkSuccessfully = false; // Flag to track chunk fetch status

        try {
            const nextChunk = await fetchUserStateChunk(nextChunkCid, profileKey);

            if (!nextChunk) {
                 // Explicitly handle case where chunk fetch returns nothing valid
                 console.error(`[ProfilePage] fetchUserStateChunk returned invalid data for CID: ${nextChunkCid}`);
                 throw new Error("Failed to fetch next valid chunk data.");
            }
            fetchedNextChunkSuccessfully = true; // Mark as successful

            // Merge the new chunk CIDs into the existing state
            setProfileUserState(prevState => {
                if (!prevState) return null;
                return {
                    ...prevState,
                    postCIDs: [...new Set([...prevState.postCIDs, ...(nextChunk.postCIDs || [])])],
                    likedPostCIDs: [...new Set([...(prevState.likedPostCIDs || []), ...(nextChunk.likedPostCIDs || [])])],
                    dislikedPostCIDs: [...new Set([...(prevState.dislikedPostCIDs || []), ...(nextChunk.dislikedPostCIDs || [])])],
                };
            });

            // Set the *next* cursor based ONLY on the successfully fetched chunk
            const nextCursor = nextChunk.extendedUserState || null;
            setNextChunkCid(nextCursor);
            console.log(`[ProfilePage] Next chunk CID set to: ${nextCursor}`); // <-- Added log

            // Fetch content for newly discovered posts from the VALID chunk
            const allNewCids = [
                ...(nextChunk.postCIDs || []),
                ...(nextChunk.likedPostCIDs || []),
                ...(nextChunk.dislikedPostCIDs || [])
            ];
            const missingNewCids = [...new Set(allNewCids)].filter(cid => cid && !cid.startsWith('temp-') && !allPostsMap.has(cid));


            if (missingNewCids.length > 0) {
                 console.log(`[ProfilePage] Found ${missingNewCids.length} new posts in chunk to fetch...`);
                 // Await ensurePostsAreFetched to keep loading indicator until posts are processed
                await ensurePostsAreFetched(missingNewCids, profileKey);
                toast.success(`Loaded ${missingNewCids.length} more items.`);
            } else {
                 console.log("[ProfilePage] Load more checked, no new posts found in chunk.");
                 toast.success("Checked for more items.");
            }

        } catch (e) {
            console.error("[ProfilePage] Failed to load or process next chunk:", e);
            toast.error(e instanceof Error ? e.message : "Failed to load more content.");
            // --- REMOVED: Do not set nextChunkCid to null here on error ---
            // setNextChunkCid(null);
            // If the chunk fetch itself failed, we keep the existing nextChunkCid
            // to allow potential retries when the user scrolls again.
            if (!fetchedNextChunkSuccessfully) {
                 console.warn("[ProfilePage] Keeping existing nextChunkCid due to chunk fetch failure.");
            }
        } finally {
            setIsLoadingMore(false);
             console.log("[ProfilePage] Finished loading more attempt, isLoadingMore set to false."); // <-- Added log
        }
    }, [nextChunkCid, isLoadingMore, profileKey, allPostsMap, ensurePostsAreFetched]); // Dependencies remain correct


    // --- displayData useMemo remains the same ---
    const displayData = useMemo((): DisplayData => {
        const profileMapToUse: Map<string, UserProfile> = userProfilesMap;

        if (!profileUserState) {
            return { topLevelIds: [], postsWithReplies: new Map(), userProfilesMap: profileMapToUse };
        }

        const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(allPostsMap);

        let targetCids: Set<string>;
        let filteredTopLevelIds: string[];
        const dislikedSet = new Set(currentUserState?.dislikedPostCIDs || []); // Viewer's dislikes

        switch (selectedFeed) {
            case 'posts':
                targetCids = new Set<string>();
                // Build set of all posts authored by the profile user from the global map
                allPostsMap.forEach((post, cid) => {
                    if (post.authorKey === profileKey) {
                        targetCids.add(cid);
                    }
                });
                // Filter top-level IDs: must be authored by profile user AND present in the profileUserState's known postCIDs
                filteredTopLevelIds = allTopLevelIds.filter(id =>
                    (profileUserState.postCIDs || []).includes(id) && targetCids.has(id)
                );
                break;
            case 'likes':
                targetCids = new Set(profileUserState.likedPostCIDs || []);
                filteredTopLevelIds = allTopLevelIds
                    .filter(id => targetCids.has(id))
                    .filter(id => !dislikedSet.has(id));
                break;
            case 'dislikes':
                targetCids = new Set(profileUserState.dislikedPostCIDs || []);
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

        if (profileKey && !profileMapToUse.has(profileKey) && profileUserState.profile) {
            const newProfileMap = new Map(profileMapToUse);
            newProfileMap.set(profileKey, profileUserState.profile);
            return { topLevelIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: newProfileMap };
        }

        return { topLevelIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: profileMapToUse };
     }, [profileUserState, selectedFeed, profileKey, allPostsMap, userProfilesMap, currentUserState?.dislikedPostCIDs]);

    // --- Observer useEffect remains the same (sets visibility, depends on profileKey) ---
    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                const firstEntry = entries[0];
                setIsLoaderVisible(firstEntry.isIntersecting);
                console.log(`[IntersectionObserver ProfilePage] Visibility Changed: ${firstEntry.isIntersecting}`);
            },
            {
                // --- Use threshold 0 ---
                threshold: 0,
                rootMargin: '200px 0px 0px 0px'
            }
        );

        const currentLoaderRef = loaderRef.current;
        if (currentLoaderRef) { observer.observe(currentLoaderRef); }

        return () => {
            if (currentLoaderRef) { observer.unobserve(currentLoaderRef); }
            setIsLoaderVisible(false); // Reset visibility on unmount/re-observe
        };
    }, [profileKey]); // Add profileKey dependency


    // --- START MODIFICATION: Trigger useEffect removes loadMoreProfileChunks dependency ---
    useEffect(() => {
        // Condition check moved entirely inside the effect
        const canLoadMoreNow = nextChunkCid !== null;
        console.log(`[LoadMore Trigger Check ProfilePage] isLoaderVisible: ${isLoaderVisible}, canLoadMoreNow: ${canLoadMoreNow}, isLoadingMore: ${isLoadingMore}`);

        if (isLoaderVisible && canLoadMoreNow && !isLoadingMore) {
            console.log("[LoadMore Trigger ProfilePage] Conditions met, calling loadMoreProfileChunks...");
            loadMoreProfileChunks();
        }
    // Only re-run when visibility, loading state, or the ability to load changes.
    }, [isLoaderVisible, nextChunkCid, isLoadingMore]); // <--- Removed loadMoreProfileChunks
    // --- END MODIFICATION ---


    // --- Loading/Error checks remain the same ---
    if (!profileKey) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: No profile key provided.</p></div>;
    if (isProfileLoading && !profileUserState) return <LoadingSpinner />;
    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;
    if (!profileUserState) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Profile not found.</p></div>;

    const canLoadMore = nextChunkCid !== null;

    return (
        <div className="app-container">
            <div className="main-content">
                {/* --- Header, NewPostForm, FeedSelector remain the same --- */}
                <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
                <ProfileHeader profileKey={profileKey} profile={profileUserState.profile} isMyProfile={isMyProfile} />
                {isMyProfile && ( <NewPostForm
                    replyingToPost={null} replyingToAuthorName={null}
                    onAddPost={handleAddPost} isProcessing={isProcessing}
                    isCoolingDown={isCoolingDown} countdown={countdown}
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
                    {/* --- Feed component remains the same --- */}
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
                    {/* --- Loader ref and indicator remain the same --- */}
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