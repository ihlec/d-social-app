// src/components/Feed/PostMedia.tsx

import React, { useState, useEffect, useRef } from 'react';
import { Post } from '../../types';
import { getMediaUrl } from '../../api/ipfs';
import { FileIcon, PlayIcon } from '../../components/Icons';

interface PostMediaProps {
  post: Post;
}

const PostMedia: React.FC<PostMediaProps> = ({ post }) => {
  const [showFullMedia, setShowFullMedia] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const mediaRef = useRef<HTMLDivElement>(null); // This ref will now be on the main container

  // Lazy load media when it becomes visible
  useEffect(() => {
    // --- FIX: When a component is recycled, reset its visibility ---
    // This isn't strictly necessary with the dependency change below,
    // but it's good practice to ensure state is clean.
    setIsVisible(false);
    setShowFullMedia(false); // Also reset the "full media" view

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true); // Set visible
          if (entry.target) {
            observer.unobserve(entry.target); // Stop observing
          }
        }
      },
      // --- FIX: Change threshold to 0 ---
      // This will trigger as soon as 1 pixel is visible.
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
  // --- FIX: Add post.id to the dependency array ---
  // This forces the effect to re-run when Virtuoso recycles this
  // component and gives it a new 'post' prop.
  }, [post.id]); // Re-run this entire effect if the post ID changes

  const thumbnailUrl = post.thumbnailCid ? getMediaUrl(post.thumbnailCid) : null;
  const mediaUrl = post.mediaCid ? getMediaUrl(post.mediaCid) : null;

  // If no media CIDs exist for this post, render nothing.
  if (!mediaUrl && !thumbnailUrl && post.mediaType !== 'file') {
     return null;
  }

  // --- We will always render the container div and attach the ref ---
  // The container will be empty (0 height) until `isVisible` is true,
  // but the observer can still watch it.

  // File type
  if (post.mediaType === 'file') {
    if (!mediaUrl) return null;
    return (
      <div ref={mediaRef} className="post-file-container">
        {isVisible && ( // Only render content when visible
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
        {isVisible && ( // Only render content when visible
          <img
            src={displayUrl}
            alt="Post media"
            className={`post-media ${showFullMedia ? 'full-width' : ''}`}
            onClick={() => setShowFullMedia(prev => !prev)}
            style={{ cursor: 'pointer' }}
            loading="lazy"
          />
        )}
      </div>
    );
  }

  // Video type
  if (post.mediaType === 'video') {
    if (!mediaUrl && !thumbnailUrl) return null;

    return (
      <div ref={mediaRef} className="post-media-container">
        {isVisible && ( // Only render content when visible
          <>
            {showFullMedia && mediaUrl ? (
              <video
                src={mediaUrl}
                controls
                autoPlay
                className="post-media full-width"
              />
            ) : thumbnailUrl ? (
              <div className="video-thumbnail-container" onClick={() => mediaUrl && setShowFullMedia(true)}>
                <img
                  src={thumbnailUrl}
                  alt="Video thumbnail"
                  className="post-media video-thumbnail"
                  loading="lazy"
                />
                <PlayIcon />
              </div>
            ) : mediaUrl ? (
              <video
                src={mediaUrl}
                controls
                preload="metadata"
                className={`post-media ${showFullMedia ? 'full-width' : ''}`}
                onClick={() => setShowFullMedia(true)}
              />
            ) : null}
          </>
        )}
      </div>
    );
  }

  return null;
};

export default PostMedia;