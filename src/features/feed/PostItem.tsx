// fileName: src/features/feed/PostItem.tsx
import React, { useMemo, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Post, UserProfile, UserState } from '../../types';
import PostMedia from './PostMedia';
import PostHeader from './PostHeader';
import PostActions from './PostActions';
import { useAppContext } from '../../state/AppContext';
import { useGatewayRace } from '../../hooks/useGatewayRace';
import { sanitizeText } from '../../lib/utils';
import './PostItem.css';

interface PostProps {
  postId: string;
  allPostsMap: Map<string, Post>;
  userProfilesMap?: Map<string, UserProfile>; 
  onSetReplyingTo?: (post: Post | null) => void;
  onViewProfile: (ipnsKey: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  onFetchUser?: (ipnsKey: string) => void;
  currentUserState: UserState | null;
  myPeerId: string;
  ensurePostsAreFetched?: (postCids: string[], authorHint?: string) => Promise<void>;
  isReply?: boolean;
  renderReplies?: boolean;
  isExpandedView?: boolean;
  depth?: number;
  contextIds?: string[]; // Legacy / Direct pass
  getContextIds?: () => string[]; // Stable Accessor
}

const findRootPost = (startPost: Post, map: Map<string, Post>): Post => {
    let current = startPost;
    const visited = new Set<string>([current.id]);

    while (current.referenceCID && map.has(current.referenceCID)) {
        const parent = map.get(current.referenceCID);
        if (!parent || visited.has(parent.id)) break; 
        
        visited.add(parent.id);
        current = parent;
    }
    return current;
};

const PostComponent: React.FC<PostProps> = ({
  postId,
  allPostsMap,
  userProfilesMap: propProfilesMap,
  onSetReplyingTo,
  onViewProfile,
  onLikePost,
  onDislikePost,
  onFetchUser: propFetchUser,
  currentUserState,
  myPeerId,
  ensurePostsAreFetched,
  isReply = false,
  renderReplies = false,
  isExpandedView = false,
  depth = 0, 
  contextIds,
  getContextIds
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  
  const { userProfilesMap: contextProfiles, fetchUser: contextFetchUser, getReplyCount } = useAppContext();
  
  // --- FIX: Priority Inversion ---
  // Props must take precedence because PostPage passes a "Combined Map" (Global + Thread Local)
  // which contains profiles that are NOT yet in the Global Context.
  const profilesMap = propProfilesMap || contextProfiles;
  const fetchUser = propFetchUser || contextFetchUser;
  // -------------------------------

  const post = allPostsMap.get(postId);
  
  // Instant Profile Resolution
  const isMine = post?.authorKey === myPeerId;
  let authorProfile = post && profilesMap ? profilesMap.get(post.authorKey) : undefined;
  
  if (isMine && currentUserState?.profile) {
      authorProfile = currentUserState.profile;
  }

  const isDisliked = useMemo(() => {
      return currentUserState?.dislikedPostCIDs?.includes(postId) || false;
  }, [currentUserState?.dislikedPostCIDs, postId]);

  const isBlocked = useMemo(() => {
      return post && currentUserState?.blockedUsers?.includes(post.authorKey) || false;
  }, [currentUserState?.blockedUsers, post]);

  const isProfileValid = (profile?: UserProfile) => {
      return profile && profile.name && profile.name.trim().length > 0;
  };

  useEffect(() => {
      if (!post || !fetchUser || !profilesMap) return;

      if (!isMine) {
          const currentProfile = profilesMap.get(post.authorKey);
          if (!isProfileValid(currentProfile)) {
              fetchUser(post.authorKey);
          }
      }

      if (post.referenceCID) {
          const parentPost = allPostsMap.get(post.referenceCID);
          if (parentPost) {
              const parentProfile = profilesMap.get(parentPost.authorKey);
              if (!isProfileValid(parentProfile)) {
                  fetchUser(parentPost.authorKey);
              }
          }
      }
  }, [post, profilesMap, fetchUser, allPostsMap, isMine]);
  
  const totalReplyCount = useMemo(() => {
       if (!post || !getReplyCount) return 0;
       return getReplyCount(postId);
  }, [postId, getReplyCount, post]);

  // Hook Order Fix: Always run this hook
  const loadedReplies = useMemo(() => {
      if (!post) return [];
      
      const staticReplies = post.replies || [];
      const dynamicReplies = [];
      if (renderReplies) {
          for (const p of allPostsMap.values()) {
              if (p.referenceCID === postId && !staticReplies.includes(p.id)) {
                  dynamicReplies.push(p.id);
              }
          }
      }
      const combined = [...staticReplies, ...dynamicReplies];
      return combined.filter(rId => allPostsMap.has(rId));
  }, [post, allPostsMap, renderReplies, postId]);

  if (!post) return null;

  const handlePostClick = () => {
    if (window.getSelection()?.toString().length) return;
    if (isExpandedView) return; 
    
    const rootPost = findRootPost(post, allPostsMap);

    // FIX: If we are already in a modal (backgroundLocation exists), 
    // we should REPLACE the current entry to avoid stacking modals on top of each other.
    // NOTE: location.state might be null in some edge cases (e.g. deep linking), 
    // but usually backgroundLocation implies we are in a modal.
    const backgroundLocation = location.state?.backgroundLocation;
    const isModal = !!backgroundLocation;

    // Resolve context: Prefer dynamic getter, fallback to prop
    const finalContextIds = getContextIds ? getContextIds() : contextIds;

    navigate(`/post/${rootPost.id}`, { 
        replace: isModal,
        state: { 
            // Reuse the EXISTING background location to keep the stack flat.
            // If we use 'location' when isModal is true, we nest the previous modal state 
            // into the new state, creating a recursive stack!
            backgroundLocation: backgroundLocation || location,
            scrollToId: post.id,
            contextIds: finalContextIds 
        } 
    });
  };

  const handleReplyClick = () => {
      if (onSetReplyingTo) {
          onSetReplyingTo(post);
      } else {
          navigate(`/post/${post.id}`, { 
              state: { 
                  backgroundLocation: location, 
                  autoReply: true 
              } 
          });
      }
  };
  
  const isMediaPost = !!post.mediaCid && (post.mediaType === 'image' || post.mediaType === 'video');
  const isShortText = post.content.length < 100;
  const useOverlayStyle = !isExpandedView && isMediaPost && isShortText && !isDisliked;

  // Race the PDF/File URL as well
  const { bestUrl: attachmentUrl } = useGatewayRace(post.mediaCid);

  return (
    <div 
        className={`post ${isReply ? 'reply-post' : ''} post-wrapper ${isExpandedView ? 'not-clickable' : 'clickable'} ${(isReply && depth > 0) ? 'reply-indent' : ''}`} 
        onClick={handlePostClick} 
        id={`post-${postId}`} 
    >
       {isBlocked ? (
           <div className="post-disliked-opacity">
               <div className="post-disliked-banner">
                   <span>🚫 You blocked this user. Content hidden.</span>
               </div>
           </div>
       ) : isDisliked ? (
           <div className="post-disliked-opacity">
               <PostHeader 
                    post={post} 
                    authorProfile={authorProfile} 
                    isOverlay={false} 
                    onViewProfile={onViewProfile} 
                    allPostsMap={allPostsMap} 
                    userProfilesMap={profilesMap || new Map()} 
               />
                   <div className="post-disliked-banner">
                       <span>🚫 You disliked this post. Content hidden.</span>
                   </div>
               </div>
           ) : (
               useOverlayStyle ? (
             <div className="post-overlay-container">
                 <PostMedia post={post} isExpandedView={false} />
                 <div className="post-overlay-gradient">
                     <PostHeader 
                        post={post} 
                        authorProfile={authorProfile} 
                        isOverlay={true} 
                        onViewProfile={onViewProfile} 
                        allPostsMap={allPostsMap} 
                        userProfilesMap={profilesMap || new Map()} 
                     />
                     <div className="post-content post-overlay-content">
                         {sanitizeText(post.content)}
                     </div>
                 </div>
             </div>
           ) : (
             <>
                <PostHeader 
                    post={post} 
                    authorProfile={authorProfile} 
                    isOverlay={false} 
                    onViewProfile={onViewProfile} 
                    allPostsMap={allPostsMap} 
                    userProfilesMap={profilesMap || new Map()} 
                />
                <div className={`post-content ${isExpandedView ? 'post-content-expanded' : ''}`}>
                    {sanitizeText(post.content)}
                </div>
                {post.mediaCid && (
                    <PostMedia post={post} isExpandedView={isExpandedView} />
                )}
             </>
           )
       )}

      {!isDisliked && post.mediaCid && post.mediaType === 'file' && (
         <>
             {post.fileName?.toLowerCase().endsWith('.pdf') ? (
                 isExpandedView ? (
                     <div onClick={(e) => e.stopPropagation()}>
                         <iframe 
                            src={attachmentUrl ? `${attachmentUrl}#view=FitH` : ''} 
                            className="pdf-preview-frame"
                            title="PDF Preview"
                         />
                     </div>
                 ) : (
                     <div className="pdf-card-preview">
                         <div className="pdf-icon">📄</div>
                         <div className="pdf-info">
                             <div className="pdf-name">
                                 {sanitizeText(post.fileName) || 'PDF Document'}
                             </div>
                             <div className="pdf-meta">
                                 PDF Document • Click to view
                             </div>
                         </div>
                     </div>
                 )
             ) : (
                <div className="post-file-container" onClick={(e) => e.stopPropagation()}>
                    <a 
                        href={attachmentUrl || ''} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="file-download-link" 
                        onClick={(e) => e.stopPropagation()} 
                    >
                       <span>Download File: {sanitizeText(post.fileName) || 'Attachment'}</span>
                    </a>
                </div>
             )}
         </>
      )}

      <div onClick={() => {}}>
          <PostActions 
             post={post}
             currentUserState={currentUserState}
             onLikePost={onLikePost}
             onDislikePost={onDislikePost}
             onReplyClick={handleReplyClick}
             totalReplyCount={totalReplyCount}
          />
      </div>

      {renderReplies && loadedReplies.length > 0 && (
        <div 
            className="replies-container" 
            onClick={(e) => e.stopPropagation()} 
        >
          {loadedReplies.map((replyId) => {
             if (depth > 5) {
                return (
                    <div key={replyId} className="reply-continue-container">
                         <Link 
                            to={`/post/${postId}`} 
                            onClick={(e) => e.stopPropagation()} 
                            className="reply-continue-link"
                         >
                            Continue thread...
                         </Link>
                    </div>
                );
             }

             return (
                <PostComponent
                    key={replyId}
                    postId={replyId}
                    allPostsMap={allPostsMap}
                    userProfilesMap={profilesMap || new Map()}
                    onSetReplyingTo={onSetReplyingTo}
                    onViewProfile={onViewProfile}
                    onLikePost={onLikePost}
                    onDislikePost={onDislikePost}
                    onFetchUser={fetchUser}
                    currentUserState={currentUserState}
                    myPeerId={myPeerId}
                    ensurePostsAreFetched={ensurePostsAreFetched}
                    renderReplies={true}
                    isExpandedView={isExpandedView}
                    isReply={true}
                    depth={depth + 1}
                />
            );
          })}
        </div>
      )}
    </div>
  );
};

function arePropsEqual(prev: PostProps, next: PostProps): boolean {
    if (prev.postId !== next.postId) return false;
    if (prev.isExpandedView !== next.isExpandedView) return false;
    
    // 1. Post Content Equality (Fast Reference Check)
    const prevPost = prev.allPostsMap.get(prev.postId);
    const nextPost = next.allPostsMap.get(next.postId);
    if (prevPost !== nextPost) return false;

    // 2. Profile Equality
    // We must handle the case where the post/profile is missing
    const authorKey = prevPost?.authorKey;
    if (authorKey) {
        // Handle Map Switching (Global -> Thread Local)
        const prevP = prev.userProfilesMap?.get(authorKey);
        const nextP = next.userProfilesMap?.get(authorKey);
        // Deep compare profile because it's a small object
        if (prevP?.name !== nextP?.name || prevP?.bio !== nextP?.bio) return false;
    }

    // 3. User Interaction State (Likes/Dislikes)
    // We only care about *this* post's ID in the user's lists
    const prevLikes = prev.currentUserState?.likedPostCIDs?.includes(prev.postId);
    const nextLikes = next.currentUserState?.likedPostCIDs?.includes(next.postId);
    if (prevLikes !== nextLikes) return false;

    const prevDislikes = prev.currentUserState?.dislikedPostCIDs?.includes(prev.postId);
    const nextDislikes = next.currentUserState?.dislikedPostCIDs?.includes(next.postId);
    if (prevDislikes !== nextDislikes) return false;

    // Check Blocked Status Change
    const prevBlocked = prevPost && prev.currentUserState?.blockedUsers?.includes(prevPost.authorKey);
    const nextBlocked = nextPost && next.currentUserState?.blockedUsers?.includes(nextPost.authorKey);
    if (prevBlocked !== nextBlocked) return false;

    // 4. Replies (Tricky)
    // If renderReplies is true, we must re-render if a NEW reply appeared.
    // We can't scan O(N) here. 
    // We rely on 'allPostsMap' reference change being ignored unless 'post.replies' changed 
    // OR we have a cheap way to know. 
    // BUT: Current PostComponent calculates dynamic replies:
    //    if (p.referenceCID === postId) ...
    // If we return TRUE here (equal), we SKIP the dynamic scan.
    // Ideally, we need 'replyCount' in props.
    // Fortunately, we can check if the Map *Size* changed significantly or blindly trust 
    // that if the parent map updated, we might have new replies.
    //
    // Trade-off: To be safe for replies, we re-render if renderReplies is true.
    if (prev.renderReplies) {
        // Optimization: Check map size. If map size grew, maybe a reply arrived.
        if (prev.allPostsMap.size !== next.allPostsMap.size) return false;
        // Or strictly: return false to be safe, but then we lose memo benefits for threads.
        // Let's rely on reference equality of 'post' for now (optimistic).
        // If a new reply arrives, it usually doesn't mutate the parent 'post' object immediately
        // unless 'replies' field is used.
        // The 'loadedReplies' hook inside does the work.
        //
        // Compromise: Re-render ONLY if this component is responsible for rendering replies.
        return false; 
    }

    return true;
}

export default React.memo(PostComponent, arePropsEqual);