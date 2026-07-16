// Image processing utilities for multimodal chat support
// Handles clipboard paste, drag-and-drop, compression, and base64 conversion

const MAX_IMAGE_DIMENSION = 1024;
const JPEG_QUALITY = 0.8;
export const MAX_PERSISTED_IMAGE_THUMBNAIL_CHARS = 24_000;
const PERSISTED_THUMBNAIL_DIMENSIONS = [96, 72, 56] as const;
const PERSISTED_THUMBNAIL_QUALITIES = [0.58, 0.48, 0.4] as const;
const MAX_REGISTERED_THUMBNAILS = 24;
type RegisteredThumbnail = { sourceGuard: string; thumbnail: string };
const persistedThumbnailBySource = new Map<string, RegisteredThumbnail>();

function imageDataIdentity(source: string): { key: string; guard: string } {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return {
    key: `${source.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`,
    // A same-length FNV collision cannot return another image's thumbnail.
    guard: `${source.slice(0, 48)}:${source.slice(-48)}`,
  };
}

export function registerPersistedImageThumbnail(sourceDataUrl: string, thumbnailDataUrl: string): boolean {
  const source = String(sourceDataUrl || "");
  const thumbnail = String(thumbnailDataUrl || "");
  if (
    !source.startsWith("data:image/") ||
    !thumbnail.startsWith("data:image/") ||
    thumbnail === source ||
    thumbnail.length > MAX_PERSISTED_IMAGE_THUMBNAIL_CHARS
  ) {
    return false;
  }
  const identity = imageDataIdentity(source);
  persistedThumbnailBySource.delete(identity.key);
  persistedThumbnailBySource.set(identity.key, {
    sourceGuard: identity.guard,
    thumbnail,
  });
  while (persistedThumbnailBySource.size > MAX_REGISTERED_THUMBNAILS) {
    const oldest = persistedThumbnailBySource.keys().next().value;
    if (!oldest) break;
    persistedThumbnailBySource.delete(oldest);
  }
  return true;
}

export function getRegisteredPersistedImageThumbnail(sourceDataUrl: string): string | undefined {
  const source = String(sourceDataUrl || "");
  const identity = imageDataIdentity(source);
  const registered = persistedThumbnailBySource.get(identity.key);
  if (!registered || registered.sourceGuard !== identity.guard) return undefined;
  // Refresh the bounded LRU entry while the submit pipeline consumes it.
  persistedThumbnailBySource.delete(identity.key);
  persistedThumbnailBySource.set(identity.key, registered);
  return registered.thumbnail;
}

/** Build a small, hard-capped preview for session history; never returns the source image. */
export function createPersistedImageThumbnail(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const source = String(dataUrl || "");
    if (!source.startsWith("data:image/") || typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      for (let index = 0; index < PERSISTED_THUMBNAIL_DIMENSIONS.length; index += 1) {
        const maxDimension = PERSISTED_THUMBNAIL_DIMENSIONS[index];
        const ratio = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
        const width = Math.max(1, Math.round((img.width || 1) * ratio));
        const height = Math.max(1, Math.round((img.height || 1) * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.drawImage(img, 0, 0, width, height);
        const thumbnail = canvas.toDataURL("image/jpeg", PERSISTED_THUMBNAIL_QUALITIES[index]);
        if (
          thumbnail !== source &&
          thumbnail.startsWith("data:image/") &&
          thumbnail.length <= MAX_PERSISTED_IMAGE_THUMBNAIL_CHARS
        ) {
          resolve(thumbnail);
          return;
        }
      }
      resolve(null);
    };
    img.onerror = () => resolve(null);
    img.src = source;
  });
}

/**
 * Convert a File/Blob to a base64 data URL string.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Compress and resize an image if it exceeds MAX_IMAGE_DIMENSION.
 * Returns the processed image as a base64 data URL.
 */
export function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;

      // Skip compression if image is already small enough
      if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
        // Still re-encode as JPEG for consistency (unless it's a small PNG)
        if (dataUrl.startsWith("data:image/jpeg")) {
          resolve(dataUrl);
          return;
        }
      }

      // Calculate new dimensions
      let newWidth = width;
      let newHeight = height;
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const ratio = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
        newWidth = Math.round(width * ratio);
        newHeight = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width = newWidth;
      canvas.height = newHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, newWidth, newHeight);

      // Re-encode as JPEG for smaller size
      const result = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      resolve(result);
    };
    img.onerror = () => resolve(dataUrl); // Fallback to original
    img.src = dataUrl;
  });
}

/**
 * Process an image File from paste or drag-drop:
 * 1. Convert to base64 data URL
 * 2. Compress/resize if needed
 */
export async function processImageFile(file: File): Promise<string> {
  const dataUrl = await blobToDataUrl(file);
  const processed = await compressImage(dataUrl);
  const thumbnail = await createPersistedImageThumbnail(processed);
  if (thumbnail) registerPersistedImageThumbnail(processed, thumbnail);
  return processed;
}

/**
 * Extract image Files from a ClipboardEvent.
 */
export function getImageFilesFromClipboard(e: ClipboardEvent): File[] {
  const files: File[] = [];
  if (e.clipboardData?.items) {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return files;
}

/**
 * Extract image Files from a DragEvent.
 */
export function getImageFilesFromDrop(e: DragEvent): File[] {
  const files: File[] = [];
  if (e.dataTransfer?.files) {
    for (const file of e.dataTransfer.files) {
      if (file.type.startsWith("image/")) {
        files.push(file);
      }
    }
  }
  return files;
}
