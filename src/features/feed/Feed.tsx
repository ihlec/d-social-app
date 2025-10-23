// fileName: src/features/feed/Feed.tsx
import React from 'react';
// --- FIX: Import Masonry components ---
import Masonry, { ResponsiveMasonry } from 'react-responsive-masonry';
// --- END FIX ---
import PostComponent from './PostItem';
import LoadingSpinner from '../../components/LoadingSpinner';
import { Post, UserProfile, UserState } from '../../types';

// --- FIX: This type is no longer needed ---
// type FeedRowItem = string | string[];
// --- END FIX ---


interface FeedProps {
  isLoading: boolean;
  // --- FIX: Prop changed from feedRowItems to topLevelPostIds ---
  topLevelPostIds: string[];
  // --- END FIX ---
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
  // --- FIX: Prop changed ---
  topLevelPostIds,
  // --- END FIX ---
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
  // --- FIX: Virtuoso ref removed ---
  // const virtuosoRef = React.useRef<VirtuosoHandle>(null);
  // --- END FIX ---

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const EmptyPlaceholder = () => (
       <p style={{ color: 'var(--text-secondary-color)', padding: '2rem', textAlign: 'center' }}>
         {'Your feed is empty. Follow users or explore to see posts!'}
       </p>
  );

  // --- FIX: Remove Virtuoso renderItem logic ---
  // --- END FIX ---

  return (
       <div className="feed-container">
         {/* --- FIX: Replace Virtuoso with Masonry --- */}
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
                        onSetReplyingTo={onSetReplyingTo}
                        onViewProfile={onViewProfile}
                        onLikePost={onLikePost}
                        onDislikePost={onDislikePost}
                        currentUserState={currentUserState}
                        myIpnsKey={myIpnsKey}
                        ensurePostsAreFetched={ensurePostsAreFetched}
                    />
                ))}
            </Masonry>
         </ResponsiveMasonry>

         {/* Render the footer component (for intersection observer) outside the masonry layout */}
         {footerComponent && footerComponent}
         {/* --- END FIX --- */}
        </div>
  );
};

export default Feed;