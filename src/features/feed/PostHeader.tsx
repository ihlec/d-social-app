// fileName: src/features/feed/PostHeader.tsx
import React from 'react';
import { Post, UserProfile } from '../../types';
import { formatTimeAgo, sanitizeText } from '../../lib/utils';

interface PostHeaderProps {
  post: Post;
  authorProfile?: UserProfile;
  isOverlay?: boolean;
  onViewProfile: (ipnsKey: string) => void;
  allPostsMap: Map<string, Post>;
  userProfilesMap: Map<string, UserProfile>;
}

const PostHeader: React.FC<PostHeaderProps> = ({
  post,
  authorProfile,
  isOverlay = false,
  onViewProfile,
  allPostsMap,
  userProfilesMap
}) => {
  
  const getReplyingToName = () => {
      if (!post.referenceCID) return null;
      const parentPost = allPostsMap.get(post.referenceCID);
      if (parentPost) {
          const parentProfile = userProfilesMap.get(parentPost.authorKey);
          return sanitizeText(parentProfile?.name) || parentPost.authorKey.substring(0, 8);
      }
      return "Deleted Post";
  };

  const replyingToName = getReplyingToName();

  // FIX: Robust Fallback for Name Display
  // If authorProfile.name exists and is not empty, use it.
  // Otherwise, use truncated IPNS key (e.g., k51qzi...1234)
  const displayName = authorProfile && authorProfile.name && authorProfile.name.trim().length > 0
      ? sanitizeText(authorProfile.name)
      : (post.authorKey.length > 12 
          ? `${post.authorKey.substring(0, 6)}...${post.authorKey.substring(post.authorKey.length - 4)}` 
          : post.authorKey);

  return (
    <div className="post-header" style={{ color: isOverlay ? 'white' : 'inherit' }}>
      <div className="post-header-top">
          {/* Left Group: Author Name + Reply Tag */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', overflow: 'hidden' }}>
              <button 
                onClick={(e) => {
                    e.stopPropagation();
                    onViewProfile(post.authorKey);
                }}
                className="author-name-button"
                style={{ 
                    color: isOverlay ? 'white' : 'inherit', 
                    pointerEvents: 'auto' 
                }}
                title={post.authorKey} /* Tooltip showing full key */
              >
                {displayName}
              </button>

              {replyingToName && (
                  <span style={{ 
                      fontSize: '0.8rem', 
                      opacity: 0.7, 
                      whiteSpace: 'nowrap', 
                      overflow: 'hidden', 
                      textOverflow: 'ellipsis' 
                  }}>
                      to {replyingToName}
                  </span>
              )}
          </div>

          {/* Right Group: Timestamp */}
          <div className="post-timestamp" style={{ color: isOverlay ? 'rgba(255,255,255,0.8)' : undefined }}>
            {formatTimeAgo(post.timestamp)}
          </div>
      </div>
    </div>
  );
};

export default PostHeader;