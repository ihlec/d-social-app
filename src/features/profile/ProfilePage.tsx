// fileName: src/features/profile/ProfilePage.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import ProfileHeader from './ProfileHeader'; // Corrected path
import Feed from '../feed/Feed'; // Corrected path
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAppState } from '../../state/useAppStorage';
import { resolveIpns, fetchUserState } from '../../api/ipfsIpns';
import { UserState, Post, UserProfile, NewPostData } from '../../types';
import NewPostForm from '../feed/NewPostForm'; // Corrected path

// Define the specific feed types for the profile page
type ProfileFeedType = 'posts' | 'likes' | 'dislikes';

// Define options for the selector
const profileFeedOptions: { label: string; value: ProfileFeedType }[] = [
    { label: 'Posts', value: 'posts' },
    { label: 'Likes', value: 'likes' },
    { label: 'Dislikes', value: 'dislikes' },
];

// --- Helper functions ---
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
    topLevelPostIds: string[];
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
        // --- FIX: Use single, consolidated maps ---
        allPostsMap,
        userProfilesMap,
        // --- END FIX ---
        likePost, dislikePost,
        addPost, isProcessing, isCoolingDown, countdown,
        ensurePostsAreFetched,
    } = useAppState();

    const [profileUserState, setProfileUserState] = useState<UserState | null>(null);

    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');

    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);
    
    // --- FIX: No longer need to combine maps ---
    // const combinedPosts: Map<string, Post> = useMemo(() => new Map([...globalPostsMap, ...exploreAllPostsMap]), [globalPostsMap, exploreAllPostsMap]);
    // --- END FIX ---

    // HandleAddPost (no reply logic needed)
    const handleAddPost = (postData: NewPostData) => {
        addPost(postData);
    };

    useEffect(() => {
        const modalPostId = searchParams.get('modal_post');
        if (modalPostId) {
            const backgroundLoc = { ...location, search: '', };
            navigate(`/post/${modalPostId}`, { state: { backgroundLocation: backgroundLoc }, replace: true });
        }
    }, [searchParams, navigate, location]);

    useEffect(() => {
        if (!profileKey) {
            setError("No profile key provided."); setIsProfileLoading(false); navigate("/"); return;
        }
        const loadProfile = async () => {
             setIsProfileLoading(true); setError(null);
             try {
                 let userStateToSet: UserState | null = null;
                 if (isMyProfile && currentUserState) {
                     userStateToSet = currentUserState;
                 } else {
                     const profileStateCid = await resolveIpns(profileKey);
                     userStateToSet = await fetchUserState(profileStateCid, profileKey);
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


    const displayData = useMemo((): DisplayData => {
        // --- FIX: Use single userProfilesMap ---
        const profileMapToUse: Map<string, UserProfile> = userProfilesMap;
        // --- END FIX ---

        if (!profileUserState) {
            return { topLevelPostIds: [], postsWithReplies: new Map(), userProfilesMap: profileMapToUse };
        }

        // --- FIX: Build tree from single allPostsMap ---
        const { topLevelIds: allTopLevelIds, postsWithReplies } = buildPostTree(allPostsMap);
        // --- END FIX ---

        // 2. Determine the set of target CIDs based on the selected feed
        let targetCids: Set<string>;
        switch (selectedFeed) {
            case 'posts':
                const postCids = new Set<string>();
                // --- FIX: Filter from single allPostsMap ---
                allPostsMap.forEach((post, cid) => {
                    if (post.authorKey === profileKey) {
                        postCids.add(cid);
                    }
                });
                // --- END FIX ---
                targetCids = postCids;
                break;
            case 'likes':
                targetCids = new Set(profileUserState.likedPostCIDs || []);
                break;
            case 'dislikes':
                targetCids = new Set(profileUserState.dislikedPostCIDs || []);
                break;
            default:
                targetCids = new Set();
        }

        // 3. Filter the topLevelIds
        const dislikedSet = new Set(currentUserState?.dislikedPostCIDs || []);
        let filteredTopLevelIds: string[];

        if (selectedFeed === 'dislikes') {
            filteredTopLevelIds = allTopLevelIds.filter(id => targetCids.has(id));
        } else {
            filteredTopLevelIds = allTopLevelIds
                .filter(id => targetCids.has(id)) // Must be in the target list
                .filter(id => !dislikedSet.has(id)); // Must not be disliked by *me*
        }

        // 4. Sort the filtered list
        const sortedTopLevelIds = filteredTopLevelIds.sort((a, b) => {
            const latestA = getLatestActivityTimestamp(a, postsWithReplies);
            const latestB = getLatestActivityTimestamp(b, postsWithReplies);
            return latestB - latestA;
        });

        // 5. Ensure the profile user's own profile is in the map
        if (profileKey && !profileMapToUse.has(profileKey) && profileUserState.profile) {
            const newProfileMap = new Map(profileMapToUse);
            newProfileMap.set(profileKey, profileUserState.profile);
            return { topLevelPostIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: newProfileMap };
        }

        return { topLevelPostIds: sortedTopLevelIds, postsWithReplies, userProfilesMap: profileMapToUse };
    // --- FIX: Updated dependencies ---
    }, [profileUserState, selectedFeed, profileKey, allPostsMap, userProfilesMap, currentUserState?.dislikedPostCIDs]);
    // --- END FIX ---


    if (!profileKey) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: No profile key provided.</p></div>;
    if (isProfileLoading && !profileUserState) return <LoadingSpinner />;
    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;
    if (!profileUserState) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Profile not found.</p></div>;

    return (
        <div className="app-container">
            <div className="main-content">
                <Link to="/" className="back-to-feed-button">← Back to Feed</Link>
                
                <ProfileHeader profileKey={profileKey} profile={profileUserState.profile} isMyProfile={isMyProfile} />
                
                {isMyProfile && (
                     <NewPostForm
                        replyingToPost={null} replyingToAuthorName={null}
                        onAddPost={handleAddPost} isProcessing={isProcessing}
                        isCoolingDown={isCoolingDown} countdown={countdown}
                     />
                )}

                <>
                    <div className="feed-selector">
                        {profileFeedOptions.map(option => (
                            <button key={option.value} className={selectedFeed === option.value ? 'active' : ''}
                                onClick={() => setSelectedFeed(option.value)} >
                                {option.label}
                            </button>
                        ))}
                    </div>
                    <Feed 
                        isLoading={isProfileLoading}
                        topLevelPostIds={displayData.topLevelPostIds || []}
                        allPostsMap={displayData.postsWithReplies}
                        userProfilesMap={displayData.userProfilesMap}
                        onViewProfile={(key) => navigate(`/profile/${key}`)} currentUserState={currentUserState}
                        myIpnsKey={myIpnsKey} onLikePost={currentUserState ? likePost : undefined}
                        onDislikePost={currentUserState ? dislikePost : undefined}
                        ensurePostsAreFetched={ensurePostsAreFetched}
                    />
                </>
            </div>
        </div>
    );
};

export default ProfilePage;