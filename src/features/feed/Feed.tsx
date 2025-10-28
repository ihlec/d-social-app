// fileName: src/features/feed/Feed.tsx
import React from 'react';
import Masonry, { ResponsiveMasonry } from "react-responsive-masonry";
import PostComponent from './PostItem'; // Assuming this path is correct now
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';

interface FeedProps {
  isLoading: boolean;
  topLevelIds: string[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onViewProfile: (key: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myIpnsKey: string;
  ensurePostsAreFetched: (postCids: string[], authorHint?: string) => Promise<void>;
}

const Feed: React.FC<FeedProps> = ({
  isLoading,
  topLevelIds,
  allPostsMap,
  userProfilesMap,
  onViewProfile,
  onLikePost,
  onDislikePost,
  currentUserState,
  myIpnsKey,
  ensurePostsAreFetched,
}) => {

  // Define breakpoints for react-responsive-masonry
  // The keys are the minimum width, the values are the number of columns
  const breakpointColumnsObj = {
    500: 1,  // 1 column for screens < 700px wide
    501: 2, // 2 columns for screens >= 700px and < 1100px wide
    770: 3, // 3 columns for screens >= 1100px and < 1400px wide
    992: 4  // 4 columns for screens >= 1400px wide (Adjust 1600 if needed)
  };

  if (isLoading && topLevelIds.length === 0) {
    return <LoadingSpinner />;
  }

  if (topLevelIds.length === 0 && !isLoading) {
    return <p style={{ marginTop: '2rem', color: 'var(--text-secondary-color)' }}>No posts to display.</p>;
  }

  return (
    <ResponsiveMasonry
        columnsCountBreakPoints={breakpointColumnsObj}
    >
      <Masonry
          gutter="10px" // Spacing between columns
      >
          {topLevelIds.map(postId => {
               const post = allPostsMap.get(postId);
               if (!post) {
                  console.warn(`[Feed] Post data not found for ID: ${postId}. Requesting fetch.`);
                  ensurePostsAreFetched([postId]);
                   // Render a temporary placeholder
                   return <div key={postId} data-post-id={postId} className="post post-placeholder"><LoadingSpinner /></div>;
               }
               return (
                  // Wrapper div for each post, includes data-post-id for scroll restoration
                  <div key={post.id} data-post-id={post.id} style={{ marginBottom: "10px" }}> {/* Vertical spacing */}
                      <PostComponent
                          postId={postId} // Pass postId explicitly
                          allPostsMap={allPostsMap}
                          userProfilesMap={userProfilesMap}
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
      </Masonry>
    </ResponsiveMasonry>
  );
};

export default Feed;