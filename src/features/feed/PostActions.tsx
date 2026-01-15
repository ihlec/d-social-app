// fileName: src/features/feed/PostActions.tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Post, UserState } from '../../types';
import { LikeIcon, DislikeIcon, ReplyIcon, ShareIcon } from '../../components/Icons';
import { getShareBaseUrl } from '../../lib/utils';
import toast from 'react-hot-toast';

interface PostActionsProps {
  post: Post;
  currentUserState: UserState | null;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  onReplyClick: () => void;
  totalReplyCount?: number; 
}

const PostActions: React.FC<PostActionsProps> = ({
  post,
  currentUserState,
  onLikePost,
  onDislikePost,
  onReplyClick,
  totalReplyCount = 0, 
}) => {
  const navigate = useNavigate();
  const isTemporaryPost = post.id.startsWith('temp-');
  
  const isLiked = currentUserState?.likedPostCIDs?.includes(post.id);
  const isDisliked = currentUserState?.dislikedPostCIDs?.includes(post.id);

  // Helper to enforce login on interaction
  const requireLogin = (action: () => void) => {
    if (!currentUserState) {
        toast.error("Please log in to interact", { icon: "🔒" });
        navigate('/login');
        return;
    }
    action();
  };

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    const baseUrl = getShareBaseUrl();
    const url = `${baseUrl}/#/post/${post.id}`;
    navigator.clipboard.writeText(url);
    toast.success('Link copied!');
  };

  return (
    <div className="post-footer">
      <div className="post-actions">
        {/* Like Button */}
        <button
          className={`action-button ${isLiked ? 'liked' : ''}`}
          onClick={(e) => { 
              e.stopPropagation(); 
              requireLogin(() => onLikePost?.(post.id)); 
          }}
          disabled={isTemporaryPost} // removed !currentUserState check
          title={isLiked ? "Unlike" : "Like"}
        >
          <LikeIcon />
        </button>

        {/* Dislike Button */}
        <button
          className={`action-button ${isDisliked ? 'disliked' : ''}`}
          onClick={(e) => { 
              e.stopPropagation(); 
              requireLogin(() => onDislikePost?.(post.id)); 
          }}
          disabled={isTemporaryPost} // removed !currentUserState check
          title={isDisliked ? "Remove Dislike" : "Dislike"}
        >
          <DislikeIcon />
        </button>

        {/* Reply Button */}
        <button
          className="comment-button"
          onClick={(e) => { 
              e.stopPropagation(); 
              // For replies, we generally let the navigation happen, 
              // but if we want to block the *action* of replying, we check here.
              // However, navigating to the post page is usually fine for guests.
              // But the prompt says "login only after interaction attempt".
              // Opening a post to read replies is passive. 
              // Opening the "reply form" is the interaction.
              // Since clicking this usually just opens the thread (passive), we allow it.
              // The actual form won't render for guests in PostPage.
              // If we want to force login when they INTEND to reply:
              requireLogin(() => onReplyClick());
          }}
          title="Reply"
        >
          <ReplyIcon />
          {totalReplyCount > 0 && (
            <span className="reply-count-badge">
              {totalReplyCount}
            </span>
          )}
        </button>
      </div>

      {/* Share Button (Always allowed) */}
      <button 
        className="action-button" 
        onClick={handleShare} 
        title="Share Post"
      >
        <ShareIcon />
      </button>
    </div>
  );
};

export default PostActions;