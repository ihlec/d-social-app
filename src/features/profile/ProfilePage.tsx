// src/pages/ProfilePage.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import ProfileHeader from '../../features/profile/ProfileHeader';
import Feed from '../../features/feed/Feed';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAppState } from '../../state/useAppStorage';
import { resolveIpns, fetchUserState, fetchPost } from '../../api/ipfsIpns';
import { UserState, Post, UserProfile, NewPostData } from '../../types';
import NewPostForm from '../../features/feed/NewPostForm';

// Define the specific feed types for the profile page
type ProfileFeedType = 'posts' | 'likes' | 'dislikes';

// Define options for the selector
const profileFeedOptions: { label: string; value: ProfileFeedType }[] = [
    { label: 'Posts', value: 'posts' },
    { label: 'Likes', value: 'likes' },
    { label: 'Dislikes', value: 'dislikes' },
];

// --- FIX: Moved helper functions outside the component ---
// Helper to get latest activity timestamp for sorting (simplified for profile view)
const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post) return 0;
    return post.timestamp; // Directly return timestamp for profile view sorting
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
            // Ensure replies array exists (though initialized above, belt-and-suspenders)
            const parent = postsWithReplies.get(post.referenceCID);
            if (parent) {
                if (!parent.replies) parent.replies = [];
                parent.replies.push(post.id);
            }
        }
    });
    // All fetched posts are considered top-level for the profile feed presentation
    const topLevelIds = Array.from(postMap.keys());
    return { topLevelIds, postsWithReplies };
};
// --- End Fix ---


const ProfilePage: React.FC = () => {
    const { key: profileKey } = useParams<{ key: string }>();
    const navigate = useNavigate();
    const {
        myIpnsKey, userState: currentUserState,
        allPostsMap: globalPostsMap, exploreAllPostsMap,
        likePost, dislikePost,
        addPost, isProcessing, isCoolingDown, countdown,
        combinedUserProfilesMap
    } = useAppState();

    const [profileUserState, setProfileUserState] = useState<UserState | null>(null);
    const [profilePosts, setProfilePosts] = useState<Map<string, Post>>(new Map());
    const [localProfilesMap, setLocalProfilesMap] = useState<Map<string, UserProfile>>(new Map());

    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [isPostsLoading, setIsPostsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');
    const [replyingToPost, setReplyingToPost] = useState<Post | null>(null);
    const [replyingToAuthorName, setReplyingToAuthorName] = useState<string | null>(null);

    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);
    const combinedPosts = useMemo(() => new Map([...globalPostsMap, ...exploreAllPostsMap]), [globalPostsMap, exploreAllPostsMap]);

    const handleSetReplying = (post: Post | null) => {
        if (!currentUserState) {
          toast("Please log in to reply.", { icon: '🔒' });
          navigate('/login');
          return;
        }
        setReplyingToPost(post);
        if (post) {
            const authorProfile = combinedUserProfilesMap.get(post.authorKey);
            setReplyingToAuthorName(authorProfile?.name || null);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
             setReplyingToAuthorName(null);
        }
    };

    const handleAddPost = (postData: NewPostData) => {
        addPost(postData);
        setReplyingToPost(null);
        setReplyingToAuthorName(null);
    };


    useEffect(() => {
        if (!profileKey) {
            setError("No profile key provided."); setIsProfileLoading(false); navigate("/"); return;
        }
        const loadProfile = async () => {
             setIsProfileLoading(true); setError(null); setProfilePosts(new Map());
             setReplyingToPost(null); setReplyingToAuthorName(null);
             setLocalProfilesMap(new Map());
             try {
                 let userStateToSet: UserState | null = null;
                 if (isMyProfile && currentUserState) {
                     userStateToSet = currentUserState;
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
             } finally { setIsProfileLoading(false); }
        };
        loadProfile();
    }, [profileKey, myIpnsKey, currentUserState, isMyProfile, navigate]);


    useEffect(() => {
        if (!profileUserState) return;
        const fetchPostsForFeed = async () => {
            if (replyingToPost) return;
            setIsPostsLoading(true); setLocalProfilesMap(new Map());
            let cidsToFetch: string[] = [];
            switch (selectedFeed) {
                case 'posts': cidsToFetch = profileUserState.postCIDs || []; break;
                case 'likes': cidsToFetch = profileUserState.likedPostCIDs || []; break;
                case 'dislikes': cidsToFetch = profileUserState.dislikedPostCIDs || []; break;
            }
            cidsToFetch = cidsToFetch.filter(cid => cid && !cid.startsWith('temp-'));
            if (cidsToFetch.length === 0) {
                setProfilePosts(new Map()); setIsPostsLoading(false); return;
            }
            const posts = new Map<string, Post>();
            const newlyFetchedProfilesThisRun = new Map<string, UserProfile>();
            await Promise.allSettled(cidsToFetch.map(async (cid) => {
                try {
                    let postData = combinedPosts.get(cid) ?? await fetchPost(cid);
                    if (postData && typeof postData === 'object' && postData.authorKey) {
                        const post: Post = { ...(postData as Post), id: cid, replies: [] };
                        posts.set(cid, post);
                        if (!combinedUserProfilesMap.has(post.authorKey) && !newlyFetchedProfilesThisRun.has(post.authorKey)) {
                            try {
                                const profileCid = await resolveIpns(post.authorKey);
                                const authorState = await fetchUserState(profileCid);
                                const fetchedProfile = authorState?.profile || { name: 'Unknown User' };
                                newlyFetchedProfilesThisRun.set(post.authorKey, fetchedProfile);
                            } catch (profileError) {
                                console.warn(`Failed fetch profile for ${post.authorKey} in profile feed`, profileError);
                                if (!newlyFetchedProfilesThisRun.has(post.authorKey)) {
                                    newlyFetchedProfilesThisRun.set(post.authorKey, { name: 'Unknown User' });
                                }
                            }
                        }
                    } else { console.warn(`Invalid post data for CID ${cid}`); }
                } catch (error) { console.error(`Failed fetch post ${cid} for profile feed:`, error); }
            }));
            if (newlyFetchedProfilesThisRun.size > 0) {
                 console.log(`[ProfilePage] Fetched ${newlyFetchedProfilesThisRun.size} new profiles locally.`);
                 setLocalProfilesMap(newlyFetchedProfilesThisRun);
            }
            setProfilePosts(posts);
            setIsPostsLoading(false);
        };
        fetchPostsForFeed();
    }, [profileUserState, selectedFeed, combinedPosts, combinedUserProfilesMap, replyingToPost]);


    const displayData = useMemo(() => {
        const profileMapToUse = new Map([...combinedUserProfilesMap, ...localProfilesMap]);
        if (replyingToPost) {
             let rootPostId = replyingToPost.id;
             let currentPost: Post | undefined = replyingToPost;
             const mapForWalk = new Map([...combinedPosts, ...profilePosts]);
             while (currentPost?.referenceCID && mapForWalk.has(currentPost.referenceCID)) {
                 rootPostId = currentPost.referenceCID;
                 currentPost = mapForWalk.get(rootPostId); if (!currentPost) break;
             }
             const { postsWithReplies: threadMap } = buildPostTree(mapForWalk);
             return { topLevelPostIds: [rootPostId], postsWithReplies: threadMap, userProfilesMap: profileMapToUse };
        }
        if (!profileUserState) return { topLevelPostIds: [], postsWithReplies: new Map(), userProfilesMap: profileMapToUse };

        let finalPostsMap = profilePosts;
        if (selectedFeed !== 'dislikes' && currentUserState?.dislikedPostCIDs) {
            const dislikedSet = new Set(currentUserState.dislikedPostCIDs);
            finalPostsMap = new Map<string, Post>();
            profilePosts.forEach((post, id) => { if (!dislikedSet.has(id)) { finalPostsMap.set(id, post); } });
        }

        const { topLevelIds, postsWithReplies } = buildPostTree(finalPostsMap);

        // --- FIX: Add explicit return to sort function ---
        const sortedTopLevelIds = topLevelIds.sort((a, b) => {
            const latestA = getLatestActivityTimestamp(a, postsWithReplies);
            const latestB = getLatestActivityTimestamp(b, postsWithReplies);
            return latestB - latestA; // Ensure this difference is returned
        });
        // --- End Fix ---

        const finalProfiles: Map<string, UserProfile> = new Map(profileMapToUse);
        if (profileKey && !finalProfiles.has(profileKey) && profileUserState.profile) {
            finalProfiles.set(profileKey, profileUserState.profile);
        }
        return { topLevelPostIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: finalProfiles };
    }, [profileUserState, profilePosts, combinedUserProfilesMap, localProfilesMap, profileKey, replyingToPost, combinedPosts, selectedFeed, currentUserState?.dislikedPostCIDs]);


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
                <ProfileHeader profileKey={profileKey} profile={profileUserState.profile} isMyProfile={isMyProfile} />
                {replyingToPost && currentUserState && (
                     <NewPostForm
                        replyingToPost={replyingToPost} replyingToAuthorName={replyingToAuthorName}
                        onAddPost={handleAddPost} isProcessing={isProcessing}
                        isCoolingDown={isCoolingDown} countdown={countdown}
                     />
                )}
                {!replyingToPost && (
                    <>
                        <div className="feed-selector">
                            {profileFeedOptions.map(option => (
                                <button key={option.value} className={selectedFeed === option.value ? 'active' : ''}
                                    onClick={() => setSelectedFeed(option.value)} >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        <Feed isLoading={isPostsLoading} topLevelPostIds={displayData.topLevelPostIds}
                            allPostsMap={displayData.postsWithReplies} userProfilesMap={displayData.userProfilesMap}
                            onViewProfile={(key) => navigate(`/profile/${key}`)} currentUserState={currentUserState}
                            myIpnsKey={myIpnsKey} onLikePost={currentUserState ? likePost : undefined}
                            onDislikePost={currentUserState ? dislikePost : undefined} onSetReplyingTo={handleSetReplying}
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export default ProfilePage;