import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Post, UserState } from '../../types';
import { LikeIcon, DislikeIcon, ReplyIcon, ShareIcon, SaveIcon } from '../../components/Icons';
import { getShareBaseUrl, isPeerId } from '../../lib/utils';
import toast from 'react-hot-toast';

interface PostActionsProps {
  post: Post;
  currentUserState: UserState | null;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  onSavePost?: (postId: string) => void;
  onReplyClick: () => void;
  totalReplyCount?: number; 
}

const PostActions: React.FC<PostActionsProps> = ({
  post,
  currentUserState,
  onLikePost,
  onDislikePost,
  onSavePost,
  onReplyClick,
  totalReplyCount = 0, 
}) => {
  const navigate = useNavigate();
  const isTemporaryPost = post.id.startsWith('temp-');
  
  const isLiked = currentUserState?.likedPostCIDs?.includes(post.id);
  const isDisliked = currentUserState?.dislikedPostCIDs?.includes(post.id);
  const isOwnPost = !!currentUserState?.postCIDs?.includes(post.id);
  const isSaved = currentUserState?.savedPostCIDs?.includes(post.id);
  const hasMedia = !!(post.mediaCid || post.thumbnailCid);

  const requireLogin = (action: () => void) => {
    if (!currentUserState) {
        toast.error('Please log in to interact');
        navigate('/login');
        return;
    }
    action();
  };

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    const baseUrl = getShareBaseUrl();
    const author = (post.authorKey || '').trim();
    const authorQ = isPeerId(author) ? `?a=${encodeURIComponent(author)}` : '';
    const url = `${baseUrl}/#/post/${post.id}${authorQ}`;
    navigator.clipboard.writeText(url);
    toast.success('Link copied!');
  };

  return (
    <div className="post-footer">
      <div className="post-actions">
        <button
          className={`action-button ${isLiked ? 'liked' : ''}`}
          onClick={(e) => { 
              e.stopPropagation(); 
              requireLogin(() => onLikePost?.(post.id)); 
          }}
          disabled={isTemporaryPost}
          title={isLiked ? "Unlike (stops serving)" : "Like (pins & serves post + media)"}
          data-testid="like-button"
        >
          <LikeIcon />
        </button>

        <button
          className={`action-button ${isDisliked ? 'disliked' : ''}`}
          onClick={(e) => { 
              e.stopPropagation(); 
              requireLogin(() => onDislikePost?.(post.id)); 
          }}
          disabled={isTemporaryPost}
          title={
            isOwnPost
              ? 'Remove from your posts'
              : isDisliked
                ? 'Remove Dislike'
                : 'Dislike'
          }
        >
          <DislikeIcon />
        </button>

        {hasMedia && (
          <button
            className={`action-button ${isSaved ? 'saved' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              requireLogin(() => onSavePost?.(post.id));
            }}
            disabled={isTemporaryPost}
            title={isSaved ? 'Unsave bookmark' : 'Save bookmark (pins full file)'}
            data-testid="save-button"
          >
            <SaveIcon />
          </button>
        )}

        <button
          className="comment-button"
          onClick={(e) => { 
              e.stopPropagation(); 
              requireLogin(() => onReplyClick());
          }}
          title="Reply"
          data-testid="reply-button"
        >
          <ReplyIcon />
          {totalReplyCount > 0 && (
            <span className="reply-count-badge">
              {totalReplyCount}
            </span>
          )}
        </button>
      </div>

      <button
        type="button"
        className="action-button share-action-button"
        onClick={handleShare}
        title="Share Post"
      >
        <ShareIcon />
      </button>
    </div>
  );
};

export default PostActions;
