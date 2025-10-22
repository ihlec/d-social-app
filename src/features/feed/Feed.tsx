// src/features/feed/Feed.tsx
import React from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import PostComponent from './PostItem';
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';

// Type for the row structure
type FeedRowItem = string | string[];


interface FeedProps {
  isLoading: boolean;
  feedRowItems: FeedRowItem[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onSetReplyingTo?: (post: Post | null) => void;
  onViewProfile: (ipnsKey: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myIpnsKey: string;
  ensurePostsAreFetched?: (postCids: string[]) => Promise<void>;
  footerComponent?: React.ReactNode;
}

const Feed: React.FC<FeedProps> = ({
  isLoading,
  feedRowItems,
  allPostsMap,
  userProfilesMap,
  onSetReplyingTo,
  onViewProfile,
  onLikePost,
  onDislikePost,
  currentUserState,
  myIpnsKey,
  ensurePostsAreFetched,
  footerComponent,
}) => {
  const virtuosoRef = React.useRef<VirtuosoHandle>(null);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const EmptyPlaceholder = () => (
       <p style={{ color: 'var(--text-secondary-color)', padding: '2rem', textAlign: 'center' }}>
         {'Your feed is empty. Follow users or explore to see posts!'}
       </p>
  );

  // --- FIX: Handle rendering for single, double, and triple post rows ---
  const renderItem = (_index: number, rowItem: FeedRowItem) => {

    // Case 1: Full-width row (single post ID)
    if (typeof rowItem === 'string') {
        const postId = rowItem;
        if (!allPostsMap.has(postId)) return null;
        return (
          // Apply padding directly here, removing the outer div
          <div style={{ paddingBottom: '1rem', paddingTop: '1rem' }}>
            <PostComponent
              postId={postId}
              allPostsMap={allPostsMap}
              userProfilesMap={userProfilesMap}
              onSetReplyingTo={onSetReplyingTo}
              onViewProfile={onViewProfile}
              onLikePost={onLikePost}
              onDislikePost={onDislikePost}
              currentUserState={currentUserState}
              myIpnsKey={myIpnsKey}
              ensurePostsAreFetched={ensurePostsAreFetched}
            />
          </div>
        );
    }

    // Case 2: Multi-column row (array of post IDs)
    if (Array.isArray(rowItem)) {
        const postIds = rowItem;
        // Determine class based on number of posts in the row
        const rowClass = postIds.length === 3 ? 'feed-row-three-column' :
                         postIds.length === 2 ? 'feed-row-two-column' :
                         ''; // Default or handle single item array if needed

        return (
            <div className={`feed-row-item ${rowClass}`} style={{ paddingBottom: '1rem', paddingTop: '1rem' }}>
                {postIds.map(postId => {
                    if (!allPostsMap.has(postId)) return null;
                    return (
                        <div key={postId} className="feed-column-item">
                            <PostComponent
                                postId={postId}
                                allPostsMap={allPostsMap}
                                userProfilesMap={userProfilesMap}
                                onSetReplyingTo={onSetReplyingTo}
                                onViewProfile={onViewProfile}
                                onLikePost={onLikePost}
                                onDislikePost={onDislikePost}
                                currentUserState={currentUserState}
                                myIpnsKey={myIpnsKey}
                                ensurePostsAreFetched={ensurePostsAreFetched}
                            />
                        </div>
                    );
                })}
            </div>
        );
    }

    return null; // Fallback for invalid row items
  };
  // --- End Fix ---


  return (
       <div className="feed-container">
         <Virtuoso
            ref={virtuosoRef}
            useWindowScroll
            data={feedRowItems}
            itemContent={renderItem}
            components={{
              Footer: footerComponent ? () => <>{footerComponent}</> : undefined,
              EmptyPlaceholder: feedRowItems.length === 0 ? EmptyPlaceholder : undefined,
            }}
          />
        </div>
  );
};

export default Feed;