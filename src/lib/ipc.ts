// region: Tauri IPC 类型定义

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PtyDataPayload {
  chunk: string;
}

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FileMetadata {
  path: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface HookCommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface TerminalCommandOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  success: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface PtyReadResult {
  text: string;
  startOffset: number;
  endOffset: number;
  truncated: boolean;
  bufferStartOffset: number;
  bufferEndOffset: number;
}

export interface PtyStatus {
  active: boolean;
  running: boolean;
  pid?: number | null;
  exitCode?: number | null;
  bufferStartOffset: number;
  bufferEndOffset: number;
  bufferBytes: number;
  tail: string;
}

export interface DocumentBlock {
  kind: string;
  sourceLabel: string;
  text: string;
  charCount: number;
  truncated?: boolean;
  page?: number;
  sheet?: string;
  cellRange?: string;
  rowStart?: number;
  rowEnd?: number;
  paragraph?: number;
  table?: number;
}

export interface ReadDocumentResult {
  path: string;
  documentType: string;
  title?: string | null;
  content: string;
  charCount: number;
  truncated: boolean;
  metadata: Record<string, unknown>;
  blocks: DocumentBlock[];
}

export interface IndexedDocumentSummary {
  path: string;
  documentType: string;
  title?: string | null;
  preview: string;
  charCount: number;
  truncated: boolean;
  blockCount: number;
  metadata: Record<string, unknown>;
}

export interface IndexWorkspaceDocumentsResult {
  rootPath: string;
  supportedExtensions: string[];
  matchedFiles: number;
  indexedFiles: number;
  scanLimited: boolean;
  files: IndexedDocumentSummary[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface TabularColumnSummary {
  name: string;
  kind: string;
  nonNullCount: number;
  nullCount: number;
  uniqueCount: number;
  sampleValues?: string[];
  topValues?: Array<{ value: string; count: number }>;
  summary?: Record<string, unknown>;
}

export interface AnalyzeTabularDocumentResult {
  path: string;
  documentType: string;
  title?: string | null;
  sourceName: string;
  metadata: Record<string, unknown>;
  columns: TabularColumnSummary[];
  sampleRows: {
    head: Array<Record<string, string>>;
    tail: Array<Record<string, string>>;
  };
}

export interface QueryTabularDocumentResult {
  path: string;
  documentType: string;
  title?: string | null;
  sourceName: string;
  metadata: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
}

// endregion

// region: 文件与搜索命令

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function getFileMetadata(path: string): Promise<FileMetadata> {
  return invoke<FileMetadata>("get_file_metadata", { path });
}

export function getWorkspaceRoot(): Promise<string> {
  return invoke<string>("get_workspace_root");
}

export function setWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>("set_workspace_root", { path });
}

export function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

export function writeChatTempFile(sessionKey: string, path: string, content: string): Promise<string> {
  return invoke<string>("write_chat_temp_file", { sessionKey, path, content });
}

export function readChatTempFile(sessionKey: string, path: string): Promise<string> {
  return invoke<string>("read_chat_temp_file", { sessionKey, path });
}

export function deleteWorkspacePath(path: string): Promise<void> {
  return invoke<void>("delete_workspace_path", { path });
}

export function deleteChatTempPath(sessionKey: string, path: string): Promise<void> {
  return invoke<void>("delete_chat_temp_path", { sessionKey, path });
}

export function exportTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("export_text_file", { path, content });
}

export function listDirectory(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("list_directory", { path });
}

export function globSearch(pattern: string): Promise<string[]> {
  return invoke<string[]>("glob_search", { pattern });
}

export function grepSearch(query: string, path: string): Promise<string> {
  return invoke<string>("grep_search", { query, path });
}

export function getProjectSkeleton(depth?: number): Promise<string> {
  return invoke<string>("get_project_skeleton", { depth });
}

export function getFileOutline(path: string): Promise<string> {
  return invoke<string>("get_file_outline", { path });
}

export function readDocument(
  path: string,
  maxChars?: number,
  maxBlocks?: number,
  rowOffset?: number,
  maxRows?: number,
  sheet?: string,
): Promise<ReadDocumentResult> {
  return invoke<ReadDocumentResult>("read_document", {
    path,
    maxChars,
    maxBlocks,
    rowOffset,
    maxRows,
    sheet,
  });
}

export function analyzeTabularDocument(
  path: string,
  sheet?: string,
  maxColumns?: number,
  sampleRows?: number,
  focusColumns?: string,
): Promise<AnalyzeTabularDocumentResult> {
  return invoke<AnalyzeTabularDocumentResult>("analyze_tabular_document", {
    path,
    sheet,
    maxColumns,
    sampleRows,
    focusColumns,
  });
}

export function queryTabularDocument(
  path: string,
  sheet?: string,
  selectColumns?: string,
  filters?: string,
  filterLogic?: string,
  groupBy?: string,
  aggregations?: string,
  sortBy?: string,
  rowOffset?: number,
  limit?: number,
): Promise<QueryTabularDocumentResult> {
  return invoke<QueryTabularDocumentResult>("query_tabular_document", {
    path,
    sheet,
    selectColumns,
    filters,
    filterLogic,
    groupBy,
    aggregations,
    sortBy,
    rowOffset,
    limit,
  });
}

export function indexWorkspaceDocuments(
  path?: string,
  maxFiles?: number,
  maxCharsPerFile?: number,
  extensions?: string,
): Promise<IndexWorkspaceDocumentsResult> {
  return invoke<IndexWorkspaceDocumentsResult>("index_workspace_documents", {
    path,
    maxFiles,
    maxCharsPerFile,
    extensions,
  });
}

export function deletePlanFiles(): Promise<void> {
  return invoke<void>("delete_plan_files");
}

export function runHookCommand(
  command: string,
  input?: string,
  timeoutMs?: number,
): Promise<HookCommandOutput> {
  return invoke<HookCommandOutput>("run_hook_command", {
    command,
    input,
    timeoutMs,
  });
}

export function runCommand(
  command: string,
  input?: string,
  timeoutMs?: number,
): Promise<TerminalCommandOutput> {
  return invoke<TerminalCommandOutput>("run_command", {
    command,
    input,
    timeoutMs,
  });
}

// endregion

// region: PTY 命令与事件

export function spawnPty(cols: number, rows: number): Promise<void> {
  return invoke<void>("spawn_pty", { cols, rows });
}

export function resizePty(cols: number, rows: number): Promise<void> {
  return invoke<void>("resize_pty", { cols, rows });
}

export function writePty(input: string): Promise<void> {
  return invoke<void>("write_pty", { input });
}

export function readPtyBuffer(maxChars?: number): Promise<string> {
  return invoke<string>("read_pty_buffer", { maxChars });
}

export function readPtyTail(maxChars?: number): Promise<PtyReadResult> {
  return invoke<PtyReadResult>("read_pty_tail", { maxChars });
}

export function readPtySince(offset: number, maxChars?: number): Promise<PtyReadResult> {
  return invoke<PtyReadResult>("read_pty_since", { offset, maxChars });
}

export function clearPtyBuffer(): Promise<PtyReadResult> {
  return invoke<PtyReadResult>("clear_pty_buffer");
}

export function getPtyStatus(): Promise<PtyStatus> {
  return invoke<PtyStatus>("get_pty_status");
}

export function onPtyData(handler: (chunk: string) => void): Promise<UnlistenFn> {
  return listen<PtyDataPayload>("pty-data", (event) => {
    handler(event.payload.chunk);
  });
}

// endregion

// region: Token 统计命令

export function countTokens(text: string): Promise<number> {
  return invoke<number>("count_tokens", { text });
}

// endregion
