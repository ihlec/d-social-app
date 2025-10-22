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

// --- Type for the row structure ---
type FeedRowItem = string | string[];


// --- Helper functions ---
const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post) return 0;
    return post.timestamp;
};

const buildPostTree = (postMap: Map<string, Post>): { topLevelIds: string[], postsWithReplies: Map<string, Post> } => {
    const postsWithReplies = new Map<string, Post>();
    postMap.forEach((post, id) => {
        postsWithReplies.set(id, { ...post, replies: [] }); // Initialize replies
    });
    // Connect replies if they exist within the fetched set
    postsWithReplies.forEach(post => {
        if (post.referenceCID && postsWithReplies.has(post.referenceCID)) {
            const parent = postsWithReplies.get(post.referenceCID);
            if (parent) {
                if (!parent.replies) parent.replies = [];
                parent.replies.push(post.id);
            }
        }
    });
    // Filter out posts that ended up being replies within the fetched set
    const topLevelIds = Array.from(postsWithReplies.keys()).filter(id => {
        const post = postsWithReplies.get(id);
        return !post?.referenceCID || !postsWithReplies.has(post.referenceCID);
    });

    return { topLevelIds, postsWithReplies };
};


const ProfilePage: React.FC = () => {
    const { key: profileKey } = useParams<{ key: string }>();
    const navigate = useNavigate();
    const {
        myIpnsKey, userState: currentUserState,
        allPostsMap: globalPostsMap, exploreAllPostsMap,
        likePost, dislikePost,
        addPost, isProcessing, isCoolingDown, countdown,
        combinedUserProfilesMap,
        ensurePostsAreFetched,
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
            if (replyingToPost) return; // Don't fetch list if viewing a thread
            setIsPostsLoading(true);
            setLocalProfilesMap(new Map()); // Clear local profiles
            setProfilePosts(new Map()); // Clear posts

            let cidsToFetch: string[] = [];
            switch (selectedFeed) {
                case 'posts': cidsToFetch = profileUserState.postCIDs || []; break;
                case 'likes': cidsToFetch = profileUserState.likedPostCIDs || []; break;
                case 'dislikes': cidsToFetch = profileUserState.dislikedPostCIDs || []; break;
            }
            cidsToFetch = cidsToFetch.filter(cid => cid && !cid.startsWith('temp-'));

            if (cidsToFetch.length === 0) {
                setIsPostsLoading(false);
                return;
            }

            const newPosts = new Map<string, Post>();
            const missingParentCIDs = new Set<string>();

            // --- Pass 1: Fetch primary posts ---
            await Promise.allSettled(cidsToFetch.map(async (cid) => {
                try {
                    // Check combined map first, then fetch
                    let postData = combinedPosts.get(cid) ?? await fetchPost(cid);
                    if (postData && typeof postData === 'object' && postData.authorKey) {
                        const post: Post = { ...(postData as Post), id: cid, replies: [] };
                        newPosts.set(cid, post);
                        // Check for missing parent
                        if (post.referenceCID && !combinedPosts.has(post.referenceCID)) {
                            missingParentCIDs.add(post.referenceCID);
                        }
                    } else { console.warn(`Invalid post data for CID ${cid}`); }
                } catch (error) { console.error(`Failed fetch post ${cid} for profile feed:`, error); }
            }));

            // --- Pass 2: Fetch missing parent posts ---
            // Filter out any parents that might have been fetched in Pass 1
            const parentCIDsToFetch = Array.from(missingParentCIDs).filter(cid => !newPosts.has(cid));

            if (parentCIDsToFetch.length > 0) {
                 await Promise.allSettled(parentCIDsToFetch.map(async (cid) => {
                    try {
                        const postData = await fetchPost(cid); // Don't need to check combinedPosts, we already did
                        if (postData && typeof postData === 'object' && postData.authorKey) {
                            const post: Post = { ...(postData as Post), id: cid, replies: [] };
                            newPosts.set(cid, post);
                        } else { console.warn(`Invalid parent post data for CID ${cid}`); }
                    } catch (error) { console.error(`Failed fetch parent post ${cid} for profile feed:`, error); }
                 }));
            }

            // --- Pass 3: Fetch all missing profiles ---
            const authorKeysToFetch = new Set<string>();
            newPosts.forEach(post => {
                if (post.authorKey && !combinedUserProfilesMap.has(post.authorKey)) {
                    authorKeysToFetch.add(post.authorKey);
                }
            });

            const newlyFetchedProfiles = new Map<string, UserProfile>();
            if (authorKeysToFetch.size > 0) {
                 await Promise.allSettled(Array.from(authorKeysToFetch).map(async (authorKey) => {
                    try {
                        const profileCid = await resolveIpns(authorKey);
                        const authorState = await fetchUserState(profileCid);
                        const fetchedProfile = authorState?.profile || { name: 'Unknown User' };
                        newlyFetchedProfiles.set(authorKey, fetchedProfile);
                    } catch (profileError) {
                        console.warn(`Failed fetch profile for ${authorKey} in profile feed`, profileError);
                        newlyFetchedProfiles.set(authorKey, { name: 'Unknown User' });
                    }
                 }));
            }

            // --- Finalize State ---
            if (newlyFetchedProfiles.size > 0) {
                 console.log(`[ProfilePage] Fetched ${newlyFetchedProfiles.size} new profiles locally.`);
                 setLocalProfilesMap(newlyFetchedProfiles);
            }
            setProfilePosts(newPosts);
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
             return { feedRowItems: [rootPostId], postsWithReplies: threadMap, userProfilesMap: profileMapToUse };
        }
        if (!profileUserState) return { feedRowItems: [], postsWithReplies: new Map(), userProfilesMap: profileMapToUse };

        let finalPostsMap = profilePosts;
        if (selectedFeed !== 'dislikes' && currentUserState?.dislikedPostCIDs) {
            const dislikedSet = new Set(currentUserState.dislikedPostCIDs);
            finalPostsMap = new Map<string, Post>();
            profilePosts.forEach((post, id) => { if (!dislikedSet.has(id)) { finalPostsMap.set(id, post); } });
        }

        const { topLevelIds, postsWithReplies } = buildPostTree(finalPostsMap);

        const sortedTopLevelIds = topLevelIds.sort((a, b) => {
            const latestA = getLatestActivityTimestamp(a, postsWithReplies);
            const latestB = getLatestActivityTimestamp(b, postsWithReplies);
            return latestB - latestA;
        });

        // --- FIX: Implement 3-column row chunking logic ---
        const feedRowItems: FeedRowItem[] = [];
        const shortPostBuffer: string[] = []; // Can hold up to 2 items

        const flushBuffer = () => {
            if (shortPostBuffer.length > 0) {
                feedRowItems.push([...shortPostBuffer]); // Push a copy
                shortPostBuffer.length = 0; // Clear the buffer
            }
        };

        for (const postId of sortedTopLevelIds) {
            const post = postsWithReplies.get(postId);
            // A post is "long" (full-width) if it has replies.
            const isLongPost = (post?.replies?.length ?? 0) > 0;

            if (isLongPost) {
                // Flush any existing short posts before adding the long one.
                flushBuffer();
                // Add the long post as its own full-width row.
                feedRowItems.push(postId);
            } else {
                // This is a "short" post. Add it to the buffer.
                shortPostBuffer.push(postId);
                // If the buffer is full (3 items), flush it.
                if (shortPostBuffer.length === 3) {
                    flushBuffer();
                }
            }
        }
        // After the loop, flush any remaining posts in the buffer.
        flushBuffer();
        // --- End Fix ---

        const finalProfiles: Map<string, UserProfile> = new Map(profileMapToUse);
        if (profileKey && !finalProfiles.has(profileKey) && profileUserState.profile) {
            finalProfiles.set(profileKey, profileUserState.profile);
        }
        return { feedRowItems, postsWithReplies, userProfilesMap: finalProfiles };
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
                        <Feed isLoading={isPostsLoading}
                            feedRowItems={displayData.feedRowItems || []}
                            allPostsMap={displayData.postsWithReplies} userProfilesMap={displayData.userProfilesMap}
                            onViewProfile={(key) => navigate(`/profile/${key}`)} currentUserState={currentUserState}
                            myIpnsKey={myIpnsKey} onLikePost={currentUserState ? likePost : undefined}
                            onDislikePost={currentUserState ? dislikePost : undefined} onSetReplyingTo={handleSetReplying}
                            ensurePostsAreFetched={ensurePostsAreFetched}
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export default ProfilePage;