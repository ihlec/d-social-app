// fileName: src/lib/media.ts
// Constants for thumbnail dimensions and quality
const THUMBNAIL_MAX_WIDTH = 400;
const THUMBNAIL_MAX_HEIGHT = 300;
const THUMBNAIL_QUALITY = 0.8; // JPEG quality

// --- START MODIFICATION: Define return type ---
interface ThumbnailCreationResult {
  thumbnailFile: File | null;
  aspectRatio: number | null;
}
// --- END MODIFICATION ---

// Create a thumbnail for an image file
// --- START MODIFICATION: Update return type ---
function createImageThumbnail(file: File): Promise<ThumbnailCreationResult> {
// --- END MODIFICATION ---
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return reject(new Error("Could not get canvas context."));
    }

    img.onload = () => {
      // --- START MODIFICATION: Capture aspect ratio ---
      const aspectRatio = img.width > 0 && img.height > 0 ? img.width / img.height : null;
      // --- END MODIFICATION ---
      let targetWidth = THUMBNAIL_MAX_WIDTH;
      let targetHeight = targetWidth / (aspectRatio || 1.77); // Default to 16:9 if invalid

      if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
        targetHeight = THUMBNAIL_MAX_HEIGHT;
        targetWidth = targetHeight * (aspectRatio || 1.77);
      }

      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            // --- START MODIFICATION: Return object ---
            resolve({
              thumbnailFile: new File([blob], "thumbnail.jpg", { type: "image/jpeg" }),
              aspectRatio: aspectRatio
            });
            // --- END MODIFICATION ---
          } else {
            reject(new Error("Canvas toBlob returned null."));
          }
        },
        "image/jpeg",
        THUMBNAIL_QUALITY
      );
      URL.revokeObjectURL(img.src); // Clean up blob URL
    };

    img.onerror = () => {
      reject(new Error("Image loading error."));
      URL.revokeObjectURL(img.src); // Clean up blob URL
    };

    img.src = URL.createObjectURL(file);
  });
}

// Create a thumbnail for a video file (capture first frame)
// --- START MODIFICATION: Update return type ---
function createVideoThumbnail(file: File): Promise<ThumbnailCreationResult> {
// --- END MODIFICATION ---
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const objectUrl = URL.createObjectURL(file); // Create URL once
    // --- START MODIFICATION: Capture aspect ratio in a ref ---
    let aspectRatio: number | null = null;
    // --- END MODIFICATION ---

    if (!ctx) {
       URL.revokeObjectURL(objectUrl); // Clean up on error
      return reject(new Error("Could not get canvas context."));
    }

    // --- START MODIFICATION: Cleanup function ---
    const cleanup = () => {
        // Remove event listeners
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        // Revoke the object URL
        URL.revokeObjectURL(objectUrl);
        // Ensure video element is removed if it was added to DOM (though it shouldn't be)
        video.remove(); 
        console.log("[createVideoThumbnail] Cleanup complete.");
    };
    // --- END MODIFICATION ---

    // --- START MODIFICATION: Define event handlers ---
    const onLoadedMetadata = () => {
       console.log("[createVideoThumbnail] Metadata loaded. Seeking...");
       // --- START MODIFICATION: Capture aspect ratio ---
       if (video.videoWidth > 0 && video.videoHeight > 0) {
           aspectRatio = video.videoWidth / video.videoHeight;
       }
       // --- END MODIFICATION ---
       // Seek slightly into the video to avoid blank frames
      video.currentTime = 0.1;
    };

    const onSeeked = () => {
       console.log("[createVideoThumbnail] Seek complete. Capturing frame...");
       // Timeout needed for some browsers to render the frame correctly after seek
      setTimeout(() => {
        try { // Add try...catch for drawing errors
            const safeAspectRatio = aspectRatio || (video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 1.77); // Fallback
            let targetWidth = THUMBNAIL_MAX_WIDTH;
            let targetHeight = targetWidth / safeAspectRatio;

            if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
              targetHeight = THUMBNAIL_MAX_HEIGHT;
              targetWidth = targetHeight * safeAspectRatio;
            }

            canvas.width = targetWidth;
            canvas.height = targetHeight;
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

            canvas.toBlob(
              (blob) => {
                if (blob) {
                  // --- START MODIFICATION: Return object ---
                  resolve({
                    thumbnailFile: new File([blob], "thumbnail.jpg", { type: "image/jpeg" }),
                    aspectRatio: aspectRatio // Use the one captured at 'loadedmetadata'
                  });
                  // --- END MODIFICATION ---
                } else {
                  reject(new Error("Canvas toBlob returned null."));
                }
                cleanup(); // Call cleanup after blob creation
              },
              "image/jpeg",
              THUMBNAIL_QUALITY
            );
        } catch (drawError) {
             console.error("[createVideoThumbnail] Error during canvas draw:", drawError);
             reject(new Error("Failed to draw video frame to canvas."));
             cleanup();
        }
      }, 50); // Small delay before capturing frame
    };

    const onError = (e: Event) => {
      // Use type assertion or check if e is an Event
      const errorMessage = (e.target instanceof HTMLVideoElement && e.target.error) ? e.target.error.message : 'Unknown video error';
      console.error("[createVideoThumbnail] Video error event:", errorMessage, e);
      reject(new Error(`Video loading error: ${errorMessage}`));
      cleanup(); // Call cleanup on error
    };
    // --- END MODIFICATION ---

    // --- START MODIFICATION: Attach event listeners ---
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    // --- END MODIFICATION ---

    video.preload = 'metadata';
    video.muted = true; // --- Ensure muted ---
    video.playsInline = true;
    video.src = objectUrl; // Use the created object URL

    // --- REMOVED: Do not call play() ---
    // video.play().catch(() => {
    //     console.warn("Video playback attempt blocked, thumbnail might rely solely on loadedmetadata.");
    // });
    // --- END REMOVAL ---
    console.log("[createVideoThumbnail] Video source set. Waiting for metadata...");
  });
}


// Main function to create thumbnail based on file type
// --- START MODIFICATION: Update return type ---
export async function createThumbnail(file: File): Promise<ThumbnailCreationResult> {
// --- END MODIFICATION ---
    try {
        if (file.type.startsWith("image/")) {
            return await createImageThumbnail(file);
        } else if (file.type.startsWith("video/")) {
            return await createVideoThumbnail(file);
        } else {
            console.log("Thumbnail generation skipped: Unsupported file type", file.type);
            // --- START MODIFICATION: Return object ---
            return { thumbnailFile: null, aspectRatio: null }; // Not an image or video
            // --- END MODIFICATION ---
        }
    } catch (error) {
         console.error("Thumbnail generation failed:", error);
         // --- START MODIFICATION: Return object ---
         return { thumbnailFile: null, aspectRatio: null };
         // --- END MODIFICATION ---
    }
}