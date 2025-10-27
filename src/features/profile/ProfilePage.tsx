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

    const [isProfileLoading, setIsProfileLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedFeed, setSelectedFeed] = useState<ProfileFeedType>('posts');

    const currentUserLabel = sessionStorage.getItem("currentUserLabel");
    const isMyProfile = profileKey === myIpnsKey || (!!currentUserLabel && profileKey === currentUserLabel);
    
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
             let userStateToSet: UserState | null = null; // --- Store state to use after finally block ---
             try {
                 if (isMyProfile && currentUserState) {
                     userStateToSet = currentUserState;
                 } else {
                     const profileStateCid = await resolveIpns(profileKey);
                     userStateToSet = await fetchUserState(profileStateCid, profileKey);
                 }
                 if (!userStateToSet) throw new Error("Could not load user state.");
                 
                 setProfileUserState(userStateToSet); // --- Set state immediately ---

             } catch (err) {
                 console.error("Error loading profile page:", err);
                 setError(err instanceof Error ? err.message : "Failed to load profile.");
                 toast.error("Could not load this profile.");
             } finally {
                 setIsProfileLoading(false); // --- Set loading false immediately ---
             }

             // --- START MODIFICATION: Run post-fetching *after* loading is false (non-blocking) ---
             if (userStateToSet) {
                const postCids = userStateToSet.postCIDs || [];
                const likedCids = userStateToSet.likedPostCIDs || [];
                const dislikedCids = userStateToSet.dislikedPostCIDs || [];
                
                const allCids = [...new Set([...postCids, ...likedCids, ...dislikedCids])];
                
                const missingCids = allCids.filter(cid => cid && !cid.startsWith('temp-') && !allPostsMap.has(cid));
                
                if (missingCids.length > 0) {
                    console.log(`[ProfilePage] Found ${missingCids.length} posts to fetch (lazy)...`);
                    // --- DO NOT AWAIT ---
                    ensurePostsAreFetched(missingCids, profileKey)
                        .catch(e => console.error(`[ProfilePage] Lazy fetch failed: ${e}`));
                }
             }
             // --- END MODIFICATION ---
        };
        loadProfile();
    }, [profileKey, myIpnsKey, currentUserState, isMyProfile, navigate, ensurePostsAreFetched, allPostsMap]);


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
                allPostsMap.forEach((post, cid) => {
                    if (post.authorKey === profileKey) {
                        targetCids.add(cid);
                    }
                });
                filteredTopLevelIds = allTopLevelIds.filter(id => targetCids.has(id));
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


    if (!profileKey) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: No profile key provided.</p></div>;
    
    // --- START MODIFICATION: Show loading spinner OR profile header ---
    // This allows the header to render while the feed (which might be empty) is still loading
    if (isProfileLoading && !profileUserState) return <LoadingSpinner />;
    if (error) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Error: {error}</p></div>;
    if (!profileUserState) return <div className="public-view-container"><Link to="/" className="back-to-feed-button">← Back</Link><p>Profile not found.</p></div>;
    // --- END MODIFICATION ---

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
                        // --- START MODIFICATION: isLoading is now only for the *initial* load ---
                        isLoading={isProfileLoading} 
                        // --- END MODIFICATION ---
                        topLevelIds={displayData.topLevelIds || []}
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