import { attachmentIdentity, getAttachmentDisplayName, normalizeAttachedFile, type AttachedFile } from "./attachments";
import {
  getRegisteredPersistedImageThumbnail,
  MAX_PERSISTED_IMAGE_THUMBNAIL_CHARS,
} from "../utils/imageUtils";
import { relativizeToWorkspacePath } from "./workspacePaths";

export type UserContextItemKind = "mention" | "attachment" | "image";
export type UserContextItemStatus = "ready" | "failed";

export interface UserContextItem {
  id: string;
  kind: UserContextItemKind;
  label: string;
  path?: string;
  status?: UserContextItemStatus;
  previewDataUrl?: string;
  /** Small persisted preview generated independently from the model input. */
  thumbnailDataUrl?: string;
}

function normalizePathForDisplay(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function compactOutsideWorkspacePath(path: string): string {
  const normalized = normalizePathForDisplay(path);
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `.../${parts.slice(-2).join("/")}`;
}

export function formatUserContextPathLabel(path: string, workspace?: string | null): string {
  const normalized = normalizePathForDisplay(path);
  if (!normalized) return "attachment";
  const relative = workspace ? relativizeToWorkspacePath(normalized, workspace) : normalized;
  if (relative && relative !== normalized) return relative;
  return compactOutsideWorkspacePath(normalized) || getAttachmentDisplayName(normalized);
}

export function buildUserContextItems(input: {
  contextMentions?: string[];
  attachedFiles?: Array<AttachedFile | string>;
  images?: string[];
  workspace?: string | null;
  language?: "zh" | "en";
}): UserContextItem[] {
  const language = input.language === "en" ? "en" : "zh";
  const items: UserContextItem[] = [];
  const seen = new Set<string>();

  for (const mention of input.contextMentions || []) {
    const path = String(mention || "").trim();
    if (!path) continue;
    const id = `mention:${path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      kind: "mention",
      label: formatUserContextPathLabel(path, input.workspace),
      path,
      status: "ready",
    });
  }

  for (const entry of input.attachedFiles || []) {
    const file = normalizeAttachedFile(entry);
    const path = file.sourcePath || file.path;
    const id = `attachment:${attachmentIdentity(file)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      kind: "attachment",
      label: file.displayName || formatUserContextPathLabel(path, input.workspace),
      path,
      status: "ready",
    });
  }

  (input.images || []).forEach((previewDataUrl, index) => {
    const id = `image:${index}`;
    const thumbnailDataUrl = getRegisteredPersistedImageThumbnail(previewDataUrl);
    items.push({
      id,
      kind: "image",
      label: language === "en" ? `Image ${index + 1}` : `截图 ${index + 1}`,
      status: "ready",
      previewDataUrl,
      ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
    });
  });

  return items;
}

export function sanitizeUserContextItemsForPersist(items: unknown): UserContextItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const sanitized = items
    .map((item, index): UserContextItem | null => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Partial<UserContextItem>;
      const kind = raw.kind === "mention" || raw.kind === "attachment" || raw.kind === "image"
        ? raw.kind
        : null;
      if (!kind) return null;
      const label = String(raw.label || (kind === "image" ? `Image ${index + 1}` : raw.path || "attachment")).trim();
      if (!label) return null;
      const status = raw.status === "failed" ? "failed" : raw.status === "ready" ? "ready" : undefined;
      const thumbnailDataUrl = kind === "image" &&
        typeof raw.thumbnailDataUrl === "string" &&
        raw.thumbnailDataUrl.startsWith("data:image/") &&
        raw.thumbnailDataUrl !== raw.previewDataUrl &&
        raw.thumbnailDataUrl.length <= MAX_PERSISTED_IMAGE_THUMBNAIL_CHARS
        ? raw.thumbnailDataUrl
        : undefined;
      return {
        id: String(raw.id || `${kind}:${index}`),
        kind,
        label,
        ...(typeof raw.path === "string" && raw.path.trim() ? { path: raw.path } : {}),
        ...(status ? { status } : {}),
        ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
      };
    })
    .filter((item): item is UserContextItem => !!item);

  return sanitized.length > 0 ? sanitized : undefined;
}
