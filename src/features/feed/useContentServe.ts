import { useEffect, useRef } from 'react';
import type { UserState } from '../../types';
import {
    clearWantRooms,
    ensureContentRoom,
    setContentWantHandler,
    syncWantRoomsForServeSet,
} from '../../api/pubsub';
import { heliaHasBlock, startHelia } from '../../api/heliaNode';
import { serveCidsFromState } from '../../lib/peerShards';

interface UseContentServeArgs {
    isLoggedIn: boolean | null;
    userState: UserState | null;
}

/** Join want shards for own/liked/saved CIDs; on match, open an ephemeral content room. */
export function useContentServe({ isLoggedIn, userState }: UseContentServeArgs): void {
    const serveKey = serveCidsFromState(userState).join(',');
    const servingRef = useRef(new Set<string>());

    useEffect(() => {
        if (isLoggedIn !== true) {
            setContentWantHandler(null);
            void clearWantRooms();
            servingRef.current.clear();
            return;
        }

        const serveCids = serveCidsFromState(userState);
        const serveSet = new Set(serveCids);
        void syncWantRoomsForServeSet(serveCids);

        setContentWantHandler((cid) => {
            const clean = (cid || '').trim();
            if (!clean || !serveSet.has(clean)) return;
            if (servingRef.current.has(clean)) return;
            servingRef.current.add(clean);

            void (async () => {
                let joined = false;
                try {
                    await startHelia();
                    if (!(await heliaHasBlock(clean))) {
                        // Miss: release immediately so a later pin/sync can serve.
                        servingRef.current.delete(clean);
                        return;
                    }
                    await ensureContentRoom(clean, { sticky: false });
                    joined = true;
                } catch (e) {
                    console.debug('[Serve] want handle failed', e);
                } finally {
                    if (joined) {
                        setTimeout(() => servingRef.current.delete(clean), 60_000);
                    } else {
                        servingRef.current.delete(clean);
                    }
                }
            })();
        });

        return () => {
            setContentWantHandler(null);
        };
    }, [isLoggedIn, serveKey, userState]);

    useEffect(() => {
        return () => {
            void clearWantRooms();
        };
    }, []);
}
