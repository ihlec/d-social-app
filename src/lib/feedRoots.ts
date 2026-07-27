import type { Post } from '../types';

/**
 * Walk referenceCID parents to the top-level root.
 * If a parent is missing from the map, returns the missing CID so callers can fetch it.
 */
export function findThreadRoot(
    postsMap: Map<string, Post>,
    startId: string
): { rootId: string; root: Post | undefined; missingParentId?: string } {
    let curr = postsMap.get(startId);
    if (!curr) {
        return { rootId: startId, root: undefined, missingParentId: startId };
    }

    const visited = new Set<string>();
    while (curr.referenceCID && !visited.has(curr.id)) {
        visited.add(curr.id);
        const parent = postsMap.get(curr.referenceCID);
        if (!parent) {
            return {
                rootId: curr.referenceCID,
                root: undefined,
                missingParentId: curr.referenceCID,
            };
        }
        curr = parent;
    }
    return { rootId: curr.id, root: curr };
}

/**
 * Home-feed root IDs: own/follow top-level posts, plus roots of threads where
 * you or someone you follow replied (even if the root author is a stranger).
 * Preserves first-seen order from `postsMap` iteration (insertion order).
 */
export function collectHomeFeedRootIds(
    postsMap: Map<string, Post>,
    opts: {
        myKeys: Iterable<string | undefined | null>;
        followingKeys: Iterable<string>;
        blockedKeys?: Iterable<string>;
        dislikedIds?: Set<string>;
    }
): { rootIds: string[]; missingParentIds: string[] } {
    const mySet = new Set(
        [...opts.myKeys].filter((k): k is string => !!k && k.length > 0)
    );
    const followingSet = new Set(
        [...opts.followingKeys].filter((k) => !!k && k.length > 0)
    );
    const blockedSet = new Set(opts.blockedKeys || []);
    const dislikedIds = opts.dislikedIds || new Set<string>();

    const isActor = (authorKey: string) =>
        mySet.has(authorKey) || followingSet.has(authorKey);

    const isValidRoot = (p: Post) =>
        !p.referenceCID &&
        !dislikedIds.has(p.id) &&
        !blockedSet.has(p.authorKey);

    const rootIds: string[] = [];
    const seen = new Set<string>();
    const missingParentIds: string[] = [];
    const missingSeen = new Set<string>();

    for (const post of postsMap.values()) {
        if (!isActor(post.authorKey)) continue;
        if (blockedSet.has(post.authorKey)) continue;

        if (!post.referenceCID) {
            if (isValidRoot(post) && !seen.has(post.id)) {
                seen.add(post.id);
                rootIds.push(post.id);
            }
            continue;
        }

        const { root, missingParentId } = findThreadRoot(postsMap, post.id);
        if (missingParentId && !missingSeen.has(missingParentId)) {
            missingSeen.add(missingParentId);
            missingParentIds.push(missingParentId);
        }
        if (root && isValidRoot(root) && !seen.has(root.id)) {
            seen.add(root.id);
            rootIds.push(root.id);
        }
    }

    return { rootIds, missingParentIds };
}
