export type AttachmentKind = "text" | "document" | "tabular";

export interface AttachedFile {
  id: string;
  path: string;
  displayName: string;
  kind: AttachmentKind;
  sourcePath?: string;
  workspace?: string;
  readable?: boolean;
}

export interface AttachmentSkip {
  name: string;
  reason: "unsupported" | "directory" | "missing_path" | "read_error";
}

export interface AttachmentPickerResult {
  attachments: AttachedFile[];
  imageDataUrls: string[];
  skipped: AttachmentSkip[];
}

const TEXT_ATTACHMENT_EXTENSIONS = [
  "txt", "log", "md", "markdown",
  "js", "ts", "tsx", "jsx",
  "py", "cs", "java", "c", "cpp", "h", "hpp",
  "json", "yaml", "yml", "toml", "xml", "html", "css", "scss", "less",
  "sh", "bash", "zsh", "fish", "rs", "go", "rb", "php", "swift", "kt", "dart", "lua",
  "sql", "graphql", "env", "gitignore", "ignore",
];

const DOCUMENT_ATTACHMENT_EXTENSIONS = ["pdf", "docx"];
const TABULAR_ATTACHMENT_EXTENSIONS = ["xlsx", "xls", "csv", "tsv"];
const IMAGE_ATTACHMENT_EXTENSIONS = ["png", "jpg", "jpeg"];

export const CHAT_ATTACHMENT_PREFIX = ".MAIN-chat-attachments";

export const SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS = TEXT_ATTACHMENT_EXTENSIONS;
export const SUPPORTED_DOCUMENT_ATTACHMENT_EXTENSIONS = DOCUMENT_ATTACHMENT_EXTENSIONS;
export const SUPPORTED_TABULAR_ATTACHMENT_EXTENSIONS = TABULAR_ATTACHMENT_EXTENSIONS;
export const SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS = IMAGE_ATTACHMENT_EXTENSIONS;
export const SUPPORTED_ATTACHMENT_EXTENSIONS = [
  ...TEXT_ATTACHMENT_EXTENSIONS,
  ...DOCUMENT_ATTACHMENT_EXTENSIONS,
  ...TABULAR_ATTACHMENT_EXTENSIONS,
  ...IMAGE_ATTACHMENT_EXTENSIONS,
];

const TEXT_ATTACHMENT_SET = new Set(TEXT_ATTACHMENT_EXTENSIONS);
const DOCUMENT_ATTACHMENT_SET = new Set(DOCUMENT_ATTACHMENT_EXTENSIONS);
const TABULAR_ATTACHMENT_SET = new Set(TABULAR_ATTACHMENT_EXTENSIONS);
const IMAGE_ATTACHMENT_SET = new Set(IMAGE_ATTACHMENT_EXTENSIONS);

export function getAttachmentExtension(pathOrName: string): string {
  const clean = String(pathOrName || "").split(/[?#]/)[0];
  const fileName = clean.split(/[\\/]/).pop() || clean;
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) {
    const lower = fileName.toLowerCase();
    return TEXT_ATTACHMENT_SET.has(lower) ? lower : "";
  }
  return fileName.slice(dot + 1).toLowerCase();
}

export function getAttachmentDisplayName(pathOrName: string): string {
  return String(pathOrName || "").split(/[\\/]/).pop() || String(pathOrName || "attachment");
}

export function classifyAttachment(pathOrName: string): AttachmentKind | "image" | "unsupported" {
  const ext = getAttachmentExtension(pathOrName);
  if (IMAGE_ATTACHMENT_SET.has(ext)) return "image";
  if (TABULAR_ATTACHMENT_SET.has(ext)) return "tabular";
  if (DOCUMENT_ATTACHMENT_SET.has(ext)) return "document";
  if (TEXT_ATTACHMENT_SET.has(ext)) return "text";
  return "unsupported";
}

export function isImageAttachment(pathOrName: string): boolean {
  return classifyAttachment(pathOrName) === "image";
}

export function isSupportedAttachment(pathOrName: string): boolean {
  return classifyAttachment(pathOrName) !== "unsupported";
}

export function isChatAttachmentPath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  return normalized === CHAT_ATTACHMENT_PREFIX || normalized.startsWith(`${CHAT_ATTACHMENT_PREFIX}/`);
}

export function createAttachedFileDescriptor(sourcePath: string): AttachedFile | null {
  const kind = classifyAttachment(sourcePath);
  if (kind === "unsupported" || kind === "image") return null;
  const displayName = getAttachmentDisplayName(sourcePath);
  return {
    id: `${sourcePath}`,
    path: sourcePath,
    sourcePath,
    displayName,
    kind,
    readable: false,
  };
}

export function normalizeAttachedFile(entry: AttachedFile | string): AttachedFile {
  if (typeof entry === "string") {
    const descriptor = createAttachedFileDescriptor(entry);
    if (descriptor) return descriptor;
    return {
      id: entry,
      path: entry,
      sourcePath: entry,
      displayName: getAttachmentDisplayName(entry),
      kind: "text",
      readable: false,
    };
  }
  const sourcePath = entry.sourcePath || entry.path;
  return {
    ...entry,
    id: entry.id || sourcePath,
    path: entry.path || sourcePath,
    sourcePath,
    displayName: entry.displayName || getAttachmentDisplayName(sourcePath),
    kind: entry.kind || (classifyAttachment(sourcePath) === "tabular" ? "tabular" : classifyAttachment(sourcePath) === "document" ? "document" : "text"),
    readable: entry.readable === true,
  };
}

export function attachmentIdentity(entry: AttachedFile | string): string {
  const file = normalizeAttachedFile(entry);
  return [file.workspace || "", file.sourcePath || file.path, file.path].join("::");
}

export function mergeAttachedFiles(
  current: Array<AttachedFile | string>,
  incoming: AttachedFile[],
): AttachedFile[] {
  const merged: AttachedFile[] = [];
  const seen = new Set<string>();
  for (const item of [...current, ...incoming]) {
    const normalized = normalizeAttachedFile(item);
    const key = attachmentIdentity(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

export function getNativeFilePath(file: File): string | null {
  const candidate = (file as File & { path?: unknown }).path;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const trimmed = candidate.trim();
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  return null;
}
