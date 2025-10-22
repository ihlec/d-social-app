// src/pages/ProfilePage.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import ProfileHeader from '../../features/profile/ProfileHeader';
import Feed from '../../features/feed/Feed';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAppState } from '../../state/useAppStorage';
import { resolveIpns, fetchUserState, fetchPost } from '../../api/ipfsIpns';
import { UserState, Post, UserProfile } from '../../types';

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
        userProfilesMap: globalProfilesMap, exploreUserProfilesMap,
        likePost, dislikePost, // --- FIX: Removed followUser ---
    } = useAppState();

    const [profileUserState, setProfileUserState] = useState<UserState | null>(null);
    const [profilePosts, setProfilePosts] = useState<Map<string, Post>>(new Map());

    // Separate loading states for profile header data and post content
    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [isPostsLoading, setIsPostsLoading] = useState(false);

    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');

    // --- FIX: Use sessionStorage ---
    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    // --- End Fix ---
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);

    // Combine global maps for initial/fallback data lookup
    const combinedPosts = useMemo(() => new Map([...globalPostsMap, ...exploreAllPostsMap]), [globalPostsMap, exploreAllPostsMap]);
    const combinedProfiles: Map<string, UserProfile> = useMemo(() => new Map([...globalProfilesMap, ...exploreUserProfilesMap]), [globalProfilesMap, exploreUserProfilesMap]);


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

            try {
                let userStateToSet: UserState | null = null;
                if (isMyProfile && currentUserState) {
                    userStateToSet = currentUserState; // Use live state if it's my profile
                } else {
                    const profileStateCid = await resolveIpns(profileKey);
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
                    // --- FIX: Removed stray 'T' ---
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
                        // Check if author profile is known
                        if (!combinedProfiles.has(post.authorKey) && !newlyFetchedProfiles.has(post.authorKey)) {
                            // Fetch missing author profile
                            try {
                                const profileCid = await resolveIpns(post.authorKey);
                                const authorState = await fetchUserState(profileCid);
                                if (authorState?.profile) {
                                    newlyFetchedProfiles.set(post.authorKey, authorState.profile);
                                } else {
                                    newlyFetchedProfiles.set(post.authorKey, { name: 'Unknown User' }); // Placeholder
                                }
                            } catch (profileError) {
                                console.warn(`Failed to fetch profile for author ${post.authorKey} in profile feed`, profileError);
                                newlyFetchedProfiles.set(post.authorKey, { name: 'Unknown User' }); // Placeholder
                            }

                        }
                    } else {
                        console.warn(`Invalid or missing post data for CID ${cid}`);
                    }
                } catch (error) {
                    console.error(`Failed to fetch post ${cid} for profile feed:`, error);
                }
            }));

            // Add newly fetched profiles to the combined map for the final render
            newlyFetchedProfiles.forEach((profile, key) => combinedProfiles.set(key, profile));

            setProfilePosts(posts);
            setIsPostsLoading(false);
        };

        fetchPostsForFeed();

        // Effect runs when the profile data or the selected feed tab changes
    }, [profileUserState, selectedFeed, combinedPosts, combinedProfiles]);

    // Memoize display data to optimize sorting and filtering
    const displayData = useMemo(() => {
        if (!profileUserState) return { topLevelPostIds: [], postsWithReplies: new Map(), userProfilesMap: combinedProfiles };

        const { topLevelIds, postsWithReplies } = buildPostTree(profilePosts);

        // Sort posts by timestamp (descending)
        const sortedTopLevelIds = topLevelIds.sort((a, b) => {
            const latestA = getLatestActivityTimestamp(a, postsWithReplies);
            const latestB = getLatestActivityTimestamp(b, postsWithReplies);
            return latestB - latestA;
        });

        // Ensure the profile being viewed is in the profile map passed to the Feed
        const finalProfiles: Map<string, UserProfile> = new Map(combinedProfiles);
        if (profileKey && !finalProfiles.has(profileKey) && profileUserState.profile) {
            finalProfiles.set(profileKey, profileUserState.profile);
        }


        return { topLevelPostIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: finalProfiles };

    }, [profileUserState, profilePosts, combinedProfiles, profileKey]);


    if (!profileKey) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: No profile key provided.</p></div>;

    if (isProfileLoading && !profileUserState) return <LoadingSpinner />;

    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;
    if (!profileUserState) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Profile not found.</p></div>;


    return (
        <div className="app-container">
            <div className="main-content">
                <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
                <ProfileHeader
                    profileKey={profileKey}
                    profile={profileUserState.profile}
                    isMyProfile={isMyProfile}
                />

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
                    // --- FIX: Removed onFollowPostAuthor ---
                    // onFollowPostAuthor={currentUserState ? followUser : undefined}
                    // --- End Fix ---
                />
            </div>
        </div>
    );
};

export default ProfilePage;