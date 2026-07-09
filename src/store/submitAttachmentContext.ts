import {
  type AttachedFile,
  type AttachmentKind,
  classifyAttachment,
  getAttachmentDisplayName,
  normalizeAttachedFile,
} from "../lib/attachments";
import type {
  AnalyzeTabularDocumentResult,
  AttachmentIngestResult,
  ReadDocumentResult,
} from "../lib/ipc";

const STRUCTURED_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".csv",
  ".tsv",
]);

const TABULAR_ATTACHMENT_EXTENSIONS = new Set([
  ".xlsx",
  ".xls",
  ".csv",
  ".tsv",
]);

export interface AttachmentReadRef {
  path: string;
  displayName: string;
  kind: AttachmentKind;
  workspace?: string;
  sourcePath?: string;
}

export interface SubmitAttachmentContextInput {
  text: string;
  mentions: string[];
  files: Array<AttachedFile | string>;
  runSessionKey: string;
  runWorkspace: string;
  preferredLanguage: "zh" | "en";
  markUserContextItemFailed: (path: string | undefined | null) => void;
  ingestAttachmentFile: (sessionKey: string, sourcePath: string) => Promise<AttachmentIngestResult>;
  readFile: (path: string, workspace?: string) => Promise<string>;
  readDocument: (
    path: string,
    maxChars?: number,
    maxBlocks?: number,
    rowOffset?: number,
    maxRows?: number,
    sheet?: string,
    workspace?: string,
  ) => Promise<ReadDocumentResult>;
  analyzeTabularDocument: (
    path: string,
    sheet?: string,
    maxColumns?: number,
    sampleRows?: number,
    focusColumns?: string,
    workspace?: string,
  ) => Promise<AnalyzeTabularDocumentResult>;
}

export interface SubmitAttachmentContextResult {
  userContent: string;
  attachmentRefs: AttachmentReadRef[];
  failedAttachmentCount: number;
}

export function shouldUseDocumentReader(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of STRUCTURED_ATTACHMENT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function shouldUseTabularAnalyzer(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of TABULAR_ATTACHMENT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export async function prepareAttachedFileForRead(input: {
  entry: AttachedFile | string;
  sessionKey: string;
  ingestAttachmentFile: SubmitAttachmentContextInput["ingestAttachmentFile"];
}): Promise<AttachmentReadRef> {
  const attachment = normalizeAttachedFile(input.entry);
  const sourcePath = attachment.sourcePath || attachment.path;

  if (attachment.readable && attachment.workspace) {
    return {
      path: attachment.path,
      displayName: attachment.displayName || getAttachmentDisplayName(attachment.path),
      kind: attachment.kind,
      workspace: attachment.workspace,
      sourcePath,
    };
  }

  const ingested = await input.ingestAttachmentFile(input.sessionKey, sourcePath);
  const kind = classifyAttachment(ingested.path);
  return {
    path: ingested.path,
    workspace: ingested.workspace,
    displayName: attachment.displayName || ingested.displayName || getAttachmentDisplayName(sourcePath),
    kind: kind === "tabular" || kind === "document" ? kind : "text",
    sourcePath: ingested.originalPath || sourcePath,
  };
}

function buildMentionContext(mentions: string[], preferredLanguage: "zh" | "en"): string | null {
  if (mentions.length === 0) return null;
  return preferredLanguage === "en"
    ? [
        "[user_mentioned_files]",
        "The user selected these files with @. Treat them as explicit context targets and use their exact paths for any follow-up read/query tools.",
        ...mentions.map((mentionPath) => `path: ${mentionPath}`),
      ].join("\n")
    : [
        "[user_mentioned_files]",
        "用户通过 @ 选择了这些文件。请把它们视为明确上下文目标，后续读取/查询工具必须优先使用这些精确路径。",
        ...mentions.map((mentionPath) => `path: ${mentionPath}`),
      ].join("\n");
}

async function buildFileContextBlock(
  ref: AttachmentReadRef,
  runWorkspace: string,
  input: SubmitAttachmentContextInput,
): Promise<string> {
  const fp = ref.path;
  const readWorkspace = ref.workspace ?? runWorkspace;
  if (shouldUseTabularAnalyzer(fp)) {
    const summary = await input.analyzeTabularDocument(fp, undefined, undefined, undefined, undefined, readWorkspace);
    const preview = await input.readDocument(fp, 3000, 12, 0, 40, undefined, readWorkspace);
    const compactSummary = {
      rowCount: summary.metadata.rowCount,
      columnCount: summary.metadata.columnCount,
      columns: Array.isArray(summary.metadata.columns)
        ? (summary.metadata.columns as unknown[]).slice(0, 40)
        : summary.metadata.columns,
      numericColumns: Array.isArray(summary.metadata.numericColumns)
        ? (summary.metadata.numericColumns as unknown[]).slice(0, 20)
        : summary.metadata.numericColumns,
      categoricalColumns: Array.isArray(summary.metadata.categoricalColumns)
        ? (summary.metadata.categoricalColumns as unknown[]).slice(0, 20)
        : summary.metadata.categoricalColumns,
      datetimeColumns: Array.isArray(summary.metadata.datetimeColumns)
        ? (summary.metadata.datetimeColumns as unknown[]).slice(0, 20)
        : summary.metadata.datetimeColumns,
      sampleHead: summary.sampleRows.head,
      sampleTail: summary.sampleRows.tail,
    };
    return [
      "[attached_tabular_file]",
      `path: ${fp}`,
      ...(ref.sourcePath && ref.sourcePath !== fp ? [`originalPath: ${ref.sourcePath}`] : []),
      `documentType: ${preview.documentType}`,
      `sourceName: ${summary.sourceName}`,
      `truncatedPreview: ${preview.truncated ? "true" : "false"}`,
      "note: The preview below is not guaranteed to be the full file. Use analyze_tabular_document, query_tabular_document, or read_document on this exact path for full-file reasoning.",
      "[summary]",
      JSON.stringify(compactSummary, null, 2),
      "[preview]",
      preview.content || JSON.stringify(preview.metadata),
    ].join("\n");
  }

  if (shouldUseDocumentReader(fp)) {
    const doc = await input.readDocument(fp, undefined, undefined, undefined, undefined, undefined, readWorkspace);
    const header = [
      "[attached_document]",
      `path: ${fp}`,
      ...(ref.sourcePath && ref.sourcePath !== fp ? [`originalPath: ${ref.sourcePath}`] : []),
      `documentType: ${doc.documentType}`,
      `truncatedPreview: ${doc.truncated ? "true" : "false"}`,
    ];
    if (doc.title) header.push(`title: ${doc.title}`);
    header.push("note: If this preview is truncated, use read_document on the exact path above before concluding.");
    const body = doc.content || JSON.stringify(doc.metadata);
    return `${header.join("\n")}\n${body}`;
  }

  const raw = await input.readFile(fp, readWorkspace);
  return [
    "[attached_file]",
    `path: ${fp}`,
    ...(ref.sourcePath && ref.sourcePath !== fp ? [`originalPath: ${ref.sourcePath}`] : []),
    raw,
  ].join("\n");
}

export async function buildSubmitAttachmentContext(
  input: SubmitAttachmentContextInput,
): Promise<SubmitAttachmentContextResult> {
  const attachmentRefs: AttachmentReadRef[] = [];
  const failedAttachmentParts: string[] = [];
  for (const file of input.files) {
    try {
      attachmentRefs.push(await prepareAttachedFileForRead({
        entry: file,
        sessionKey: input.runSessionKey,
        ingestAttachmentFile: input.ingestAttachmentFile,
      }));
    } catch {
      const attachment = normalizeAttachedFile(file);
      input.markUserContextItemFailed(attachment.sourcePath || attachment.path);
      failedAttachmentParts.push(`[无法读取文件：${attachment.displayName || getAttachmentDisplayName(attachment.path)}]`);
    }
  }

  for (const mentionPath of input.mentions) {
    const kind = classifyAttachment(mentionPath);
    attachmentRefs.push({
      path: mentionPath,
      displayName: getAttachmentDisplayName(mentionPath),
      kind: kind === "tabular" || kind === "document" ? kind : "text",
    });
  }

  const seenAttachmentRefs = new Set<string>();
  const allFileRefs = attachmentRefs.filter((ref) => {
    const key = `${ref.workspace || input.runWorkspace || ""}::${ref.path}`;
    if (seenAttachmentRefs.has(key)) return false;
    seenAttachmentRefs.add(key);
    return true;
  });

  if (allFileRefs.length === 0 && failedAttachmentParts.length === 0) {
    return {
      userContent: input.text,
      attachmentRefs: allFileRefs,
      failedAttachmentCount: 0,
    };
  }

  const parts: string[] = [];
  const mentionContext = buildMentionContext(input.mentions, input.preferredLanguage);
  if (mentionContext) parts.push(mentionContext);
  parts.push(...failedAttachmentParts);

  for (const ref of allFileRefs) {
    const fp = ref.path;
    try {
      const content = await buildFileContextBlock(ref, input.runWorkspace, input);
      const name = ref.displayName || fp.split("/").pop() || fp;
      parts.push("```" + name + "\n" + content + "\n```");
    } catch {
      const name = ref.displayName || fp.split("/").pop() || fp;
      input.markUserContextItemFailed(ref.sourcePath || fp);
      if (ref.sourcePath) input.markUserContextItemFailed(fp);
      parts.push(`[无法读取文件：${name}]`);
    }
  }

  return {
    userContent: parts.join("\n\n") + "\n\n" + input.text,
    attachmentRefs: allFileRefs,
    failedAttachmentCount: failedAttachmentParts.length,
  };
}
