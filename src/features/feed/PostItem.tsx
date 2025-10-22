// src/features/feed/PostItem.tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Post, UserProfile, UserState } from '../../types';
import PostMedia from './PostMedia';
import { formatTimestamp } from '../../lib/utils';
// --- FIX: Restore imports ---
import { LikeIcon, DislikeIcon, ReplyIcon, ShareIcon } from '../../components/Icons';
// --- End Fix ---
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
  // --- FIX: Removed onFollowPostAuthor ---
  // onFollowPostAuthor?: (ipnsKey: string) => void;
  // --- End Fix ---
  isReply?: boolean;
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
  // --- FIX: Removed onFollowPostAuthor ---
  // onFollowPostAuthor,
  // --- End Fix ---
  isReply = false,
}) => {
  const navigate = useNavigate();
  const post = allPostsMap.get(postId);

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
  // --- FIX: parentAuthorProfile is used ---
  const parentAuthorProfile = parentPost ? userProfilesMap.get(parentPost.authorKey) : null;
  // --- End Fix ---
  const displayAuthorName = authorProfile?.name || `Unknown (${post.authorKey.substring(0, 6)}...)`;
  const isLiked = currentUserState?.likedPostCIDs?.includes(post.id) ?? false;
  const isDisliked = currentUserState?.dislikedPostCIDs?.includes(post.id) ?? false;
  // --- FIX: Removed follow logic ---
  // const isMyPost = post.authorKey === myIpnsKey;
  // const isFollowingAuthor = currentUserState?.follows?.some(f => f.ipnsKey === post.authorKey) ?? false;
  // const canFollow = onFollowPostAuthor && !isMyPost;
  // --- End Fix ---
  const loadedReplies = post.replies?.filter(replyId => allPostsMap.has(replyId)) ?? [];
  // --- FIX: loadedReplyCount is used ---
  const loadedReplyCount = loadedReplies.length;
  // --- End Fix ---
  const isTemporaryPost = typeof post.id === 'string' && post.id.startsWith('temp-');

  // --- FIX: Generic handler for all interactions ---
  const handleInteraction = (action?: () => void) => {
    // Stop propagation so the click doesn't bubble to the post navigation.
    // e.stopPropagation(); // This must be done in the onClick lambda

    if (currentUserState) {
      // User is logged in, perform the action
      if (action) action();
    } else {
      // User is logged out, prompt to log in
      toast("Please log in to interact.", { icon: '🔒' });
      navigate('/login');
    }
  };
  // --- End Fix ---

  const handleShare = () => {
    if (typeof post.id === 'string' && !isTemporaryPost) {
        const postUrl = `${window.location.origin}${window.location.pathname}#/post/${post.id}`;
        navigator.clipboard.writeText(postUrl).then(() => toast.success("Post link copied!")).catch(() => toast.error("Failed to copy link."));
    } else {
         toast.error("Cannot share this post (invalid ID).");
    }
  };
  // --- FIX: handleReplyClick now uses interaction guard ---
  const handleReplyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleInteraction(() => {
        if (onSetReplyingTo) { onSetReplyingTo(post); }
    });
  }
  // --- End Fix ---
  const handleNavigateToPost = (e: React.MouseEvent) => {
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement || (e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('a')) { return; }
      if (typeof post.id === 'string' && !isTemporaryPost) {
          navigate(`/post/${post.id}`);
      }
  }

  return (
    <div className={`post ${isReply ? 'reply-post' : ''}`} onClick={handleNavigateToPost} style={{ cursor: isTemporaryPost ? 'default' : 'pointer' }}>

       {parentPost && (
           <div className="reply-context" style={{ fontSize: '0.85em', color: 'var(--text-secondary-color)', marginBottom: '0.5rem' }}>
               Replying to{' '}
               {/* --- FIX: Corrected syntax and usage of parentAuthorProfile --- */}
               <button onClick={(e) => { e.stopPropagation(); onViewProfile(parentPost.authorKey); }} className="author-name-button" style={{ fontSize: 'inherit', display: 'inline' }} title={parentPost.authorKey}>
                    <strong>@{parentAuthorProfile?.name || `Unknown (${parentPost.authorKey.substring(0,6)}...)`}</strong>
               </button>
               {/* --- End Fix --- */}
           </div>
       )}

      <div className="post-header">
         <button onClick={(e) => { e.stopPropagation(); onViewProfile(post.authorKey); }} className="author-name-button" title={post.authorKey}><strong>{displayAuthorName}</strong></button>
         {/* --- FIX: Removed Follow Button --- */}
         {/* {canFollow && !isFollowingAuthor && (...)} */}
         {/* --- End Fix --- */}
      </div>

      {post.content && <p>{post.content}</p>}

      <div onClick={(e) => e.stopPropagation()}><PostMedia post={post} /></div>

      <div className="post-footer">
         <small title={new Date(post.timestamp).toString()} >{formatTimestamp(post.timestamp)}</small>
        <div className="post-actions" onClick={(e) => e.stopPropagation()}>
          {/* --- FIX: Updated Like Button --- */}
          <button
              onClick={(e) => { e.stopPropagation(); handleInteraction(onLikePost ? () => onLikePost(post.id) : undefined); }}
              className={`action-button ${isLiked ? 'liked' : ''}`}
              title="Like"
              disabled={isTemporaryPost}
           > <LikeIcon /> </button>
          {/* --- End Fix --- */}
          
          {/* --- FIX: Updated Dislike Button --- */}
          <button
              onClick={(e) => { e.stopPropagation(); handleInteraction(onDislikePost ? () => onDislikePost(post.id) : undefined); }}
              className={`action-button ${isDisliked ? 'disliked' : ''}`}
              title="Dislike"
              disabled={isTemporaryPost}
           > <DislikeIcon /> </button>
          {/* --- End Fix --- */}

          {/* --- FIX: Corrected Reply button usage --- */}
           <button
              className="comment-button"
              onClick={handleReplyClick} // Use the new handler
              title="Reply"
              // Button is no longer disabled when logged out
          >
              <ReplyIcon /> {/* Use the icon */}
              {loadedReplyCount > 0 && ( // Use the count
                  <span style={{ fontSize: '0.8em', marginLeft: '4px', color: 'var(--text-secondary-color)' }}>
                      {loadedReplyCount}
                  </span>
              )}
            </button>
          {/* --- End Fix --- */}
          <button className="action-button" onClick={handleShare} title="Share Post"> <ShareIcon /> </button>
        </div>
      </div>

      {loadedReplies.length > 0 && (
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
              // --- FIX: Removed onFollowPostAuthor ---
              // onFollowPostAuthor={onFollowPostAuthor}
              // --- End Fix ---
              isReply={true}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default PostComponent;