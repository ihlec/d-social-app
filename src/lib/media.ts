// src/lib/media.ts
// Constants for thumbnail dimensions and quality
const THUMBNAIL_MAX_WIDTH = 400;
const THUMBNAIL_MAX_HEIGHT = 300;
const THUMBNAIL_QUALITY = 0.8; // JPEG quality

// Create a thumbnail for an image file
function createImageThumbnail(file: File): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return reject(new Error("Could not get canvas context."));
    }

    img.onload = () => {
      const aspectRatio = img.width / img.height;
      let targetWidth = THUMBNAIL_MAX_WIDTH;
      let targetHeight = targetWidth / aspectRatio;

      if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
        targetHeight = THUMBNAIL_MAX_HEIGHT;
        targetWidth = targetHeight * aspectRatio;
      }

      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(new File([blob], "thumbnail.jpg", { type: "image/jpeg" }));
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
function createVideoThumbnail(file: File): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const objectUrl = URL.createObjectURL(file); // Create URL once

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
       // Seek slightly into the video to avoid blank frames
      video.currentTime = 0.1;
    };

    const onSeeked = () => {
       console.log("[createVideoThumbnail] Seek complete. Capturing frame...");
       // Timeout needed for some browsers to render the frame correctly after seek
      setTimeout(() => {
        try { // Add try...catch for drawing errors
            const aspectRatio = video.videoWidth / video.videoHeight;
            let targetWidth = THUMBNAIL_MAX_WIDTH;
            let targetHeight = targetWidth / aspectRatio;

            if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
              targetHeight = THUMBNAIL_MAX_HEIGHT;
              targetWidth = targetHeight * aspectRatio;
            }

            canvas.width = targetWidth;
            canvas.height = targetHeight;
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

            canvas.toBlob(
              (blob) => {
                if (blob) {
                  resolve(new File([blob], "thumbnail.jpg", { type: "image/jpeg" }));
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
export async function createThumbnail(file: File): Promise<File | null> {
    try {
        if (file.type.startsWith("image/")) {
            return await createImageThumbnail(file);
        } else if (file.type.startsWith("video/")) {
            return await createVideoThumbnail(file);
        } else {
            console.log("Thumbnail generation skipped: Unsupported file type", file.type);
            return null; // Not an image or video
        }
    } catch (error) {
         console.error("Thumbnail generation failed:", error);
         return null;
    }
}