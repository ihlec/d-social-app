// src/pages/ProfilePage.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import ProfileHeader from '../../features/profile/ProfileHeader';
import Feed from '../../features/feed/Feed';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAppState } from '../../state/useAppStorage';
import { resolveIpns, fetchUserState, fetchPost } from '../../api/ipfsIpns';
// --- FIX: UserProfile needed for newlyFetchedProfiles ---
import { UserState, Post, UserProfile, NewPostData } from '../../types';
// --- End Fix ---
import NewPostForm from '../../features/feed/NewPostForm';

// Define the specific feed types for the profile page
type ProfileFeedType = 'posts' | 'likes' | 'dislikes';

// Define options for the selector
const profileFeedOptions: { label: string; value: ProfileFeedType }[] = [
    { label: 'Posts', value: 'posts' },
    { label: 'Likes', value: 'likes' },
    { label: 'Dislikes', value: 'dislikes' },
];

// Helper to get latest activity timestamp for sorting (simplified for profile view)
const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post) return 0;
    return post.timestamp;
};

// Helper to build post tree (simplified for profile view)
const buildPostTree = (postMap: Map<string, Post>): { topLevelIds: string[], postsWithReplies: Map<string, Post> } => {
    const postsWithReplies = new Map<string, Post>();
    postMap.forEach((post, id) => {
        postsWithReplies.set(id, { ...post, replies: [] }); // Initialize replies
    });
    // Connect replies if they exist within the fetched set
    postsWithReplies.forEach(post => {
        if (post.referenceCID && postsWithReplies.has(post.referenceCID)) {
            postsWithReplies.get(post.referenceCID)?.replies?.push(post.id);
        }
    });
    // All fetched posts are considered top-level for the profile feed presentation
    const topLevelIds = Array.from(postMap.keys());
    return { topLevelIds, postsWithReplies };
};


const ProfilePage: React.FC = () => {
    const { key: profileKey } = useParams<{ key: string }>(); // IPNS key or Label from URL
    const navigate = useNavigate();
    const {
        myIpnsKey, userState: currentUserState,
        allPostsMap: globalPostsMap, exploreAllPostsMap,
        // --- FIX: Remove unused profile maps ---
        // userProfilesMap: globalProfilesMap, exploreUserProfilesMap,
        // --- End Fix ---
        likePost, dislikePost,
        addPost, isProcessing, isCoolingDown, countdown,
        combinedUserProfilesMap
    } = useAppState();

    const [profileUserState, setProfileUserState] = useState<UserState | null>(null);
    const [profilePosts, setProfilePosts] = useState<Map<string, Post>>(new Map());

    // Separate loading states for profile header data and post content
    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [isPostsLoading, setIsPostsLoading] = useState(false);

    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');

    const [replyingToPost, setReplyingToPost] = useState<Post | null>(null);
    const [replyingToAuthorName, setReplyingToAuthorName] = useState<string | null>(null);

    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);

    // Combine global maps for initial/fallback data lookup
    const combinedPosts = useMemo(() => new Map([...globalPostsMap, ...exploreAllPostsMap]), [globalPostsMap, exploreAllPostsMap]);

    const handleSetReplying = (post: Post | null) => {
        if (!currentUserState) {
          toast("Please log in to reply.", { icon: '🔒' });
          navigate('/login');
          return;
        }
        setReplyingToPost(post);
        if (post) {
            // Find the author's name from the combined map provided by the context
            const authorProfile = combinedUserProfilesMap.get(post.authorKey);
            setReplyingToAuthorName(authorProfile?.name || null);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
             setReplyingToAuthorName(null);
        }
    };

    const handleAddPost = (postData: NewPostData) => {
        addPost(postData);
        setReplyingToPost(null); // Clear reply state after submitting
        setReplyingToAuthorName(null); // Also clear name
    };


    useEffect(() => {
        if (!profileKey) {
            setError("No profile key provided.");
            setIsProfileLoading(false);
            navigate("/"); // Redirect if no key
            return;
        }

        const loadProfile = async () => {
            setIsProfileLoading(true);
            setError(null);
            setProfilePosts(new Map()); // Clear posts on profile change
            setReplyingToPost(null); // Clear reply state when profile changes
            setReplyingToAuthorName(null); // Also clear name

            try {
                let userStateToSet: UserState | null = null;
                if (isMyProfile && currentUserState) {
                    userStateToSet = currentUserState; // Use live state if it's my profile
                } else {
                    const profileStateCid = await resolveIpns(profileKey);
                    // Fetch state but provide no name hint, as it might be someone else's profile
                    userStateToSet = await fetchUserState(profileStateCid);
                }

                if (!userStateToSet) throw new Error("Could not load user state.");
                setProfileUserState(userStateToSet);

            } catch (err) {
                console.error("Error loading profile page:", err);
                setError(err instanceof Error ? err.message : "Failed to load profile.");
                toast.error("Could not load this profile.");
            } finally {
                setIsProfileLoading(false);
            }
        };

        loadProfile();
    }, [profileKey, myIpnsKey, currentUserState, isMyProfile, navigate]); // Rerun if key changes or my state updates


    // Effect to fetch posts based on selected feed and profileUserState
    useEffect(() => {
        if (!profileUserState) return; // Wait for profile to be loaded

        const fetchPostsForFeed = async () => {
            // Don't refetch posts if we are just replying
            if (replyingToPost) return;

            setIsPostsLoading(true);
            let cidsToFetch: string[] = [];

            switch (selectedFeed) {
                case 'posts':
                    cidsToFetch = profileUserState.postCIDs || [];
                    break;
                case 'likes':
                    cidsToFetch = profileUserState.likedPostCIDs || [];
                    break;
                case 'dislikes':
                    cidsToFetch = profileUserState.dislikedPostCIDs || [];
                    break;
            }

            cidsToFetch = cidsToFetch.filter(cid => cid && !cid.startsWith('temp-'));

            if (cidsToFetch.length === 0) {
                setProfilePosts(new Map());
                setIsPostsLoading(false);
                return;
            }

            const posts = new Map<string, Post>();
            const profilesToEnsure = new Map(combinedUserProfilesMap);
            const newlyFetchedProfiles = new Map<string, UserProfile>();


            await Promise.allSettled(cidsToFetch.map(async (cid) => {
                try {
                    // Check combined global map first before fetching from network
                    let postData = combinedPosts.get(cid);
                    if (!postData) {
                        postData = await fetchPost(cid); // Fetch if not found globally
                    }

                    if (postData && typeof postData === 'object' && postData.authorKey) {
                        const post: Post = { ...(postData as Post), id: cid, replies: [] };
                        posts.set(cid, post);
                        if (!profilesToEnsure.has(post.authorKey) && !newlyFetchedProfiles.has(post.authorKey)) {
                            // Fetch missing author profile
                            try {
                                const profileCid = await resolveIpns(post.authorKey);
                                // Fetch state but provide no name hint
                                const authorState = await fetchUserState(profileCid);
                                if (authorState?.profile) {
                                    newlyFetchedProfiles.set(post.authorKey, authorState.profile);
                                    profilesToEnsure.set(post.authorKey, authorState.profile); // Add to ensure map
                                } else {
                                    newlyFetchedProfiles.set(post.authorKey, { name: 'Unknown User' }); // Placeholder
                                    profilesToEnsure.set(post.authorKey, { name: 'Unknown User' }); // Add placeholder
                                }
                            } catch (profileError) {
                                console.warn(`Failed to fetch profile for author ${post.authorKey} in profile feed`, profileError);
                                newlyFetchedProfiles.set(post.authorKey, { name: 'Unknown User' }); // Placeholder
                                profilesToEnsure.set(post.authorKey, { name: 'Unknown User' }); // Add placeholder
                            }

                        }
                    } else {
                        console.warn(`Invalid or missing post data for CID ${cid}`);
                    }
                } catch (error) {
                    console.error(`Failed to fetch post ${cid} for profile feed:`, error);
                }
            }));


            setProfilePosts(posts);
            setIsPostsLoading(false);
        };

        fetchPostsForFeed();

        // Effect runs when the profile data or the selected feed tab changes
    }, [profileUserState, selectedFeed, combinedPosts, combinedUserProfilesMap, replyingToPost]);


    // Memoize display data to optimize sorting and filtering
    const displayData = useMemo(() => {
        const profileMapToUse = combinedUserProfilesMap;

        // When replying, show only the relevant thread
        if (replyingToPost) {
            let rootPostId = replyingToPost.id;
            let currentPost: Post | undefined = replyingToPost;
            const mapForWalk = new Map([...combinedPosts, ...profilePosts]);

            while (currentPost?.referenceCID && mapForWalk.has(currentPost.referenceCID)) {
                rootPostId = currentPost.referenceCID;
                currentPost = mapForWalk.get(rootPostId);
                if (!currentPost) break;
            }
             const { postsWithReplies: threadMap } = buildPostTree(mapForWalk);

            return {
                topLevelPostIds: [rootPostId],
                postsWithReplies: threadMap,
                userProfilesMap: profileMapToUse // Use context map
            };
        }

        if (!profileUserState) return { topLevelPostIds: [], postsWithReplies: new Map(), userProfilesMap: profileMapToUse };

        const { topLevelIds, postsWithReplies } = buildPostTree(profilePosts);

        const sortedTopLevelIds = topLevelIds.sort((a, b) => {
            const latestA = getLatestActivityTimestamp(a, postsWithReplies);
            const latestB = getLatestActivityTimestamp(b, postsWithReplies);
            return latestB - latestA;
        });

        // Ensure the profile being viewed is in the profile map
        const finalProfiles: Map<string, UserProfile> = new Map(profileMapToUse);
        if (profileKey && !finalProfiles.has(profileKey) && profileUserState.profile) {
            finalProfiles.set(profileKey, profileUserState.profile);
        }

        return { topLevelPostIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: finalProfiles };

    }, [profileUserState, profilePosts, combinedUserProfilesMap, profileKey, replyingToPost, combinedPosts]);


    if (!profileKey) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: No profile key provided.</p></div>;

    if (isProfileLoading && !profileUserState) return <LoadingSpinner />;

    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;
    if (!profileUserState) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Profile not found.</p></div>;


    return (
        <div className="app-container">
            <div className="main-content">
                {replyingToPost ? (
                    <button className="back-to-feed-button" onClick={() => handleSetReplying(null)}> ← Back to Profile </button>
                ) : (
                    <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
                )}

                <ProfileHeader
                    profileKey={profileKey}
                    profile={profileUserState.profile}
                    isMyProfile={isMyProfile}
                />

                {replyingToPost && currentUserState && (
                     <NewPostForm
                        replyingToPost={replyingToPost}
                        replyingToAuthorName={replyingToAuthorName}
                        onAddPost={handleAddPost}
                        isProcessing={isProcessing}
                        isCoolingDown={isCoolingDown}
                        countdown={countdown}
                     />
                )}

                {!replyingToPost && (
                    <>
                        <div className="feed-selector">
                            {profileFeedOptions.map(option => (
                                <button
                                    key={option.value}
                                    className={selectedFeed === option.value ? 'active' : ''}
                                    onClick={() => setSelectedFeed(option.value)}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>

                        <Feed
                            isLoading={isPostsLoading}
                            topLevelPostIds={displayData.topLevelPostIds}
                            allPostsMap={displayData.postsWithReplies}
                            userProfilesMap={displayData.userProfilesMap}
                            onViewProfile={(key) => navigate(`/profile/${key}`)}
                            currentUserState={currentUserState}
                            myIpnsKey={myIpnsKey}
                            onLikePost={currentUserState ? likePost : undefined}
                            onDislikePost={currentUserState ? dislikePost : undefined}
                            onSetReplyingTo={handleSetReplying}
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export default ProfilePage;