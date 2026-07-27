import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Masonry } from "masonic";
import PostComponent from './PostItem'; 
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';
import './Feed.css';

/**
 * Masonic caches cell heights by index. Appending at the end is fine; inserting
 * or reordering (e.g. own post before explore items) leaves stale heights and
 * cards overlap. Remount only when the id sequence is not a pure append.
 */
function useMasonryLayoutKey(ids: string[]): number {
  const prevIdsRef = useRef<string[]>([]);
  const [layoutKey, setLayoutKey] = useState(0);

  useEffect(() => {
    const prev = prevIdsRef.current;
    const next = ids;
    prevIdsRef.current = next;

    if (prev.length === 0) return;

    let needsReset = next.length < prev.length;
    if (!needsReset) {
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== next[i]) {
          needsReset = true;
          break;
        }
      }
    }
    if (needsReset) setLayoutKey((k) => k + 1);
  }, [ids]);

  return layoutKey;
}

interface FeedProps {
  isLoading: boolean;
  topLevelIds: string[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onViewProfile: (key: string) => void;
  onSetReplyingTo?: (post: Post | null) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  onSavePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myPeerId: string;
  ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
}

// Masonic owns the card instance; context avoids recreating the render fn each update.
interface FeedPropsContextType {
    allPostsMap: Map<string, Post>;
    userProfilesMap: Map<string, UserProfile>;
    onViewProfile: (key: string) => void;
    onSetReplyingTo?: (post: Post | null) => void;
    onLikePost?: (postId: string) => void;
    onDislikePost?: (postId: string) => void;
    onSavePost?: (postId: string) => void;
    currentUserState: UserState | null;
    myPeerId: string;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
    getContextIds: () => string[];
}

const FeedPropsContext = React.createContext<FeedPropsContextType | null>(null);

const FeedPostCard = ({ data: item }: { index: number, data: { id: string }, width: number }) => {
    const props = React.useContext(FeedPropsContext);
    if (!props) return <div style={{ height: 0 }} />;

    const { 
        allPostsMap, userProfilesMap, onViewProfile, onSetReplyingTo, onLikePost, onDislikePost, onSavePost,
        currentUserState, myPeerId, ensurePostsAreFetched, getContextIds 
    } = props;

    // Use internal data.id from masonic item wrapper
    const postId = item.id;
    const post = allPostsMap.get(postId);

    if (!post) {
        return (
            <div data-post-id={postId} className="post post-placeholder feed-post-placeholder">
                <LoadingSpinner />
            </div>
        );
    }

    return (
        <div data-post-id={post.id} className="feed-post-card-container"> 
            <PostComponent
                postId={postId} 
                allPostsMap={allPostsMap}
                userProfilesMap={userProfilesMap}
                onViewProfile={onViewProfile}
                onSetReplyingTo={onSetReplyingTo}
                onLikePost={onLikePost}
                onDislikePost={onDislikePost}
                onSavePost={onSavePost}
                currentUserState={currentUserState}
                myPeerId={myPeerId}
                ensurePostsAreFetched={ensurePostsAreFetched}
                getContextIds={getContextIds} 
            />
        </div>
    );
};

const Feed: React.FC<FeedProps> = ({
  isLoading,
  topLevelIds,
  allPostsMap,
  userProfilesMap,
  onViewProfile,
  onSetReplyingTo,
  onLikePost,
  onDislikePost,
  onSavePost,
  currentUserState,
  myPeerId,
  ensurePostsAreFetched,
}) => {

  // Stable item object refs — Masonic keys height cache by object identity.
  const stableItemsRef = React.useRef<Map<string, { id: string }>>(new Map());

  const topLevelIdsRef = React.useRef(topLevelIds);
  React.useEffect(() => { topLevelIdsRef.current = topLevelIds; }, [topLevelIds]);

  const getContextIds = React.useCallback(() => topLevelIdsRef.current, []);

  const items = useMemo(() => {
      const uniqueIds = Array.from(new Set(topLevelIds));

      const result = uniqueIds
        .filter(id => id && typeof id === 'string')
        .map(id => {
            if (!stableItemsRef.current.has(id)) {
                stableItemsRef.current.set(id, { id });
            }
            return stableItemsRef.current.get(id)!;
        });

      const currentIdSet = new Set(uniqueIds);
      for (const [key] of stableItemsRef.current) {
          if (!currentIdSet.has(key)) {
              stableItemsRef.current.delete(key);
          }
      }

      return result;
  }, [topLevelIds]);

  // Stable id list for layout invalidation (same order as items)
  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const masonryLayoutKey = useMasonryLayoutKey(itemIds);

  // Context value object
  const contextValue = useMemo(() => ({
      allPostsMap,
      userProfilesMap,
      onViewProfile,
      onSetReplyingTo,
      onLikePost,
      onDislikePost,
      onSavePost,
      currentUserState,
      myPeerId,
      ensurePostsAreFetched,
      getContextIds
  }), [allPostsMap, userProfilesMap, onViewProfile, onSetReplyingTo, onLikePost, onDislikePost, onSavePost, currentUserState, myPeerId, ensurePostsAreFetched, getContextIds]);

  if (isLoading) {
    return (
      <div className="feed-loading-container">
        <LoadingSpinner />
      </div>
    );
  }
  
  return (
    <FeedPropsContext.Provider value={contextValue}>
        <Masonry
            key={masonryLayoutKey}
            items={items}
            render={FeedPostCard}
            itemKey={(data) => data?.id || 'unknown'} 
            columnGutter={0}
            columnWidth={300}
            overscanBy={5} 
            itemHeightEstimate={400} 
        />
    </FeedPropsContext.Provider>
  );
};

export default Feed;