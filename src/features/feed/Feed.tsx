// fileName: src/features/feed/Feed.tsx
import React, { useMemo } from 'react';
import { Masonry } from "masonic";
import PostComponent from './PostItem'; 
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';
import './Feed.css';

interface FeedProps {
  isLoading: boolean;
  topLevelIds: string[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onViewProfile: (key: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myPeerId: string;
  ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
}

// 1. Create a Context to pass props to the Masonic Render Component
// because masonic instantiates it and we can't easily pass closures without recreating the component on every render (which kills performance).
interface FeedPropsContextType {
    allPostsMap: Map<string, Post>;
    userProfilesMap: Map<string, UserProfile>;
    onViewProfile: (key: string) => void;
    onLikePost?: (postId: string) => void;
    onDislikePost?: (postId: string) => void;
    currentUserState: UserState | null;
    myPeerId: string;
    ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
    getContextIds: () => string[];
}

const FeedPropsContext = React.createContext<FeedPropsContextType | null>(null);

// 2. The Render Component for Masonic (moved outside)
// Receives { index, data, width }
const FeedPostCard = ({ data: item }: { index: number, data: { id: string }, width: number }) => {
    const props = React.useContext(FeedPropsContext);
    // FIX: Never return null, masonic might not like it if it tries to measure the node
    if (!props) return <div style={{ height: 0 }} />;

    const { 
        allPostsMap, userProfilesMap, onViewProfile, onLikePost, onDislikePost, 
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
                onLikePost={onLikePost}
                onDislikePost={onDislikePost}
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
  onLikePost,
  onDislikePost,
  currentUserState,
  myPeerId,
  ensurePostsAreFetched,
}) => {

  // Prepare items for Masonic (requires objects)
  // FIX: Stable reference cache is REQUIRED for Masonic to prevent WeakMap errors.
  // Masonic uses the item object reference as a key in a WeakMap to store measurements.
  // If we return new objects every render, we break this association and potentially crash 
  // if an old reference is accessed.
  const stableItemsRef = React.useRef<Map<string, { id: string }>>(new Map());

  // Stable Accessor for Context IDs to avoid re-rendering all posts when list grows
  const topLevelIdsRef = React.useRef(topLevelIds);
  React.useEffect(() => { topLevelIdsRef.current = topLevelIds; }, [topLevelIds]);
  
  const getContextIds = React.useCallback(() => topLevelIdsRef.current, []);

  const items = useMemo(() => {
      // Deduplicate IDs first
      const uniqueIds = Array.from(new Set(topLevelIds));
      
      const result = uniqueIds
        .filter(id => id && typeof id === 'string')
        .map(id => {
            if (!stableItemsRef.current.has(id)) {
                stableItemsRef.current.set(id, { id });
            }
            return stableItemsRef.current.get(id)!;
        });

      // Cleanup: Remove IDs that are no longer present to prevent memory leaks
      const currentIdSet = new Set(uniqueIds);
      for (const [key] of stableItemsRef.current) {
          if (!currentIdSet.has(key)) {
              stableItemsRef.current.delete(key);
          }
      }

      return result;
  }, [topLevelIds]);

  // Context value object
  const contextValue = useMemo(() => ({
      allPostsMap,
      userProfilesMap,
      onViewProfile,
      onLikePost,
      onDislikePost,
      currentUserState,
      myPeerId,
      ensurePostsAreFetched,
      getContextIds
  }), [allPostsMap, userProfilesMap, onViewProfile, onLikePost, onDislikePost, currentUserState, myPeerId, ensurePostsAreFetched, getContextIds]);

  if (isLoading) {
    return (
      <div className="feed-loading-container">
        <LoadingSpinner />
      </div>
    );
  }
  
  return (
    <FeedPropsContext.Provider value={contextValue}>
        {/* 
           FIX: Jitter/Centering Issues & Crash Safety
           1. autoHeight={false}: Forces Masonic to use absolute positioning logic.
           2. overscanBy: Increased buffer.
           3. itemHeightEstimate: Helps initial layout.
           4. itemKey: Explicitly tell Masonic how to identify items to prevent WeakMap errors on updates.
        */}
        <Masonry
            // Removed key={items.length} to restore smooth scrolling
            items={items}
            render={FeedPostCard}
            itemKey={(data) => data?.id || 'unknown'} 
            columnGutter={16}
            columnWidth={300}
            overscanBy={5} 
            itemHeightEstimate={400} 
        />
    </FeedPropsContext.Provider>
  );
};

export default Feed;