// fileName: src/features/feed/Feed.tsx
import React from 'react';
import Masonry, { ResponsiveMasonry } from 'react-responsive-masonry';
import PostComponent from './PostItem';
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';


interface FeedProps {
  isLoading: boolean;
  topLevelIds: string[];
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onViewProfile: (ipnsKey: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myIpnsKey: string;
  // --- START MODIFICATION: Update signature ---
  ensurePostsAreFetched?: (postCids: string[], authorHint?: string) => Promise<void>;
  // --- END MODIFICATION ---
  footerComponent?: React.ReactNode;
}

const Feed: React.FC<FeedProps> = ({
  isLoading,
  topLevelIds = [], // Default added previously
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
    console.log(`[Feed Render] Rendering Feed. isLoading: ${isLoading}, Posts to render: ${topLevelIds.length}`);

  if (isLoading) {
    console.log("[Feed Render] Rendering LoadingSpinner.");
    return <LoadingSpinner />;
  }

  const EmptyPlaceholder = () => (
       <p style={{ color: 'var(--text-secondary-color)', padding: '2rem', textAlign: 'center' }}>
         {'Your feed is empty. Follow users or explore to see posts!'}
       </p>
  );

  return (
       <div className="feed-container">
         {topLevelIds.length === 0 && !isLoading && <EmptyPlaceholder />}

         <ResponsiveMasonry
            columnsCountBreakPoints={{ 350: 1, 750: 2, 1100: 3 }}
         >
            <Masonry gutter="1rem">
                {topLevelIds.map(postId => {
                    console.log(`[Feed Render] Rendering PostItem for ID: ${postId.substring(0,10)}...`);
                    return (
                     // --- START MODIFICATION: Pass all required props ---
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
                        isExpandedView={false} // Keep explicitly false for feed view
                        // No need to pass isReply or renderReplies from here
                     />
                     // --- END MODIFICATION ---
                    );
                })}
            </Masonry>
         </ResponsiveMasonry>

         {footerComponent && footerComponent}
        </div>
  );
};

export default Feed;