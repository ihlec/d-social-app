// fileName: src/features/feed/Feed.tsx
import React from 'react';
import Masonry, { ResponsiveMasonry } from 'react-responsive-masonry';
import PostComponent from './PostItem';
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';


interface FeedProps {
  isLoading: boolean;
  topLevelPostIds: string[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
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
  topLevelPostIds,
  allPostsMap,
  userProfilesMap,
  onViewProfile,
  onLikePost,
  onDislikePost,
  currentUserState,
  myIpnsKey,
  ensurePostsAreFetched,
  footerComponent,
}) => {

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const EmptyPlaceholder = () => (
       <p style={{ color: 'var(--text-secondary-color)', padding: '2rem', textAlign: 'center' }}>
         {'Your feed is empty. Follow users or explore to see posts!'}
       </p>
  );

  return (
       <div className="feed-container">
         {topLevelPostIds.length === 0 && !isLoading && <EmptyPlaceholder />}

         <ResponsiveMasonry
            // This aligns with the 1100px max-width of the #root container
            columnsCountBreakPoints={{ 350: 1, 750: 2, 1100: 3 }}
         >
            <Masonry gutter="1rem">
                {topLevelPostIds.map(postId => (
                     <PostComponent
                        key={postId}
                        postId={postId}
                        allPostsMap={allPostsMap}
                        userProfilesMap={userProfilesMap}
                        onViewProfile={onViewProfile}
                        onLikePost={onLikePost}
                        onDislikePost={onDislikePost}
                        currentUserState={currentUserState}
                        myIpnsKey={myIpnsKey}
                        ensurePostsAreFetched={ensurePostsAreFetched}
                        // --- FIX: Explicitly set isExpandedView to false ---
                        isExpandedView={false}
                        // --- END FIX ---
                    />
                ))}
            </Masonry>
         </ResponsiveMasonry>

         {/* Render the footer component (for intersection observer) outside the masonry layout */}
         {footerComponent && footerComponent}
        </div>
  );
};

export default Feed;