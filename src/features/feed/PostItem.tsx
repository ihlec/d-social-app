// fileName: src/features/feed/PostItem.tsx
// src/features/feed/PostItem.tsx
import React, { useEffect } from 'react';
// --- FIX: Add useLocation import ---
import { useNavigate, useLocation } from 'react-router-dom';
// --- END FIX ---
import { Post, UserProfile, UserState } from '../../types';
import PostMedia from './PostMedia';
import { formatTimestamp } from '../../lib/utils';
import { LikeIcon, DislikeIcon, ReplyIcon, ShareIcon } from '../../components/Icons';
import toast from 'react-hot-toast';

interface PostProps {
  postId: string;
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
  onSetReplyingTo?: (post: Post | null) => void;
  onViewProfile: (ipnsKey: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  currentUserState: UserState | null;
  myIpnsKey: string;
  ensurePostsAreFetched?: (postCids: string[]) => Promise<void>;
  isReply?: boolean;
  renderReplies?: boolean;
  isExpandedView?: boolean; // Keep prop to disable its own onClick
}

const PostComponent: React.FC<PostProps> = ({
  postId,
  allPostsMap,
  userProfilesMap,
  onSetReplyingTo,
  onViewProfile,
  onLikePost,
  onDislikePost,
  currentUserState,
  myIpnsKey,
  ensurePostsAreFetched,
  isReply = false,
  renderReplies = false,
  isExpandedView = false, // Default to false
}) => {
  const navigate = useNavigate();
  // --- FIX: Get location ---
  const location = useLocation();
  // --- END FIX ---
  const post = allPostsMap.get(postId);

  useEffect(() => {
    if (post?.replies && post.replies.length > 0 && ensurePostsAreFetched) {
      const missingReplyCIDs = post.replies.filter(
        (replyId) => replyId && !replyId.startsWith('temp-') && !allPostsMap.has(replyId)
      );
      if (missingReplyCIDs.length > 0) {
        ensurePostsAreFetched(missingReplyCIDs);
      }
    }
  }, [post?.id, post?.replies, allPostsMap, ensurePostsAreFetched]);


  if (!post) {
    console.warn(`Post data missing entirely for ID: ${postId}`);
    return ( <div className={`post ${isReply ? 'reply-post' : ''}`} style={{ opacity: 0.7 }}><p><em>Loading post data ({postId.substring(0,8)}...)...</em></p></div> );
  }

  if (!post.authorKey || typeof post.timestamp !== 'number') {
     console.warn(`Post data incomplete or invalid for ID: ${postId}`, post);
      return ( <div className={`post ${isReply ? 'reply-post' : ''}`} style={{ opacity: 0.7 }}><p><em>Incomplete post data ({postId.substring(0,8)}...).</em></p></div> );
  }

  const authorProfile = userProfilesMap.get(post.authorKey);
  const parentPost = post.referenceCID ? allPostsMap.get(post.referenceCID) : null;
  const parentAuthorProfile = parentPost ? userProfilesMap.get(parentPost.authorKey) : null;
  const displayAuthorName = authorProfile?.name || `Unknown (${post.authorKey.substring(0, 6)}...)`;
  const isLiked = currentUserState?.likedPostCIDs?.includes(post.id) ?? false;
  const isDisliked = currentUserState?.dislikedPostCIDs?.includes(post.id) ?? false;
  const loadedReplies = post.replies?.filter(replyId => allPostsMap.has(replyId)) ?? [];
  const loadedReplyCount = loadedReplies.length;
  const isTemporaryPost = typeof post.id === 'string' && post.id.startsWith('temp-');

  const handleInteraction = (action?: () => void) => {
    if (currentUserState) {
      if (action) action();
    } else {
      toast("Please log in to interact.", { icon: '🔒' });
      navigate('/login');
    }
  };

  const handleShare = () => {
    if (typeof post.id === 'string' && !isTemporaryPost) {
        // --- FIX: Change the shared URL format ---
        // New URL points to the author's profile with a query param
        const postUrl = `${window.location.origin}${window.location.pathname}#/profile/${post.authorKey}?modal_post=${post.id}`;
        // --- END FIX ---
        navigator.clipboard.writeText(postUrl).then(() => toast.success("Post link copied!")).catch(() => toast.error("Failed to copy link."));
    } else {
         toast.error("Cannot share this post (invalid ID).");
    }
  };
  const handleReplyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleInteraction(() => {
        if (onSetReplyingTo) { onSetReplyingTo(post); }
    });
  }

  // --- FIX: Revert to using navigate with backgroundLocation state ---
  const handleNavigateToPost = (e: React.MouseEvent) => {
      // Prevent click action if clicking on buttons/links
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement || (e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('a')) { return; }

      if (typeof post.id === 'string' && !isTemporaryPost) {
          // Navigate to post page, passing current location as background
          navigate(`/post/${post.id}`, {
            state: { backgroundLocation: location }
          });
      }
  }
  // --- END FIX ---

  return (
    <div
      className={`post ${isReply ? 'reply-post' : ''}`}
      // Disable onClick if it's the expanded view to prevent re-triggering
      onClick={isExpandedView ? undefined : handleNavigateToPost}
      style={{ cursor: isTemporaryPost || isExpandedView ? 'default' : 'pointer' }}
    >

       {parentPost && (
           <div className="reply-context" style={{ fontSize: '0.85em', color: 'var(--text-secondary-color)', marginBottom: '0.5rem' }}>
               Replying to{' '}
               <button onClick={(e) => { e.stopPropagation(); onViewProfile(parentPost.authorKey); }} className="author-name-button" style={{ fontSize: 'inherit', display: 'inline' }} title={parentPost.authorKey}>
                    <strong>@{parentAuthorProfile?.name || `Unknown (${parentPost.authorKey.substring(0,6)}...)`}</strong>
               </button>
           </div>
       )}

      <div className="post-header">
         <button onClick={(e) => { e.stopPropagation(); onViewProfile(post.authorKey); }} className="author-name-button" title={post.authorKey}><strong>{displayAuthorName}</strong></button>
      </div>

      {post.content && <p>{post.content}</p>}

      {/* Disable media onClick if it's the expanded view */}
      <div onClick={isExpandedView ? undefined : handleNavigateToPost}>
        {/* Pass isExpandedView to PostMedia */}
        <PostMedia post={post} isExpandedView={isExpandedView} />
      </div>

      <div className="post-footer">
         <small title={new Date(post.timestamp).toString()} >{formatTimestamp(post.timestamp)}</small>
        <div className="post-actions" onClick={(e) => e.stopPropagation()}>
          <button
              onClick={(e) => { e.stopPropagation(); handleInteraction(onLikePost ? () => onLikePost(post.id) : undefined); }}
              className={`action-button ${isLiked ? 'liked' : ''}`}
              title="Like"
              disabled={isTemporaryPost}
           > <LikeIcon /> </button>

          <button
              onClick={(e) => { e.stopPropagation(); handleInteraction(onDislikePost ? () => onDislikePost(post.id) : undefined); }}
              className={`action-button ${isDisliked ? 'disliked' : ''}`}
              title="Dislike"
              disabled={isTemporaryPost}
           > <DislikeIcon /> </button>

           <button
              className="comment-button"
              onClick={handleReplyClick}
              title="Reply"
          >
              <ReplyIcon />
              {loadedReplyCount > 0 && (
                  <span style={{ fontSize: '0.8em', marginLeft: '4px', color: 'var(--text-secondary-color)' }}>
                      {loadedReplyCount}
                  </span>
              )}
            </button>
          <button className="action-button" onClick={handleShare} title="Share Post"> <ShareIcon /> </button>
        </div>
      </div>

      {/* Conditionally render replies based on prop */}
      {renderReplies && loadedReplies.length > 0 && (
        <div className="replies-container">
          {loadedReplies.map((replyId) => (
            <PostComponent
              key={replyId}
              postId={replyId}
              allPostsMap={allPostsMap}
              userProfilesMap={userProfilesMap}
              onSetReplyingTo={onSetReplyingTo}
              onViewProfile={onViewProfile}
              onLikePost={onLikePost}
              onDislikePost={onDislikePost}
              currentUserState={currentUserState}
              myIpnsKey={myIpnsKey}
              ensurePostsAreFetched={ensurePostsAreFetched}
              renderReplies={renderReplies} // Pass down
              isExpandedView={isExpandedView} // Pass down
              isReply={true}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default PostComponent;