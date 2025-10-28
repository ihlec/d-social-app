// fileName: src/features/feed/PostMedia.tsx
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
  const [isVisible, setIsVisible] = useState(false);
  const mediaRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setIsVisible(false); // Reset visibility when post ID changes

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          if (entry.target) {
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0 } // Load when element starts entering viewport
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
  const aspectRatio = post.mediaAspectRatio;
  // Apply aspect ratio style only in feed view if available
  const mediaContainerStyle = aspectRatio && !isExpandedView
    ? { aspectRatio: aspectRatio, overflow: 'hidden' }
    : { overflow: 'hidden' };

  if (!mediaUrl && !thumbnailUrl && post.mediaType !== 'file') {
     return null; // Cannot display anything if no media/thumbnail (and not a file)
  }

  // --- File type ---
  if (post.mediaType === 'file') {
    if (!mediaUrl) return null; // Need the main file CID for download link
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

  // --- Image type ---
  if (post.mediaType === 'image') {
    // --- START MODIFICATION: Prioritize thumbnail in feed, full image in expanded ---
    let displayUrl: string | null = null;
    let altText = "Post media";

    if (isExpandedView) {
        // Expanded view: Prefer full image, fallback to thumbnail
        displayUrl = mediaUrl || thumbnailUrl;
        altText = mediaUrl ? "Post media" : "Post thumbnail (full image unavailable)";
    } else {
        // Feed view: Prefer thumbnail, fallback to full image (if thumbnail missing)
        displayUrl = thumbnailUrl || mediaUrl;
         altText = thumbnailUrl ? "Post thumbnail" : "Post media (thumbnail unavailable)";
    }

    if (!displayUrl) return null; // Still can't display if both are missing

    return (
      <div ref={mediaRef} className="post-media-container" style={mediaContainerStyle}>
        {isVisible && (
          <img
            src={displayUrl}
            alt={altText}
            className="post-media" // Class remains the same
            loading="lazy"
          />
        )}
      </div>
    );
    // --- END MODIFICATION ---
  }

  // --- Video type ---
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

    // Expanded View: Show video player if mediaUrl exists
    if (isExpandedView) {
        if (mediaUrl) {
            return (
                 <div ref={mediaRef} className="post-media-container" style={mediaContainerStyle}>
                    {isVisible && (
                        <video
                            ref={videoRef}
                            src={mediaUrl}
                            controls
                            autoPlay
                            className="post-media" // Use base class
                        />
                    )}
                </div>
            );
        } else {
             // Fallback for expanded view if full video is somehow missing but thumbnail isn't
             if(thumbnailUrl) {
                 return (
                     <div ref={mediaRef} className="post-media-container" style={mediaContainerStyle}>
                         {isVisible && (
                           <div className="video-thumbnail-container">
                             <img
                               src={thumbnailUrl}
                               alt="Video thumbnail (full video unavailable)"
                               className="post-media video-thumbnail"
                               loading="lazy"
                             />
                              {/* Optionally hide play icon if full video is missing? */}
                             {/* <PlayIcon /> */}
                           </div>
                         )}
                     </div>
                 );
             }
             return null; // Nothing to show
        }
    }
    // Feed View: Show thumbnail if thumbnailUrl exists
    else {
        if (thumbnailUrl) {
            return (
              <div ref={mediaRef} className="post-media-container" style={mediaContainerStyle}>
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
            // Log if no thumbnail for feed view video
            console.warn(`[PostMedia] Video post ${post.id.substring(0,10)}... has no thumbnail for feed view.`);
            return null; // Render nothing in feed if no thumbnail
        }
    }
  }

  return null; // Should not be reached for image/video/file types
};

export default PostMedia;