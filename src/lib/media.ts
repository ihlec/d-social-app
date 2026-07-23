const THUMBNAIL_MAX_WIDTH = 400;
const THUMBNAIL_MAX_HEIGHT = 300;
const THUMBNAIL_QUALITY = 0.8;
const VIDEO_THUMB_TIMEOUT_MS = 12_000;

interface ThumbnailCreationResult {
  thumbnailFile: File | null;
  aspectRatio: number | null;
}

function createImageThumbnail(file: File): Promise<ThumbnailCreationResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return reject(new Error('Could not get canvas context.'));
    }

    img.onload = () => {
      const aspectRatio = img.width > 0 && img.height > 0 ? img.width / img.height : null;
      let targetWidth = THUMBNAIL_MAX_WIDTH;
      let targetHeight = targetWidth / (aspectRatio || 1.77);

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
            resolve({
              thumbnailFile: new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' }),
              aspectRatio,
            });
          } else {
            reject(new Error('Canvas toBlob returned null.'));
          }
        },
        'image/jpeg',
        THUMBNAIL_QUALITY
      );
      URL.revokeObjectURL(img.src);
    };

    img.onerror = () => {
      reject(new Error('Image loading error.'));
      URL.revokeObjectURL(img.src);
    };

    img.src = URL.createObjectURL(file);
  });
}

function createVideoThumbnail(file: File): Promise<ThumbnailCreationResult> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const objectUrl = URL.createObjectURL(file);
    let aspectRatio: number | null = null;
    let settled = false;

    if (!ctx) {
      URL.revokeObjectURL(objectUrl);
      return reject(new Error('Could not get canvas context.'));
    }

    const cleanup = () => {
      clearTimeout(watchdog);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      URL.revokeObjectURL(objectUrl);
      video.remove();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (result: ThumbnailCreationResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const watchdog = setTimeout(() => {
      fail(new Error('Video thumbnail timed out (codec/browser hang).'));
    }, VIDEO_THUMB_TIMEOUT_MS);

    const onLoadedMetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        aspectRatio = video.videoWidth / video.videoHeight;
      }
      video.currentTime = 0.1;
    };

    const onSeeked = () => {
      setTimeout(() => {
        try {
          const safeAspectRatio =
            aspectRatio ||
            (video.videoWidth > 0 && video.videoHeight > 0
              ? video.videoWidth / video.videoHeight
              : 1.77);
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
                succeed({
                  thumbnailFile: new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' }),
                  aspectRatio,
                });
              } else {
                fail(new Error('Canvas toBlob returned null.'));
              }
            },
            'image/jpeg',
            THUMBNAIL_QUALITY
          );
        } catch (drawError) {
          console.error('[createVideoThumbnail] canvas draw failed', drawError);
          fail(new Error('Failed to draw video frame to canvas.'));
        }
      }, 50);
    };

    const onError = (e: Event) => {
      const errorMessage =
        e.target instanceof HTMLVideoElement && e.target.error
          ? e.target.error.message
          : 'Unknown video error';
      fail(new Error(`Video loading error: ${errorMessage}`));
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;
  });
}

export async function createThumbnail(file: File): Promise<ThumbnailCreationResult> {
  try {
    if (file.type.startsWith('image/')) {
      return await createImageThumbnail(file);
    }
    if (file.type.startsWith('video/')) {
      return await createVideoThumbnail(file);
    }
    return { thumbnailFile: null, aspectRatio: null };
  } catch (error) {
    console.error('Thumbnail generation failed:', error);
    return { thumbnailFile: null, aspectRatio: null };
  }
}
