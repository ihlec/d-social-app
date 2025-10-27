// fileName: src/features/feed/PostMedia.tsx
// src/components/Feed/PostMedia.tsx

import React, { useState, useEffect, useRef } from 'react';
import { Post } from '../../types';
import { getMediaUrl } from '../../api/ipfsIpns';
import { FileIcon, PlayIcon } from '../../components/Icons';

interface PostMediaProps {
  post: Post;
  isExpandedView?: boolean;
}

const PostMedia: React.FC<PostMediaProps> = ({ 
  post, 
  isExpandedView = false 
}) => {
  // --- FIX: Removed showFullMedia state ---
  const [isVisible, setIsVisible] = useState(false);
  const mediaRef = useRef<HTMLDivElement>(null); 
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // --- FIX: No longer need to reset showFullMedia ---
    setIsVisible(false);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true); 
          if (entry.target) {
            observer.unobserve(entry.target); 
          }
        }
      },
      { threshold: 0 }
    );

    const currentRef = mediaRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [post.id]); 

  const thumbnailUrl = post.thumbnailCid ? getMediaUrl(post.thumbnailCid) : null;
  const mediaUrl = post.mediaCid ? getMediaUrl(post.mediaCid) : null;

  if (!mediaUrl && !thumbnailUrl && post.mediaType !== 'file') {
     return null;
  }

  // File type
  if (post.mediaType === 'file') {
    if (!mediaUrl) return null;
    return (
      <div ref={mediaRef} className="post-file-container">
        {isVisible && ( 
          <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className="file-download-link">
            <FileIcon />
            <span>{post.fileName || 'Download File'}</span>
          </a>
        )}
      </div>
    );
  }

  // Image type
  if (post.mediaType === 'image') {
    const displayUrl = mediaUrl || thumbnailUrl;
    if (!displayUrl) return null;

    return (
      <div ref={mediaRef} className="post-media-container">
        {isVisible && ( 
          <img
            src={displayUrl}
            alt="Post media"
            // --- FIX: Removed showFullMedia logic and onClick ---
            className="post-media"
            loading="lazy"
          />
        )}
      </div>
    );
  }

  // Video type
  if (post.mediaType === 'video') {
    
    // Cleanup effect for video src
    useEffect(() => {
        const videoElement = videoRef.current;
        return () => {
            if (videoElement) {
                videoElement.pause();
                videoElement.src = '';
            }
        };
    }, []); // Runs only on unmount

    // --- START MODIFICATION: Conditional Rendering Logic ---
    if (isExpandedView) {
        // Only render the VIDEO element if in expanded view AND mediaUrl exists
        if (mediaUrl) {
            return (
                 <div ref={mediaRef} className="post-media-container">
                    {isVisible && (
                        <video
                            ref={videoRef}
                            src={mediaUrl}
                            controls
                            autoPlay // Autoplay only in expanded view
                            className="post-media full-width" // Use appropriate class
                        />
                    )}
                </div>
            );
        } else {
            // Expanded view but no video? Maybe show thumbnail as fallback? Or nothing.
            // For now, render nothing if the main video isn't available in expanded view.
             return null; 
        }
    } else {
        // Feed view: ONLY render the THUMBNAIL if it exists
        if (thumbnailUrl) {
            return (
              <div ref={mediaRef} className="post-media-container">
                {isVisible && ( 
                  <div className="video-thumbnail-container">
                    <img
                      src={thumbnailUrl}
                      alt="Video thumbnail"
                      className="post-media video-thumbnail"
                      loading="lazy"
                    />
                    <PlayIcon />
                  </div>
                )}
              </div>
            );
        } else {
            // Feed view, but no thumbnail? Render nothing.
            // Avoid rendering the <video> element here.
            console.warn(`[PostMedia] Video post ${post.id.substring(0,10)}... has no thumbnail for feed view.`);
            return null;
        }
    }
    // --- END MODIFICATION ---
  }

  return null;
};

export default PostMedia;