import React from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import PostComponent from './PostItem';
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';

interface FeedProps {
  isLoading: boolean;
  topLevelPostIds: string[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onSetReplyingTo?: (post: Post | null) => void;
  onViewProfile: (ipnsKey: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myIpnsKey: string;
  onFollowPostAuthor?: (ipnsKey: string) => void;
  footerComponent?: React.ReactNode;
}

const Feed: React.FC<FeedProps> = ({
  isLoading,
  topLevelPostIds,
  allPostsMap,
  userProfilesMap,
  onSetReplyingTo,
  onViewProfile,
  onLikePost,
  onDislikePost,
  currentUserState,
  myIpnsKey,
  onFollowPostAuthor,
  footerComponent,
}) => {
  const virtuosoRef = React.useRef<VirtuosoHandle>(null);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const renderItem = (_index: number, postId: string) => {
    if (!allPostsMap.has(postId)) return null;

    return (
      <div style={{ paddingBottom: '1rem' }}>
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
          onFollowPostAuthor={onFollowPostAuthor}
        />
      </div>
    );
  };

  const EmptyPlaceholder = () => (
       <p style={{ color: 'var(--text-secondary-color)', padding: '2rem', textAlign: 'center' }}>
         {'Your feed is empty. Follow users or explore to see posts!'}
       </p>
  );

  return (
       <div className="feed-container" style={{ flexGrow: 1, minHeight: 0 }}>
         <Virtuoso
            ref={virtuosoRef}
            useWindowScroll // 
            style={{ height: '100%' }}
            data={topLevelPostIds}
            itemContent={renderItem}
            components={{
              Footer: footerComponent ? () => <>{footerComponent}</> : undefined,
              // Virtuoso rerender
              EmptyPlaceholder: topLevelPostIds.length === 0 ? EmptyPlaceholder : undefined,
            }}
          />
        </div>
  );
};

export default Feed;