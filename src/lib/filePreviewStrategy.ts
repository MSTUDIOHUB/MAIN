export const EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES = 1 * 1024 * 1024;

export type FilePreviewMode = "inline" | "externalRecommended" | "externalOnly";

export type FilePreviewReason =
  | "inlineSupported"
  | "largeFile"
  | "office"
  | "unsupportedBinary";

export interface FilePreviewStrategyInput {
  path: string;
  sizeBytes?: number | null;
  isBinary?: boolean | null;
}

export interface FilePreviewStrategy {
  mode: FilePreviewMode;
  reason: FilePreviewReason;
  shouldUseExternalOpen: boolean;
  thresholdBytes: number;
  sizeBytes?: number;
}

export const OFFICE_FILE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "xlsm",
  "ppt",
  "pptx",
  "pptm",
]);

export const UNSUPPORTED_BINARY_FILE_EXTENSIONS = new Set([
  "exe", "dll", "so", "dylib", "bin", "dat",
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst", "tgz",
  "pdf",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac", "ogg", "webm", "m4a",
  "woff", "woff2", "ttf", "otf", "eot",
  "class", "jar", "war", "pyc", "o", "a",
]);

export function getFilePreviewExtension(path: string): string {
  const fileName = path.split(/[\\/]/).pop()?.toLowerCase() || "";
  if (!fileName || (fileName.startsWith(".") && !fileName.includes(".", 1))) return "";
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === fileName.length - 1) return "";
  return fileName.slice(dotIdx + 1);
}

function normalizeSizeBytes(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function getFilePreviewStrategy(file: FilePreviewStrategyInput): FilePreviewStrategy {
  const ext = getFilePreviewExtension(file.path);
  const sizeBytes = normalizeSizeBytes(file.sizeBytes);

  if (OFFICE_FILE_EXTENSIONS.has(ext)) {
    return {
      mode: "externalOnly",
      reason: "office",
      shouldUseExternalOpen: true,
      thresholdBytes: EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES,
      sizeBytes,
    };
  }

  if (file.isBinary || UNSUPPORTED_BINARY_FILE_EXTENSIONS.has(ext)) {
    return {
      mode: "externalOnly",
      reason: "unsupportedBinary",
      shouldUseExternalOpen: true,
      thresholdBytes: EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES,
      sizeBytes,
    };
  }

  if (typeof sizeBytes === "number" && sizeBytes > EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES) {
    return {
      mode: "externalRecommended",
      reason: "largeFile",
      shouldUseExternalOpen: true,
      thresholdBytes: EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES,
      sizeBytes,
    };
  }

  return {
    mode: "inline",
    reason: "inlineSupported",
    shouldUseExternalOpen: false,
    thresholdBytes: EXTERNAL_OPEN_SIZE_THRESHOLD_BYTES,
    sizeBytes,
  };
}

export function shouldUseExternalOpen(file: FilePreviewStrategyInput): boolean {
  return getFilePreviewStrategy(file).shouldUseExternalOpen;
}
