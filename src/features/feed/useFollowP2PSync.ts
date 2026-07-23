/**
 * When a followed peer appears online on Trystero, pull their tip via syncFeed
 * and update My Feed — do not wait on public IPNS/gateways.
 */

import { useEffect, useRef } from 'react';
import { Follow, OnlinePeer, Post, UserProfile, UserState } from '../../types';
import { requestPeerFeed } from '../../api/ipfsIpns';
import * as contentCache from '../../lib/contentCache';
import { prefetchPeerMedia } from '../../lib/prefetchPeerMedia';

interface UseFollowP2PSyncArgs {
    otherUsers: OnlinePeer[];
    userState: UserState | null;
    /** Resolved k51 identity — same key space as OnlinePeer.ipnsKey. */
    myPeerId: string;
    setAllPostsMap: React.Dispatch<React.SetStateAction<Map<string, Post>>>;
    setAllUserStatesMap: React.Dispatch<React.SetStateAction<Map<string, UserState>>>;
    setUserProfilesMap: React.Dispatch<React.SetStateAction<Map<string, UserProfile>>>;
    setUnresolvedFollows: React.Dispatch<React.SetStateAction<string[]>>;
    setFollowCursors: React.Dispatch<React.SetStateAction<Map<string, string | null>>>;
    updateFollowMetadata: (updatedFollows: Follow[]) => Promise<void>;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<unknown>;
    enabled: boolean;
}

export function useFollowP2PSync({
    otherUsers,
    userState,
    myPeerId,
    setAllPostsMap,
    setAllUserStatesMap,
    setUserProfilesMap,
    setUnresolvedFollows,
    setFollowCursors,
    updateFollowMetadata,
    ensurePostsAreFetched,
    enabled,
}: UseFollowP2PSyncArgs): void {
    /** ipnsKey → last stateCid (or 'p2p') we successfully applied */
    const syncedTipRef = useRef<Map<string, string>>(new Map());
    const inFlightRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!enabled || !userState?.follows?.length || otherUsers.length === 0) return;

        const followByKey = new Map(
            userState.follows.filter((f) => f.ipnsKey).map((f) => [f.ipnsKey, f])
        );

        const onlineFollows = otherUsers.filter(
            (u) => u.ipnsKey && u.ipnsKey !== myPeerId && followByKey.has(u.ipnsKey)
        );

        for (const peer of onlineFollows) {
            const tipKey = peer.stateCid || 'p2p';
            if (syncedTipRef.current.get(peer.ipnsKey) === tipKey) continue;
            if (inFlightRef.current.has(peer.ipnsKey)) continue;

            const follow = followByKey.get(peer.ipnsKey)!;
            // Skip if we already have this tip from lastSeenCid and no fresher announce
            if (peer.stateCid && follow.lastSeenCid === peer.stateCid
                && syncedTipRef.current.has(peer.ipnsKey)) {
                continue;
            }

            inFlightRef.current.add(peer.ipnsKey);

            void (async () => {
                try {
                    let p2p = await requestPeerFeed(peer.ipnsKey);
                    if (!p2p?.ok) {
                        for (let attempt = 0; attempt < 3 && !p2p?.ok; attempt++) {
                            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                            p2p = await requestPeerFeed(peer.ipnsKey);
                        }
                    }

                    if (!p2p?.ok || !p2p.state) {
                        console.debug(
                            `[FollowP2P] sync failed for ${peer.ipnsKey.slice(0, 12)}…`
                        );
                        return;
                    }

                    const state = p2p.state;
                    const stateCid = p2p.stateCid || peer.stateCid || '';
                    const appliedTip = stateCid || 'p2p';

                    setAllUserStatesMap((prev) => {
                        const next = new Map(prev);
                        next.set(peer.ipnsKey, state as UserState);
                        return next;
                    });

                    if (state.profile) {
                        setUserProfilesMap((prev) => new Map(prev).set(peer.ipnsKey, state.profile!));
                    }

                    const newPosts = (p2p.posts || [])
                        .filter((p) => p?.id)
                        .map((p) => ({
                            ...p,
                            authorKey: p.authorKey || peer.ipnsKey,
                        }));

                    if (newPosts.length > 0) {
                        setAllPostsMap((prev) => {
                            const next = new Map(prev);
                            for (const p of newPosts) next.set(p.id, p);
                            return next;
                        });
                        void prefetchPeerMedia(peer.ipnsKey, newPosts);
                    }

                    const postCids = (state.postCIDs || []).slice(0, 10);
                    if (postCids.length > 0) {
                        await ensurePostsAreFetched(postCids, peer.ipnsKey);
                    }

                    if (stateCid) {
                        contentCache.putUserState(peer.ipnsKey, state as UserState, stateCid).catch(() => {});
                        setFollowCursors((prev) => new Map(prev).set(peer.ipnsKey, `${stateCid}|0`));
                    }

                    setUnresolvedFollows((prev) => prev.filter((k) => k !== peer.ipnsKey));

                    const foundName = state.profile?.name;
                    const needsMeta =
                        !!stateCid
                        && (stateCid !== follow.lastSeenCid
                            || (!!foundName && foundName !== follow.name));

                    if (needsMeta) {
                        await updateFollowMetadata([{
                            ...follow,
                            lastSeenCid: stateCid,
                            updatedAt: Date.now(),
                            ...(foundName ? { name: foundName } : {}),
                        }]);
                    }

                    syncedTipRef.current.set(peer.ipnsKey, appliedTip);
                    console.debug(
                        `[FollowP2P] Synced follow ${peer.ipnsKey.slice(0, 12)}…`
                        + ` tip=${(stateCid || 'local').slice(0, 12)}…`
                        + ` posts=${newPosts.length}`
                    );
                } catch (e) {
                    console.warn(`[FollowP2P] error for ${peer.ipnsKey.slice(0, 12)}…`, e);
                } finally {
                    inFlightRef.current.delete(peer.ipnsKey);
                }
            })();
        }
    }, [
        enabled,
        otherUsers,
        userState?.follows,
        myPeerId,
        setAllPostsMap,
        setAllUserStatesMap,
        setUserProfilesMap,
        setUnresolvedFollows,
        setFollowCursors,
        updateFollowMetadata,
        ensurePostsAreFetched,
    ]);
}
