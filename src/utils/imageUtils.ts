// Image processing utilities for multimodal chat support
// Handles clipboard paste, drag-and-drop, compression, and base64 conversion

const MAX_IMAGE_DIMENSION = 1024;
const JPEG_QUALITY = 0.8;

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
  return compressImage(dataUrl);
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
