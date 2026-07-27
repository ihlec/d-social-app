import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ProfileHeader from '../components/ProfileHeader';
import Feed from '../features/feed/Feed';
import LoadingSpinner from '../components/LoadingSpinner';
import Sidebar from '../components/Sidebar';
import { useAppState } from '../state/useAppStorage';
import { resolveIpns, fetchUserStateChunk, requestPeerFeed, ensureRoomForPeer } from '../api/ipfsIpns';
import { startHelia } from '../api/heliaNode';
import { UserState, Post, UserProfile } from '../types';
import { useScrollRestoration } from '../hooks/useScrollRestoration';
import logo from '/logo.png';
import { ArrowLeftIcon } from '../components/Icons';

function postsByAuthor(postsMap: Map<string, Post>, authorKey: string): Post[] {
    const out: Post[] = [];
    postsMap.forEach(p => {
        if (p.authorKey === authorKey && !p.referenceCID) out.push(p);
    });
    return out.sort((a, b) => b.timestamp - a.timestamp);
}

function synthesizeStateFromLocal(
    authorKey: string,
    postsMap: Map<string, Post>,
    profileHint?: UserProfile | null,
): UserState {
    const roots = postsByAuthor(postsMap, authorKey);
    return {
        profile: profileHint || { name: authorKey.slice(0, 8) + '…' },
        postCIDs: roots.map(p => p.id),
        follows: [],
        likedPostCIDs: [],
        dislikedPostCIDs: [],
        savedPostCIDs: [],
        updatedAt: roots[0]?.timestamp || Date.now(),
        extendedUserState: null,
    };
}

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
        isLoggedIn,
        userState: currentUserState,
        allPostsMap,
        setAllPostsMap,
        setUserProfilesMap,
        likePost,
        dislikePost,
        savePost,
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
    const [isUsingCachedData, setIsUsingCachedData] = useState(false);
    const [peerWaitFailed, setPeerWaitFailed] = useState(false);

    // Only skip reload after a successful resolve for this key
    const resolvedKeyRef = useRef<string | null>(null);
    const loadGenRef = useRef(0);
    const allPostsMapRef = useRef(allPostsMap);
    allPostsMapRef.current = allPostsMap;
    const otherUsersRef = useRef(otherUsers);
    otherUsersRef.current = otherUsers;
    const userProfilesMapRef = useRef(userProfilesMap);
    userProfilesMapRef.current = userProfilesMap;
    const currentUserStateRef = useRef(currentUserState);
    currentUserStateRef.current = currentUserState;
    const hasOwnState = !!currentUserState;
    const isOnlineForProfile = otherUsers.some(u => u.ipnsKey === profileKey);

    // Robust check for "My Profile" (matches ID or Label)
    const isMyProfile = (myPeerId === profileKey) || (myIpnsKey === profileKey);

    // Deps must stay a fixed-length array. Read mutable maps/state via refs so
    // feed updates do not re-trigger P2P/IPNS (that caused hundreds of syncs).
    useEffect(() => {
        window.scrollTo(0, 0);

        if (!profileKey) return;

        // Already resolved this profile — ignore parent re-renders / own-state churn
        if (resolvedKeyRef.current === profileKey) {
            if (isMyProfile && currentUserStateRef.current) {
                setProfileState(currentUserStateRef.current);
            }
            return;
        }

        const gen = ++loadGenRef.current;
        const stillCurrent = () => loadGenRef.current === gen;

        const loadProfile = async () => {
            const me = currentUserStateRef.current;
            const guest = isLoggedIn !== true;

            // Own profile: wait until global state exists
            if (isMyProfile) {
                if (!me) return;
                setProfileState(me);
                setIsProfileLoading(false);
                setIsUsingCachedData(false);
                setPeerWaitFailed(false);
                resolvedKeyRef.current = profileKey;
                const cids = me.postCIDs || [];
                const missing = cids.filter(id => !allPostsMapRef.current.has(id));
                if (missing.length > 0) {
                    setIsFeedLoading(true);
                    await ensurePostsAreFetched(cids, profileKey, true);
                    if (stillCurrent()) setIsFeedLoading(false);
                }
                return;
            }

            setIsProfileLoading(true);
            setProfileState(null);
            setIsUsingCachedData(false);
            setPeerWaitFailed(false);

            try {
                let usedCache = false;
                let state: Partial<UserState> | null = null;
                const isOnline = otherUsersRef.current.some(u => u.ipnsKey === profileKey);

                const applyState = (next: Partial<UserState>, cached: boolean) => {
                    if (!stillCurrent()) return;
                    const localRoots = postsByAuthor(allPostsMapRef.current, profileKey);
                    const mergedCids = [
                        ...new Set([...(next.postCIDs || []), ...localRoots.map(p => p.id)]),
                    ];
                    const fullState = { ...next, postCIDs: mergedCids } as UserState;
                    setProfileState(fullState);
                    setIsUsingCachedData(cached);
                    setPeerWaitFailed(false);
                    if (fullState.profile) {
                        setUserProfilesMap(prev => new Map(prev).set(profileKey, fullState.profile));
                    }
                    setIsProfileLoading(false);
                };

                // Guest / share-link: Helia + one on-demand author home shard (no feed crawl)
                try {
                    await startHelia();
                    await ensureRoomForPeer(profileKey);
                } catch { /* continue */ }

                // 0a) Instant local: posts already in the feed from Explore/P2P
                {
                    const online = otherUsersRef.current.find(u => u.ipnsKey === profileKey);
                    const hint =
                        userProfilesMapRef.current.get(profileKey)
                        || (online ? { name: online.name } : null);
                    const localPosts = postsByAuthor(allPostsMapRef.current, profileKey);
                    if (localPosts.length > 0) {
                        state = synthesizeStateFromLocal(profileKey, allPostsMapRef.current, hint);
                        usedCache = true;
                        applyState(state, true);
                        console.log(`[Profile] Instant local posts for ${profileKey.slice(0, 12)}… (${localPosts.length})`);
                    }
                }

                // 0b) Trystero P2P — browser Helia peers are not on public IPNS
                try {
                    let p2p = await requestPeerFeed(profileKey);
                    if (!p2p?.ok && (isOnline || guest)) {
                        for (let attempt = 0; attempt < 4 && !p2p?.ok && stillCurrent(); attempt++) {
                            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                            p2p = await requestPeerFeed(profileKey);
                        }
                    }
                    if (p2p?.ok && p2p.state) {
                        state = p2p.state;
                        usedCache = false;
                        if (p2p.posts?.length) {
                            const localIds = p2p.posts.map(p => p.id);
                            state = {
                                ...state,
                                postCIDs: [...new Set([...(state.postCIDs || []), ...localIds])],
                            };
                            setAllPostsMap(prev => {
                                const next = new Map(prev);
                                for (const p of p2p!.posts) {
                                    if (p?.id) {
                                        next.set(p.id, {
                                            ...p,
                                            authorKey: p.authorKey || profileKey,
                                        });
                                    }
                                }
                                return next;
                            });
                        }
                        applyState(state, false);
                        console.log(`[Profile] Loaded via P2P: ${profileKey.slice(0, 12)}…`);
                    } else if (isOnline && !state?.postCIDs?.length) {
                        console.warn(`[Profile] P2P sync failed for online peer ${profileKey.slice(0, 12)}…`);
                    }
                } catch { /* fall through */ }

                if (!stillCurrent()) return;

                // Guests: stop after author-shard P2P (no explore crawl / IPNS gateway spam)
                if (guest) {
                    if (state) {
                        applyState(state, usedCache);
                        if (stillCurrent()) resolvedKeyRef.current = profileKey;
                        const mergedCids = [
                            ...new Set([
                                ...(state.postCIDs || []),
                                ...postsByAuthor(allPostsMapRef.current, profileKey).map(p => p.id),
                            ]),
                        ];
                        const missing = mergedCids.filter(id => !allPostsMapRef.current.has(id));
                        if (missing.length > 0) {
                            setIsFeedLoading(true);
                            await ensurePostsAreFetched(missing, profileKey, true);
                            if (stillCurrent()) setIsFeedLoading(false);
                        }
                    } else {
                        console.warn('Guest could not resolve profile via P2P:', profileKey);
                        if (stillCurrent()) {
                            setIsProfileLoading(false);
                            setPeerWaitFailed(true);
                        }
                    }
                    return;
                }

                // 1) Public / local IPNS only for offline peers when we still have nothing
                let headCid = '';
                if (!state?.postCIDs?.length && !isOnline) {
                    headCid = await resolveIpns(profileKey);
                }

                // 2) Follow-list lastSeenCid
                if (!state && !headCid && me?.follows) {
                    const followEntry = me.follows.find(f => f.ipnsKey === profileKey);
                    if (followEntry?.lastSeenCid) {
                        console.warn(`[Profile] Network resolve failed. Falling back to cached Last Seen CID: ${followEntry.lastSeenCid}`);
                        headCid = followEntry.lastSeenCid;
                        usedCache = true;
                        const { pinCid } = await import('../api/admin');
                        pinCid(followEntry.lastSeenCid).catch(() => {});
                    }
                }

                // Online peer announced stateCid (fetch via content gateways / Helia, not IPNS)
                if (!state && !headCid) {
                    const online = otherUsersRef.current.find(u => u.ipnsKey === profileKey);
                    if (online?.stateCid) {
                        headCid = online.stateCid;
                        usedCache = true;
                    }
                }

                if (!headCid && profileKey.startsWith('Qm')) {
                    headCid = profileKey;
                }

                if (!state && headCid) {
                    if (stillCurrent()) setIsUsingCachedData(usedCache);
                    state = await fetchUserStateChunk(headCid, profileKey).catch(() => null);
                }

                // 3) Local feed already has their posts — synthesize a profile
                if (!state) {
                    const online = otherUsersRef.current.find(u => u.ipnsKey === profileKey);
                    const hint =
                        userProfilesMapRef.current.get(profileKey)
                        || (online ? { name: online.name } : null);
                    const localPosts = postsByAuthor(allPostsMapRef.current, profileKey);
                    if (localPosts.length > 0 || hint) {
                        console.warn(`[Profile] Using local/P2P-visible posts for ${profileKey.slice(0, 12)}… (${localPosts.length})`);
                        state = synthesizeStateFromLocal(profileKey, allPostsMapRef.current, hint);
                        usedCache = true;
                    }
                }

                if (!stillCurrent()) return;

                if (state) {
                    applyState(state, usedCache);
                    if (stillCurrent()) resolvedKeyRef.current = profileKey;
                    const mergedCids = [
                        ...new Set([
                            ...(state.postCIDs || []),
                            ...postsByAuthor(allPostsMapRef.current, profileKey).map(p => p.id),
                        ]),
                    ];
                    const missing = mergedCids.filter(id => !allPostsMapRef.current.has(id));
                    if (missing.length > 0) {
                        setIsFeedLoading(true);
                        await ensurePostsAreFetched(missing, profileKey, true);
                        if (stillCurrent()) setIsFeedLoading(false);
                    }
                } else {
                    console.warn('Could not resolve profile key:', profileKey);
                    setIsProfileLoading(false);
                    setPeerWaitFailed(true);
                    // Leave resolvedKeyRef unset so a later online/P2P attempt can retry
                }
            } catch (e) {
                console.error('Failed to load profile', e);
                if (stillCurrent()) {
                    setIsProfileLoading(false);
                    setPeerWaitFailed(true);
                }
            }
        };

        void loadProfile();
        return () => { loadGenRef.current += 1; };
        // isOnlineForProfile: retry once when a peer appears after a failed resolve
    }, [profileKey, isMyProfile, hasOwnState, isOnlineForProfile, isLoggedIn, ensurePostsAreFetched, setUserProfilesMap, setAllPostsMap]);


    const displayData = useMemo(() => {
        const targetState = isMyProfile ? currentUserState : profileState;

        // Even without a resolved UserState, show posts we already have for this author
        const localAuthorPosts = postsByAuthor(allPostsMap, profileKey);

        if (!targetState && localAuthorPosts.length === 0) {
            return { topLevelIds: [], postsWithReplies: allPostsMap, missingCids: [] as string[] };
        }

        let sourceCids: string[] = [];

        if (activeTab === 'posts') {
            sourceCids = [
                ...new Set([
                    ...(targetState?.postCIDs || []),
                    ...localAuthorPosts.map(p => p.id),
                ]),
            ];
        } else if (activeTab === 'likes') {
            sourceCids = targetState?.likedPostCIDs || [];
        } else if (activeTab === 'dislikes') {
            sourceCids = targetState?.dislikedPostCIDs || [];
        }

        const filteredMap = new Map<string, Post>();

        sourceCids.forEach(cid => {
            const post = allPostsMap.get(cid);
            // Skip missing / legacy placeholder shells
            if (post && post.timestamp !== 0) {
                filteredMap.set(cid, post);
            }
        });

        const sortedIds = Array.from(filteredMap.keys()).sort((a, b) => {
            const timeA = getLatestActivityTimestamp(a, filteredMap);
            const timeB = getLatestActivityTimestamp(b, filteredMap);
            return timeB - timeA;
        });

        return { topLevelIds: sortedIds, postsWithReplies: allPostsMap, missingCids: sourceCids };
    }, [profileState, currentUserState, allPostsMap, activeTab, isMyProfile, profileKey]);

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
                data-testid="sidebar-toggle"
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
                onClick={() => navigate(isLoggedIn ? '/' : '/login')}
                title={isLoggedIn ? 'Return to Feed' : 'Log in'}
                data-testid="back-to-feed"
            >
                <ArrowLeftIcon />
            </button>

            <div className="main-content">
                {isProfileLoading ? (
                    <div className="center-screen-loader">
                        <LoadingSpinner />
                        <p style={{ marginTop: '1rem', color: '#666' }}>
                            {isLoggedIn ? 'Resolving Profile Identity...' : 'Waiting for a peer who has this…'}
                        </p>
                    </div>
                ) : peerWaitFailed && !profileState && displayData.topLevelIds.length === 0 ? (
                    <div className="error-message" style={{ padding: '2rem', textAlign: 'center' }}>
                        <p>Peer offline — not cached.</p>
                        <p style={{ color: '#888', fontSize: '0.9rem' }}>
                            Open this profile again while the author is online, or log in if you already follow them.
                        </p>
                        {isLoggedIn !== true && (
                            <button type="button" className="save-button" onClick={() => navigate('/login')}>
                                Log in
                            </button>
                        )}
                    </div>
                ) : (
                    <>
                        <ProfileHeader
                            profileKey={profileKey}
                            profile={
                                isMyProfile
                                    ? currentUserState?.profile || null
                                    : profileState?.profile
                                        || userProfilesMap.get(profileKey)
                                        || (otherUsers.find(u => u.ipnsKey === profileKey)
                                            ? { name: otherUsers.find(u => u.ipnsKey === profileKey)!.name }
                                            : null)
                            }
                            isMyProfile={isMyProfile}
                        />

                        {isLoggedIn !== true && (
                            <div style={{
                                margin: '0 1rem 1rem',
                                padding: '0.75rem 1rem',
                                textAlign: 'center',
                                border: '1px solid rgba(128,128,128,0.25)',
                                borderRadius: '4px',
                            }}>
                                <p style={{ margin: '0 0 0.5rem', color: '#888', fontSize: '0.9rem' }}>
                                    Log in to follow, like, and use your feed.
                                </p>
                                <button type="button" className="save-button" onClick={() => navigate('/login')}>
                                    Log in
                                </button>
                            </div>
                        )}

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
                                 Network unreachable. Showing last known version.
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
                                onSavePost={currentUserState ? savePost : undefined}
                                ensurePostsAreFetched={ensurePostsAreFetched}
                            />
                        </div>

                        <div ref={loaderRef} className="feed-loader-container">
                            {isFeedLoading && displayData.topLevelIds.length > 0 && activeTab !== 'posts' && (<LoadingSpinner />)}

                            {!isFeedLoading && displayData.topLevelIds.length === 0 && (
                                <p className="feed-end-message">
                                    {activeTab === 'posts'
                                        ? (isLoggedIn !== true
                                            ? 'Waiting for a peer who has this… or peer offline — not cached.'
                                            : 'No posts yet.')
                                        : activeTab === 'likes' ? 'No liked posts.' : 'No disliked posts.'}
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
