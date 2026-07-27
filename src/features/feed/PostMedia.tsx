import React, { useState, useEffect, useRef } from 'react';
import { Post } from '../../types';
import { PlayIcon } from '../../components/Icons';
import { useGatewayRace, getMimeType } from '../../hooks/useGatewayRace';

interface PostMediaProps {
  post: Post;
  isExpandedView?: boolean;
}

const PostMedia: React.FC<PostMediaProps> = ({
  post,
  isExpandedView = false
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const mimeType = getMimeType(post.mediaFileName);
  const thumbMime =
    post.mediaType === 'image' ? mimeType : 'image/jpeg';
  const isImage = post.mediaType === 'image';
  const isVideo = post.mediaType === 'video';
  // File attachments (PDFs, etc.) are rendered by PostItem — do not race their
  // bytes here or a wrong MIME hint can poison the shared blob: URL cache.
  const isFileAttachment = post.mediaType === 'file';

  // Feed cards only need the thumbnail — loading full video via Helia blobs
  // into RAM can kill the Chromium renderer. Resolution order: Helia → P2P → gateway.
  const mediaCidForRace =
    isFileAttachment
      ? undefined
      : isExpandedView || isImage || !post.thumbnailCid
        ? post.mediaCid
        : undefined;

  const { bestUrl: activeImgUrl, allUrls: mediaUrls } = useGatewayRace(mediaCidForRace, {
    mimeHint: mimeType,
    peerIpnsKey: post.authorKey,
    rendezvousCid: post.id,
    // Post page / expanded: allow up to P2P max from local Helia (feed stays ≤8MB)
    allowLarge: isExpandedView,
  });
  const { bestUrl: activeThumbUrl, allUrls: thumbnailUrls } = useGatewayRace(post.thumbnailCid, {
    mimeHint: thumbMime,
    peerIpnsKey: post.authorKey,
    rendezvousCid: post.id,
  });

  // Fallback State (if the "Best" URL fails during actual loading)
  const [imgErrorCount, setImgErrorCount] = useState(0);
  const [thumbErrorCount, setThumbErrorCount] = useState(0);

  const finalImgUrl = imgErrorCount > 0 && mediaUrls[imgErrorCount] ? mediaUrls[imgErrorCount] : activeImgUrl;
  const finalThumbUrl = thumbErrorCount > 0 && thumbnailUrls[thumbErrorCount] ? thumbnailUrls[thumbErrorCount] : activeThumbUrl;

  const thumbExhausted = thumbnailUrls.length === 0 || thumbErrorCount >= thumbnailUrls.length;
  /** Images: prefer full media when thumb is missing/failed (common with gateway CORS). */
  const useMediaAsPreview = isImage && mediaUrls.length > 0 && (thumbExhausted || !finalThumbUrl);
  const previewUrl = useMediaAsPreview ? finalImgUrl : finalThumbUrl;
  const previewIsThumb = !useMediaAsPreview;

  useEffect(() => {
    // When the active source changes (e.g. race winner updated), reload the video element
    if (videoRef.current) {
        videoRef.current.load();
    }
  }, [activeImgUrl]);

  const aspectRatio = post.mediaAspectRatio || (isVideo ? 0.5625 : 1.77); 
  const paddingBottom = `${(1 / aspectRatio) * 100}%`;

  const mediaContainerStyle = isExpandedView 
    ? {} 
    : { paddingBottom }; 

  const handleImgError = (isThumbnail: boolean) => {
      if (isThumbnail) {
          setThumbErrorCount(prev => prev + 1);
      } else {
          setImgErrorCount(prev => prev + 1);
      }
  };

  const previewAlt = isVideo ? 'Video thumbnail' : 'Post image';

  if (isFileAttachment) {
    return null;
  }

  if (isExpandedView) {
     if (mediaUrls.length > 0 && isImage) {
         return (
             <div className="post-media-expanded">
                 <img 
                    src={finalImgUrl || undefined} 
                    alt="Post content" 
                    loading="lazy"
                    onError={() => handleImgError(false)}
                    crossOrigin="anonymous"
                 />
             </div>
         );
     } else if (mediaUrls.length > 0 && isVideo) {
         return (
             <div className="post-media-expanded">
                 <video 
                    ref={videoRef}
                    key={activeImgUrl || post.mediaCid}
                    controls 
                    autoPlay 
                    loop 
                    playsInline  
                    preload="metadata"
                    crossOrigin="anonymous" 
                    poster={finalThumbUrl || undefined}
                 >
                     {activeImgUrl && <source src={activeImgUrl} type={mimeType} />}
                     {mediaUrls.filter(u => u !== activeImgUrl).map(url => (
                         <source key={url} src={url} type={mimeType} />
                     ))}
                     Your browser does not support the video tag.
                 </video>
             </div>
         );
     } else if (previewUrl) {
         return (
             <div className="post-media-expanded">
                 <img 
                    src={previewUrl || undefined} 
                    alt={previewAlt}
                    onError={() => handleImgError(previewIsThumb)}
                    crossOrigin="anonymous"
                 />
                 {isVideo && (
                   <div className="play-icon-overlay"><PlayIcon /></div>
                 )}
             </div>
         );
     }
     return null;
  }
  else {
      if (previewUrl) {
          return (
            <div className="post-media-container" style={mediaContainerStyle}>
                <div className="video-thumbnail-container">
                  <img
                    src={previewUrl || undefined}
                    alt={previewAlt}
                    className="post-media-thumbnail"
                    loading="lazy"
                    onError={() => handleImgError(previewIsThumb)}
                    crossOrigin="anonymous"
                  />
                  {isVideo && (
                      <div className="play-icon-overlay">
                          <PlayIcon />
                      </div>
                  )}
                </div>
            </div>
          );
      }
      return null; 
  }
};

export default PostMedia;
