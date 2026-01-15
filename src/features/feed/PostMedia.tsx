// fileName: src/features/feed/PostMedia.tsx
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

  // Use the Racing Hook for Media and Thumbnails
  const { bestUrl: activeImgUrl, allUrls: mediaUrls } = useGatewayRace(post.mediaCid);
  const { bestUrl: activeThumbUrl, allUrls: thumbnailUrls } = useGatewayRace(post.thumbnailCid);

  // Fallback State (if the "Best" URL fails during actual loading)
  const [imgErrorCount, setImgErrorCount] = useState(0);
  const [thumbErrorCount, setThumbErrorCount] = useState(0);

  const finalImgUrl = imgErrorCount > 0 && mediaUrls[imgErrorCount] ? mediaUrls[imgErrorCount] : activeImgUrl;
  const finalThumbUrl = thumbErrorCount > 0 && thumbnailUrls[thumbErrorCount] ? thumbnailUrls[thumbErrorCount] : activeThumbUrl;

  useEffect(() => {
    // When the active source changes (e.g. race winner updated), reload the video element
    if (videoRef.current) {
        videoRef.current.load();
    }
  }, [activeImgUrl]);

  const aspectRatio = post.mediaAspectRatio || (post.mediaType === 'video' ? 0.5625 : 1.77); 
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

  const mimeType = getMimeType(post.mediaFileName);

  // --- EXPANDED VIEW ---
  if (isExpandedView) {
     if (mediaUrls.length > 0 && post.mediaType === 'image') {
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
     } else if (mediaUrls.length > 0 && post.mediaType === 'video') {
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
                     {/* 
                        Use the RACED best URL as the first source.
                        This effectively makes the video player switch source priority based on the race.
                     */}
                     {activeImgUrl && <source src={activeImgUrl} type={mimeType} />}
                     
                     {/* Fallbacks (excluding the one we just added to avoid dupes if possible, but harmless) */}
                     {mediaUrls.filter(u => u !== activeImgUrl).map(url => (
                         <source key={url} src={url} type={mimeType} />
                     ))}
                     Your browser does not support the video tag.
                 </video>
             </div>
         );
     } else if (thumbnailUrls.length > 0) {
         return (
             <div className="post-media-expanded">
                 <img 
                    src={finalThumbUrl || undefined} 
                    alt="Video thumbnail" 
                    onError={() => handleImgError(true)}
                    crossOrigin="anonymous"
                 />
                 <div className="play-icon-overlay"><PlayIcon /></div>
             </div>
         );
     }
     return null;
  }
  // --- FEED VIEW ---
  else {
      if (thumbnailUrls.length > 0) {
          return (
            <div className="post-media-container" style={mediaContainerStyle}>
                <div className="video-thumbnail-container">
                  <img
                    src={finalThumbUrl || undefined}
                    alt="Video thumbnail"
                    className="post-media-thumbnail"
                    loading="lazy"
                    onError={() => handleImgError(true)}
                    crossOrigin="anonymous"
                  />
                  {post.mediaType === 'video' && (
                      <div className="play-icon-overlay">
                          <PlayIcon />
                      </div>
                  )}
                </div>
            </div>
          );
      } else if (post.mediaType === 'image' && mediaUrls.length > 0) {
           return (
            <div className="post-media-container" style={mediaContainerStyle}>
                <img
                  src={finalImgUrl || undefined}
                  alt="Post content"
                  className="post-media-thumbnail"
                  loading="lazy"
                  onError={() => handleImgError(false)}
                  crossOrigin="anonymous"
                />
            </div>
          );
      } else {
          return null; 
      }
  }
};

export default PostMedia;