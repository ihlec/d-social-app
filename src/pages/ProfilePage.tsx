// fileName: src/pages/ProfilePage.tsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ProfileHeader from '../components/ProfileHeader';
import Feed from '../features/feed/Feed';
import LoadingSpinner from '../components/LoadingSpinner';
import Sidebar from '../components/Sidebar';
import { useAppState } from '../state/useAppStorage';
import { resolveIpns, fetchUserStateChunk } from '../api/ipfsIpns';
import { UserState, Post } from '../types';
import { useScrollRestoration } from '../hooks/useScrollRestoration';
import logo from '/logo.png';
import { ArrowLeftIcon } from '../components/Icons';

const getLatestActivityTimestamp = (postId: string, postsMap: Map<string, Post>): number => {
    const post = postsMap.get(postId);
    if (!post || post.timestamp === 0) return 0;
    let latestTimestamp = post.timestamp;
    if (post.replies && post.replies.length > 0) {
        for (const replyId of post.replies) {
            const replyTimestamp = getLatestActivityTimestamp(replyId, postsMap);
            if (replyTimestamp > 0 && replyTimestamp > latestTimestamp) {
                latestTimestamp = replyTimestamp;
            }
        }
    }
    return latestTimestamp;
};

type ProfileTab = 'posts' | 'likes' | 'dislikes';

const ProfilePage: React.FC = () => {
    const { key: routeKey, tab: routeTab } = useParams<{ key: string; tab?: string }>();
    const profileKey = routeKey || '';
    const navigate = useNavigate();

    const activeTab: ProfileTab = (routeTab === 'likes' || routeTab === 'dislikes') ? routeTab : 'posts';

    const {
        myIpnsKey,
        myPeerId, 
        userState: currentUserState,
        allPostsMap,
        setUserProfilesMap,
        likePost,
        dislikePost,
        ensurePostsAreFetched,
        logout,
        otherUsers,
        userProfilesMap,
        followUser,
        unfollowUser,
        unresolvedFollows,
        latestStateCID
    } = useAppState();

    const [profileState, setProfileState] = useState<UserState | null>(null);
    const [isProfileLoading, setIsProfileLoading] = useState(false);
    const [isFeedLoading, setIsFeedLoading] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [isUsingCachedData, setIsUsingCachedData] = useState(false); // <--- NEW: State for fallback UI

    // Track the last key we tried to load to prevent wiping state on background updates
    const lastFetchedKey = useRef<string | null>(null);

    // Robust check for "My Profile" (matches ID or Label)
    const isMyProfile = (myPeerId === profileKey) || (myIpnsKey === profileKey);

    // --- Load Profile Data ---
    useEffect(() => {
        // Scroll to top when profile key changes
        window.scrollTo(0, 0);
        
        let isMounted = true;

        const loadProfile = async () => {
            if (!profileKey) return;

            // Optimization: If it's me, rely on global state initially
            if (isMyProfile && currentUserState) {
                setProfileState(currentUserState);

                // Force fetch my own posts if they are missing
                const cids = currentUserState.postCIDs || [];
                // Check against current map (safe due to effect dependencies usually or acceptable staleness for init)
                const missing = cids.filter(id => !allPostsMap.has(id));
                
                if (missing.length > 0) {
                    setIsFeedLoading(true);
                    // Force fetch to bypass backoff for the "My Profile" view
                    await ensurePostsAreFetched(cids, profileKey, true);
                    if (isMounted) setIsFeedLoading(false);
                }
                return;
            }

            // Otherwise, fetch stranger's data
            const isRefetch = lastFetchedKey.current === profileKey;
            
            if (!isRefetch) {
                setIsProfileLoading(true);
                setProfileState(null);
                if (isMounted) setIsUsingCachedData(false);
                lastFetchedKey.current = profileKey;
            }

            try {
                // 1. Attempt Live Resolve (Network)
                let headCid = await resolveIpns(profileKey);
                let usedCache = false;

                // 2. FALLBACK: If network fails, check our own follow list
                // This fixes the "No posts yet" issue if IPNS DHT is slow but we have a pointer.
                if (!headCid && currentUserState?.follows) {
                    const followEntry = currentUserState.follows.find(f => f.ipnsKey === profileKey);
                    if (followEntry?.lastSeenCid) {
                        console.warn(`[Profile] Network resolve failed. Falling back to cached Last Seen CID: ${followEntry.lastSeenCid}`);
                        headCid = followEntry.lastSeenCid;
                        usedCache = true;
                        // Pin the lastSeenCid to avoid waiting for IPNS resolution in future
                        const { pinCid } = await import('../api/admin');
                        pinCid(followEntry.lastSeenCid).catch(() => {}); // Fire-and-forget, don't block
                    }
                }

                // Handle direct CID links (legacy or explicit)
                if (!headCid && profileKey.startsWith('Qm')) {
                    headCid = profileKey;
                }

                if (headCid) {
                    if (isMounted) setIsUsingCachedData(usedCache); // Set UI flag
                    
                    const state = await fetchUserStateChunk(headCid);

                    if (isMounted && state) {
                        setProfileState(state as UserState);

                        // Update global profile cache
                        const loadedProfile = state.profile;
                        if (loadedProfile) {
                            setUserProfilesMap(prev => new Map(prev).set(profileKey, loadedProfile));
                        }

                        setIsProfileLoading(false);

                        // Fetch their posts if missing
                        const cids = state.postCIDs || [];
                        if (cids.length > 0) {
                            setIsFeedLoading(true);
                            await ensurePostsAreFetched(cids, profileKey, true);
                            if (isMounted) setIsFeedLoading(false);
                        }
                    } else {
                        if (isMounted) setIsProfileLoading(false);
                    }
                } else {
                    console.warn("Could not resolve profile key:", profileKey);
                    if (isMounted) setIsProfileLoading(false);
                }
            } catch (e) {
                console.error("Failed to load profile", e);
                if (isMounted) setIsProfileLoading(false);
            }
        };

        loadProfile();
        return () => { isMounted = false; };
    }, [profileKey, ensurePostsAreFetched, setUserProfilesMap, isMyProfile, currentUserState]);


    const displayData = useMemo(() => {
        const targetState = isMyProfile ? currentUserState : profileState;

        if (!targetState) {
            return { topLevelIds: [], postsWithReplies: allPostsMap, missingCids: [] };
        }

        let sourceCids: string[] = [];

        if (activeTab === 'posts') {
            sourceCids = targetState.postCIDs || [];
        } else if (activeTab === 'likes') {
            sourceCids = targetState.likedPostCIDs || [];
        } else if (activeTab === 'dislikes') {
            sourceCids = targetState.dislikedPostCIDs || [];
        }

        const filteredMap = new Map<string, Post>();

        sourceCids.forEach(cid => {
            const post = allPostsMap.get(cid);
            if (post) {
                filteredMap.set(cid, post);
            }
        });

        const sortedIds = Array.from(filteredMap.keys()).sort((a, b) => {
            const timeA = getLatestActivityTimestamp(a, filteredMap);
            const timeB = getLatestActivityTimestamp(b, filteredMap);
            return timeB - timeA;
        });

        return { topLevelIds: sortedIds, postsWithReplies: allPostsMap, missingCids: sourceCids };
    }, [profileState, currentUserState, allPostsMap, activeTab, isMyProfile]);

    // Ensure missing items (likes/dislikes) are fetched
    const attemptedForceCids = useRef(new Set<string>());

    // Reset attempts when profile changes to allow retrying on fresh navigation
    useEffect(() => {
        attemptedForceCids.current.clear();
    }, [profileKey]);

    useEffect(() => {
        let isMounted = true;
        if (displayData.missingCids && displayData.missingCids.length > 0) {
            const missing = displayData.missingCids.filter((id: string) => !allPostsMap.has(id));
            
            // Only force fetch CIDs we haven't forced yet in this session
            const toFetch = missing.filter(id => !attemptedForceCids.current.has(id));

            if (toFetch.length > 0) {
                toFetch.forEach(id => attemptedForceCids.current.add(id));
                
                // Indicate loading while fetching these missing items
                setIsFeedLoading(true);
                
                // Force fetch when viewing profile to bypass backoff
                ensurePostsAreFetched(toFetch, profileKey, true)
                    .finally(() => {
                        if (isMounted) setIsFeedLoading(false);
                    });
            }
        }
        return () => { isMounted = false; };
    }, [displayData.missingCids, allPostsMap, ensurePostsAreFetched, profileKey]);


    const loaderRef = useRef<HTMLDivElement>(null);
    useScrollRestoration(loaderRef, isFeedLoading, [displayData.topLevelIds.length]);

    return (
        <div className="app-container">
            <button
                className="sidebar-toggle-button"
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                title={isSidebarOpen ? "Close Sidebar" : "Open Sidebar"}
            >
                <img src={logo} alt="Logo" crossOrigin="anonymous"/>
            </button>

            <Sidebar
                isOpen={isSidebarOpen}
                onClose={() => setIsSidebarOpen(false)}
                userState={currentUserState}
                ipnsKey={myIpnsKey}
                peerId={myPeerId}
                latestCid={latestStateCID}
                unresolvedFollows={unresolvedFollows}
                otherUsers={otherUsers}
                onFollow={followUser}
                onUnfollow={unfollowUser}
                onViewProfile={(k) => { navigate(`/profile/${k}`); setIsSidebarOpen(false); }}
                onLogout={logout}
            />

            <button
                className="refresh-button"
                onClick={() => navigate('/')}
                title="Return to Feed"
            >
                <ArrowLeftIcon />
            </button>

            <div className="main-content">
                {isProfileLoading ? (
                    <div className="center-screen-loader">
                        <LoadingSpinner />
                        <p style={{ marginTop: '1rem', color: '#666' }}>Resolving Profile Identity...</p>
                    </div>
                ) : (
                    <>
                        <ProfileHeader
                            profileKey={profileKey}
                            profile={isMyProfile ? currentUserState?.profile || null : profileState?.profile || null}
                            isMyProfile={isMyProfile}
                        />

                        {/* --- NEW: Cached Data Warning Banner --- */}
                        {isUsingCachedData && (
                             <div style={{ 
                                 backgroundColor: 'rgba(255, 193, 7, 0.1)', 
                                 color: '#e0a800', 
                                 padding: '0.5rem', 
                                 margin: '0 1rem 1rem 1rem', 
                                 borderRadius: '4px',
                                 textAlign: 'center',
                                 fontSize: '0.85rem',
                                 border: '1px solid rgba(255, 193, 7, 0.2)'
                             }}>
                                 ⚠️ Network unreachable. Showing last known version.
                             </div>
                        )}

                        {isMyProfile && (
                            <div className="profile-tabs">
                                <button
                                    className={activeTab === 'posts' ? 'active' : ''}
                                    onClick={() => navigate(`/profile/${profileKey}/posts`)}
                                >
                                    My Posts
                                </button>
                                <button
                                    className={activeTab === 'likes' ? 'active' : ''}
                                    onClick={() => navigate(`/profile/${profileKey}/likes`)}
                                >
                                    Likes
                                </button>
                                <button
                                    className={activeTab === 'dislikes' ? 'active' : ''}
                                    onClick={() => navigate(`/profile/${profileKey}/dislikes`)}
                                >
                                    Dislikes
                                </button>
                            </div>
                        )}

                        <div style={{ padding: '0 0.5rem' }}>
                            <Feed
                                key={`${profileKey}-${activeTab}`} // Force remount when switching tabs or profiles to reset Masonry state
                                isLoading={isFeedLoading && displayData.topLevelIds.length === 0}
                                topLevelIds={displayData.topLevelIds || []}
                                allPostsMap={displayData.postsWithReplies}
                                userProfilesMap={userProfilesMap}
                                onViewProfile={(key) => navigate(`/profile/${key}`)}
                                currentUserState={currentUserState}
                                myPeerId={myPeerId}
                                onLikePost={currentUserState ? likePost : undefined}
                                onDislikePost={currentUserState ? dislikePost : undefined}
                                ensurePostsAreFetched={ensurePostsAreFetched}
                            />
                        </div>

                        <div ref={loaderRef} className="feed-loader-container">
                            {isFeedLoading && displayData.topLevelIds.length > 0 && activeTab !== 'posts' && (<LoadingSpinner />)}

                            {!isFeedLoading && displayData.topLevelIds.length === 0 && (
                                <p className="feed-end-message">
                                    {activeTab === 'posts' ? "No posts yet." :
                                        activeTab === 'likes' ? "No liked posts." : "No disliked posts."}
                                </p>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default ProfilePage;
