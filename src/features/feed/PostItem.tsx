import React, { useMemo, useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Post, UserProfile, UserState } from '../../types';
import PostMedia from './PostMedia';
import PostHeader from './PostHeader';
import PostActions from './PostActions';
import { useAppContext } from '../../state/AppContext';
import { useGatewayRace, getMimeType } from '../../hooks/useGatewayRace';
import { sanitizeText } from '../../lib/utils';
import { isUsefulDisplayName } from '../../lib/nameDirectory';
import './PostItem.css';

const PDF_IFRAME_TIMEOUT_MS = 3000;

function isInlinePdfCandidate(url: string, mimeHint: string): boolean {
  if (!url) return false;
  // Gateway/http iframes often show empty PDF chrome; only try local blob: URLs.
  if (!url.startsWith('blob:')) return false;
  return !mimeHint || mimeHint.includes('pdf') || mimeHint === 'application/octet-stream';
}

/** Expanded PDF: try blob iframe briefly, collapse to card + Open PDF if blank/broken. */
const PdfExpandedPreview: React.FC<{
  url: string | null;
  fileName?: string;
}> = ({ url, fileName }) => {
  const mimeHint = getMimeType(fileName);
  const canTryIframe = !!url && isInlinePdfCandidate(url, mimeHint);
  const [showIframe, setShowIframe] = useState(canTryIframe);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    const ok = !!url && isInlinePdfCandidate(url, mimeHint);
    setShowIframe(ok);
    if (!ok || !url) return;

    const t = window.setTimeout(() => {
      // onLoad often fires for empty PDF viewers — still collapse if still blank-looking.
      // Keep iframe only when load completed quickly; otherwise fall back.
      if (!loadedRef.current) setShowIframe(false);
    }, PDF_IFRAME_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [url, mimeHint]);

  if (!url) {
    return (
      <div className="pdf-card-preview pdf-loading">
        <div className="pdf-icon">📄</div>
        <div className="pdf-info">
          <div className="pdf-name">{sanitizeText(fileName) || 'PDF Document'}</div>
          <div className="pdf-meta">Loading PDF…</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {showIframe ? (
        <iframe
          src={`${url}#view=FitH`}
          className="pdf-preview-frame"
          title="PDF Preview"
          onLoad={() => {
            loadedRef.current = true;
          }}
          onError={() => setShowIframe(false)}
        />
      ) : (
        <div className="pdf-card-preview pdf-fallback-card">
          <div className="pdf-icon">📄</div>
          <div className="pdf-info">
            <div className="pdf-name">{sanitizeText(fileName) || 'PDF Document'}</div>
            <div className="pdf-meta">Preview unavailable in-app</div>
          </div>
        </div>
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="file-download-link pdf-open-link"
        onClick={(e) => e.stopPropagation()}
        data-testid="open-pdf-link"
      >
        Open PDF
      </a>
    </>
  );
};

interface PostProps {
  postId: string;
  allPostsMap: Map<string, Post>;
  userProfilesMap?: Map<string, UserProfile>; 
  onSetReplyingTo?: (post: Post | null) => void;
  onViewProfile: (ipnsKey: string) => void;
  onLikePost?: (postId: string) => void;
  onDislikePost?: (postId: string) => void;
  onSavePost?: (postId: string) => void;
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
  onSavePost,
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
  
  // PostPage may pass a thread-local profile map that is ahead of global context.
  const profilesMap = propProfilesMap || contextProfiles;
  const fetchUser = propFetchUser || contextFetchUser;

  const post = allPostsMap.get(postId);
  const isMine = post?.authorKey === myPeerId;
  let authorProfile = post && profilesMap ? profilesMap.get(post.authorKey) : undefined;

  if (isMine && currentUserState?.profile) {
      authorProfile = currentUserState.profile;
  } else if (post && !isUsefulDisplayName(authorProfile?.name)) {
      // Offline fallback: name snapshotted on our follow list
      const followSnap = currentUserState?.follows?.find((f) => f.ipnsKey === post.authorKey);
      if (isUsefulDisplayName(followSnap?.name)) {
          authorProfile = { name: followSnap!.name!.trim(), bio: authorProfile?.bio };
      }
  }

  const isDisliked = useMemo(() => {
      return currentUserState?.dislikedPostCIDs?.includes(postId) || false;
  }, [currentUserState?.dislikedPostCIDs, postId]);

  const isBlocked = useMemo(() => {
      return post && currentUserState?.blockedUsers?.includes(post.authorKey) || false;
  }, [currentUserState?.blockedUsers, post]);

  const isProfileValid = (profile?: UserProfile) => {
      return !!profile && isUsefulDisplayName(profile.name);
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

    // Replace when already in a modal so modal states don't nest.
    const backgroundLocation = location.state?.backgroundLocation;
    const isModal = !!backgroundLocation;
    const finalContextIds = getContextIds ? getContextIds() : contextIds;

    navigate(`/post/${rootPost.id}`, {
        replace: isModal,
        state: {
            backgroundLocation: backgroundLocation || location,
            scrollToId: post.id,
            contextIds: finalContextIds,
        },
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

  // Race PDF / file attachment URLs (full body — needed for iframe + download)
  const isFileAttachment = post.mediaType === 'file';
  const isPdfAttachment =
    isFileAttachment && !!post.fileName?.toLowerCase().endsWith('.pdf');
  const { bestUrl: attachmentUrl } = useGatewayRace(
    isFileAttachment ? post.mediaCid : undefined,
    {
      mimeHint: getMimeType(post.mediaFileName || post.fileName),
      peerIpnsKey: post.authorKey,
      rendezvousCid: post.id,
      allowLarge: true,
    }
  );

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

      {!isDisliked && post.mediaCid && isFileAttachment && (
         <>
             {isPdfAttachment ? (
                 isExpandedView ? (
                     <div className="pdf-preview-container" onClick={(e) => e.stopPropagation()}>
                         <PdfExpandedPreview
                             url={attachmentUrl || null}
                             fileName={post.mediaFileName || post.fileName}
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
                        href={attachmentUrl || undefined} 
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
             onSavePost={onSavePost}
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
                    onSavePost={onSavePost}
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

    const prevPost = prev.allPostsMap.get(prev.postId);
    const nextPost = next.allPostsMap.get(next.postId);
    if (prevPost !== nextPost) return false;

    const authorKey = prevPost?.authorKey;
    if (authorKey) {
        const prevP = prev.userProfilesMap?.get(authorKey);
        const nextP = next.userProfilesMap?.get(authorKey);
        if (prevP?.name !== nextP?.name || prevP?.bio !== nextP?.bio) return false;
    }

    if (
        prev.currentUserState?.likedPostCIDs?.includes(prev.postId) !==
        next.currentUserState?.likedPostCIDs?.includes(next.postId)
    ) {
        return false;
    }
    if (
        prev.currentUserState?.dislikedPostCIDs?.includes(prev.postId) !==
        next.currentUserState?.dislikedPostCIDs?.includes(next.postId)
    ) {
        return false;
    }
    if (
        prev.currentUserState?.savedPostCIDs?.includes(prev.postId) !==
        next.currentUserState?.savedPostCIDs?.includes(next.postId)
    ) {
        return false;
    }

    const prevBlocked = prevPost && prev.currentUserState?.blockedUsers?.includes(prevPost.authorKey);
    const nextBlocked = nextPost && next.currentUserState?.blockedUsers?.includes(nextPost.authorKey);
    if (prevBlocked !== nextBlocked) return false;

    // Reply trees scan the map for children; skip memo when this node renders them.
    if (prev.renderReplies) return false;

    return true;
}

export default React.memo(PostComponent, arePropsEqual);