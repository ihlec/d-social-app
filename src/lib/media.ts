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

    if (!ctx) {
      return reject(new Error("Could not get canvas context."));
    }

    video.addEventListener('loadedmetadata', () => {
       // Seek slightly into the video to avoid blank frames
      video.currentTime = 0.1;
    });


    video.addEventListener('seeked', () => {
       // Timeout needed for some browsers to render the frame correctly
      setTimeout(() => {
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
            URL.revokeObjectURL(video.src); // Clean up blob URL
          },
          "image/jpeg",
          THUMBNAIL_QUALITY
        );
      }, 50); // Small delay before capturing frame
    });

    video.addEventListener('error', (e) => {
      // Use type assertion or check if e is an Event
      const errorMessage = (e instanceof Event && e.target instanceof HTMLVideoElement) ? e.target.error?.message : 'Unknown video error';
      reject(new Error(`Video loading error: ${errorMessage}`));
      URL.revokeObjectURL(video.src); // Clean up blob URL
    });


    video.preload = 'metadata';
    video.muted = true; // Required for autoplay attempt in some browsers
    video.playsInline = true;
    video.src = URL.createObjectURL(file);
    // Attempt to play briefly to ensure frame is available, might not always work due to browser restrictions
    video.play().catch(() => {
        // Playback might be blocked, but seeking should still work after loadedmetadata
        console.warn("Video playback attempt blocked, thumbnail might rely solely on loadedmetadata.");
    });
  });
}


// Main function to create thumbnail based on file type
// --- Fix: Add export ---
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