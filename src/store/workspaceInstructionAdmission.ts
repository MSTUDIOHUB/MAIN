import type { AttachedFile } from "../lib/attachments";
import type { TaskBlock } from "../lib/taskTypes";
import type {
  WorkspaceInstructionSource,
  WorkspaceJsonObject,
} from "../lib/workspaceInstruction";
import { buildUserContextItems } from "../lib/userContextItems";

/**
 * Keeps the workspace admission projection independent from the legacy
 * sendMessage monolith. Admission materializes the exact same user-context
 * evidence that the later execution adapter will adopt.
 */
export function buildWorkspaceInstructionUserContext(input: {
  contextMentions: string[];
  attachedFiles: AttachedFile[];
  images: string[];
  workspace: string;
  language: "zh" | "en";
}): NonNullable<Extract<TaskBlock, { type: "user" }>["contextItems"]> {
  return buildUserContextItems(input);
}

export function buildWorkspaceInstructionPayloadIdentity(input: {
  text: string;
  images: string[];
  contextMentions: string[];
  attachedFiles: AttachedFile[];
  source: WorkspaceInstructionSource;
  dispatchHints?: WorkspaceJsonObject;
  remoteContext?: unknown;
}): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize({
    source: input.source,
    text: input.text,
    images: input.images,
    contextMentions: input.contextMentions,
    attachedFiles: input.attachedFiles.map((file) => ({
      id: file.id,
      path: file.path,
      displayName: file.displayName,
      kind: file.kind,
      sourcePath: file.sourcePath || null,
      workspace: file.workspace || null,
      readable: file.readable === true,
    })),
    dispatchHints: input.dispatchHints || null,
    remoteContext: input.remoteContext || null,
  }));
}
