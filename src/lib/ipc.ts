// region: Tauri IPC 类型定义

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PtyDataPayload {
  sessionKey?: string;
  session_key?: string;
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

export interface ReadFileWindowResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
  nextStartLine?: number | null;
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

export interface RepositoryIndex {
  root: string;
  generatedAtMs: number;
  symbols: SymbolEntry[];
  imports: ImportEdge[];
  dependencies: DependencyEdge[];
  embeddings: EmbeddingRecord[];
}

export interface SymbolEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
}

export interface ImportEdge {
  from: string;
  to: string;
  kind: string;
  line: number;
}

export interface DependencyEdge {
  manifest: string;
  package: string;
  source: string;
  requirement: string;
}

export interface EmbeddingRecord {
  file: string;
  chunkId: string;
  textHash: string;
  vector: number[];
}

export interface SessionMemory {
  buildFlow: BuildFlowStep[];
  packageManager?: string | null;
  repoStructure: string[];
  previousFailures: FailureRecord[];
  reflections: ReflectionRecord[];
  updatedAtMs: number;
}

export interface BuildFlowStep {
  command: string;
  purpose: string;
}

export interface FailureRecord {
  stepId: string;
  toolCall: string;
  stderr: string;
  verification: string;
  timestampMs: number;
}

export interface ReflectionRecord {
  failureStepId: string;
  summary: string;
  adjustedStrategy: string;
  avoidRepeating: string[];
  timestampMs: number;
}

export interface EvalReport {
  generatedAtMs: number;
  benchmarkRoot: string;
  totalCases: number;
  successRate: number;
  retryRate: number;
  hallucinationRate: number;
  avgLatency: number;
  avgToolCalls: number;
  categories: CategoryEvalReport[];
}

export interface CategoryEvalReport {
  category: string;
  totalCases: number;
  successRate: number;
  retryRate: number;
  hallucinationRate: number;
  avgLatency: number;
  avgToolCalls: number;
}

export type AgentRole = "planner" | "executor" | "critic";

export interface TaskNode {
  id: string;
  description: string;
  agent: AgentRole;
  dependencies: string[];
  tool?: string | null;
  input: unknown;
}

export interface TaskGraph {
  id: string;
  nodes: TaskNode[];
}

export interface MultiAgentPlan {
  objective: string;
  graph: TaskGraph;
}

export interface TaskGraphStepResult {
  nodeId: string;
  success: boolean;
  output: unknown;
  latencyMs: number;
  toolCalls: number;
}

export interface TaskGraphExecution {
  graphId: string;
  success: boolean;
  waves: string[][];
  results: TaskGraphStepResult[];
  latencyMs: number;
}

export interface CriticReport {
  hallucinationDetected: boolean;
  checkedSteps: number;
  missingEvidence: string[];
  summary: string;
}

export type McpToolDomain = "unity" | "browser" | "git" | "filesystem" | "terminal";

export interface McpToolDescriptor {
  name: string;
  domain: McpToolDomain;
  description: string;
  permissionScope: string;
  traceable: boolean;
  replayable: boolean;
  inputSchema: unknown;
}

export interface McpReplayRef {
  taskId: string;
  stepId: string;
}

export interface McpToolCall {
  id: string;
  taskId: string;
  tool: string;
  arguments: unknown;
  replay?: McpReplayRef | null;
}

export interface McpToolResult {
  id: string;
  taskId: string;
  tool: string;
  success: boolean;
  content: unknown;
  stdout: string;
  stderr: string;
  latencyMs: number;
  tracePath?: string | null;
  replayed: boolean;
}

export interface GitFileEntry {
  path: string;
  status: string;
}

export interface GitDiffEntry {
  path: string;
  status: string;
  old: string;
  new: string;
  existed: boolean;
  fullFile: boolean;
  binary?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  gitAvailable: boolean;
  repoRoot?: string | null;
  branch?: string | null;
  upstream?: string | null;
  ahead: number;
  behind: number;
  changedFiles: number;
  insertions: number;
  deletions: number;
  untrackedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  conflictedFiles: number;
  clean: boolean;
  hasOrigin: boolean;
  error?: string | null;
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

export interface AttachmentIngestResult {
  path: string;
  workspace: string;
  originalPath: string;
  displayName: string;
  sizeBytes: number;
}

// endregion

// region: 文件与搜索命令

export function readFile(path: string, workspace?: string): Promise<string> {
  return invoke<string>("read_file", { path, workspace });
}

export function readFileWindow(
  path: string,
  workspace?: string,
  startLine?: number,
  endLine?: number,
  maxLines?: number,
  maxChars?: number,
): Promise<ReadFileWindowResult> {
  return invoke<ReadFileWindowResult>("read_file_window", {
    path,
    workspace,
    startLine,
    endLine,
    maxLines,
    maxChars,
  });
}

export function getFileMetadata(path: string, workspace?: string): Promise<FileMetadata> {
  return invoke<FileMetadata>("get_file_metadata", { path, workspace });
}

export function getWorkspaceRoot(): Promise<string> {
  return invoke<string>("get_workspace_root");
}

export function setWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>("set_workspace_root", { path });
}

export function canonicalizeWorkspacePath(path: string): Promise<string> {
  return invoke<string>("canonicalize_workspace_path", { path });
}

export function writeFile(path: string, content: string, workspace?: string): Promise<void> {
  return invoke<void>("write_file", { path, content, workspace });
}

export function writeChatTempFile(sessionKey: string, path: string, content: string): Promise<string> {
  return invoke<string>("write_chat_temp_file", { sessionKey, path, content });
}

export function readChatTempFile(sessionKey: string, path: string): Promise<string> {
  return invoke<string>("read_chat_temp_file", { sessionKey, path });
}

export function getChatTempRoot(sessionKey: string): Promise<string> {
  return invoke<string>("get_chat_temp_root", { sessionKey });
}

export function ingestAttachmentFile(sessionKey: string, sourcePath: string): Promise<AttachmentIngestResult> {
  return invoke<AttachmentIngestResult>("ingest_attachment_file", { sessionKey, sourcePath });
}

export function ingestAttachmentBytes(sessionKey: string, fileName: string, bytes: number[]): Promise<AttachmentIngestResult> {
  return invoke<AttachmentIngestResult>("ingest_attachment_bytes", { sessionKey, fileName, bytes });
}

export function readAttachmentImageDataUrl(sourcePath: string): Promise<string> {
  return invoke<string>("read_attachment_image_data_url", { sourcePath });
}

export function deleteWorkspacePath(path: string, workspace?: string): Promise<void> {
  return invoke<void>("delete_workspace_path", { path, workspace });
}

export function deleteChatTempPath(sessionKey: string, path: string): Promise<void> {
  return invoke<void>("delete_chat_temp_path", { sessionKey, path });
}

export function deleteChatSessionTempFiles(sessionKey: string): Promise<void> {
  return deleteChatTempPath(sessionKey, ".");
}

export function listProjectSessions(workspace: string): Promise<any[]> {
  return invoke<any[]>("list_project_sessions", { workspace });
}

export function rebuildProjectSessionsIndex(workspace: string): Promise<any[]> {
  return invoke<any[]>("rebuild_project_sessions_index", { workspace });
}

export function saveProjectSession(workspace: string, session: any): Promise<any> {
  return invoke<any>("save_project_session", { workspace, session });
}

export function loadProjectSession(workspace: string, sessionId: number | string): Promise<any> {
  return invoke<any>("load_project_session", { workspace, sessionId });
}

export interface ProjectSessionPage {
  sessionId: string;
  turns: any[];
  messages: any[];
  startTurnIndex: number;
  endTurnIndex: number;
  totalTurns: number;
  hasMore: boolean;
  nextBeforeTurnIndex?: number | null;
}

export function loadProjectSessionMeta(workspace: string, sessionId: number | string): Promise<any> {
  return invoke<any>("load_project_session_meta", { workspace, sessionId });
}

export function loadProjectSessionPage(
  workspace: string,
  sessionId: number | string,
  beforeTurnIndex?: number | null,
  limit?: number,
): Promise<ProjectSessionPage> {
  return invoke<ProjectSessionPage>("load_project_session_page", {
    workspace,
    sessionId,
    beforeTurnIndex,
    limit,
  });
}

export function deleteProjectSession(workspace: string, sessionId: number | string): Promise<any[]> {
  return invoke<any[]>("delete_project_session", { workspace, sessionId });
}

export function clearProjectSessions(workspace: string): Promise<void> {
  return invoke<void>("clear_project_sessions", { workspace });
}

export function exportTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("export_text_file", { path, content });
}

export function listDirectory(path: string, workspace?: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("list_directory", { path, workspace });
}

export function globSearch(pattern: string, workspace?: string): Promise<string[]> {
  return invoke<string[]>("glob_search", { pattern, workspace });
}

export function grepSearch(query: string, path: string, workspace?: string): Promise<string> {
  return invoke<string>("grep_search", { query, path, workspace });
}

export function getProjectSkeleton(depth?: number, workspace?: string): Promise<string> {
  return invoke<string>("get_project_skeleton", { depth, workspace });
}

export function getFileOutline(path: string, workspace?: string): Promise<string> {
  return invoke<string>("get_file_outline", { path, workspace });
}

export function readDocument(
  path: string,
  maxChars?: number,
  maxBlocks?: number,
  rowOffset?: number,
  maxRows?: number,
  sheet?: string,
  workspace?: string,
): Promise<ReadDocumentResult> {
  return invoke<ReadDocumentResult>("read_document", {
    path,
    maxChars,
    maxBlocks,
    rowOffset,
    maxRows,
    sheet,
    workspace,
  });
}

export function analyzeTabularDocument(
  path: string,
  sheet?: string,
  maxColumns?: number,
  sampleRows?: number,
  focusColumns?: string,
  workspace?: string,
): Promise<AnalyzeTabularDocumentResult> {
  return invoke<AnalyzeTabularDocumentResult>("analyze_tabular_document", {
    path,
    sheet,
    maxColumns,
    sampleRows,
    focusColumns,
    workspace,
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
  workspace?: string,
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
    workspace,
  });
}

export function indexWorkspaceDocuments(
  path?: string,
  maxFiles?: number,
  maxCharsPerFile?: number,
  extensions?: string,
  workspace?: string,
): Promise<IndexWorkspaceDocumentsResult> {
  return invoke<IndexWorkspaceDocumentsResult>("index_workspace_documents", {
    path,
    maxFiles,
    maxCharsPerFile,
    extensions,
    workspace,
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
  workspace?: string,
): Promise<TerminalCommandOutput> {
  return invoke<TerminalCommandOutput>("run_command", {
    command,
    input,
    timeoutMs,
    workspace,
  });
}

export function buildRepositoryIndex(workspace?: string): Promise<RepositoryIndex> {
  return invoke<RepositoryIndex>("build_repository_index", { workspace });
}

export function loadSessionMemory(workspace?: string): Promise<SessionMemory> {
  return invoke<SessionMemory>("load_session_memory", { workspace });
}

export function recordSessionFailure(
  stepId: string,
  toolCall: string,
  stderr: string,
  verification: string,
  workspace?: string,
): Promise<ReflectionRecord> {
  return invoke<ReflectionRecord>("record_session_failure", {
    stepId,
    toolCall,
    stderr,
    verification,
    workspace,
  });
}

export function runEvalHarness(workspace?: string): Promise<EvalReport> {
  return invoke<EvalReport>("run_eval_harness", { workspace });
}

export function createMultiAgentPlan(objective: string): Promise<MultiAgentPlan> {
  return invoke<MultiAgentPlan>("create_multi_agent_plan", { objective });
}

export function listMcpTools(): Promise<McpToolDescriptor[]> {
  return invoke<McpToolDescriptor[]>("list_mcp_tools");
}

export function callMcpTool(call: McpToolCall, workspace?: string): Promise<McpToolResult> {
  return invoke<McpToolResult>("call_mcp_tool", { call, workspace });
}

export function executeTaskGraph(graph: TaskGraph, workspace?: string): Promise<TaskGraphExecution> {
  return invoke<TaskGraphExecution>("execute_task_graph", { graph, workspace });
}

export function reviewTaskGraphExecution(execution: TaskGraphExecution): Promise<CriticReport> {
  return invoke<CriticReport>("review_task_graph_execution", { execution });
}

export function getGitStatus(workspace?: string, includeStats?: boolean): Promise<GitStatus> {
  return invoke<GitStatus>("get_git_status", { workspace, includeStats });
}

export function getGitFileList(workspace: string, filter?: string): Promise<GitFileEntry[]> {
  return invoke<GitFileEntry[]>("get_git_file_list", { workspace, filter });
}

export function getGitDiff(workspace: string, path?: string, filter?: string): Promise<GitDiffEntry[]> {
  return invoke<GitDiffEntry[]>("get_git_diff", { workspace, path, filter });
}

export function gitCommitAll(workspace: string, message: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_commit_all", { workspace, message });
}

export function gitPushCurrentBranch(workspace: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_push_current_branch", { workspace });
}

export function gitCreateBranch(workspace: string, branch: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_create_branch", { workspace, branch });
}

// endregion

// region: PTY 命令与事件

export function spawnPty(cols: number, rows: number, sessionKey?: string, workspace?: string): Promise<void> {
  return invoke<void>("spawn_pty", { cols, rows, sessionKey, workspace });
}

export function resizePty(cols: number, rows: number, sessionKey?: string): Promise<void> {
  return invoke<void>("resize_pty", { cols, rows, sessionKey });
}

export function writePty(input: string, sessionKey?: string): Promise<void> {
  return invoke<void>("write_pty", { input, sessionKey });
}

export function readPtyBuffer(maxChars?: number, sessionKey?: string): Promise<string> {
  return invoke<string>("read_pty_buffer", { maxChars, sessionKey });
}

export function readPtyTail(maxChars?: number, sessionKey?: string): Promise<PtyReadResult> {
  return invoke<PtyReadResult>("read_pty_tail", { maxChars, sessionKey });
}

export function readPtySince(offset: number, maxChars?: number, sessionKey?: string): Promise<PtyReadResult> {
  return invoke<PtyReadResult>("read_pty_since", { offset, maxChars, sessionKey });
}

export function clearPtyBuffer(sessionKey?: string): Promise<PtyReadResult> {
  return invoke<PtyReadResult>("clear_pty_buffer", { sessionKey });
}

export function getPtyStatus(sessionKey?: string): Promise<PtyStatus> {
  return invoke<PtyStatus>("get_pty_status", { sessionKey });
}

function normalizePtySessionKeyForEvent(sessionKey?: string): string {
  const raw = String(sessionKey || "").trim() || "__MAIN_DEFAULT_PTY__";
  const sanitized = Array.from(raw)
    .map((ch) => /[A-Za-z0-9_.-]/.test(ch) ? ch : "_")
    .join("");
  const trimmed = sanitized.replace(/^_+|_+$/g, "");
  return trimmed || "session";
}

export function onPtyData(handler: (chunk: string) => void, sessionKey?: string): Promise<UnlistenFn> {
  const expectedSessionKey = sessionKey ? normalizePtySessionKeyForEvent(sessionKey) : null;
  return listen<PtyDataPayload>("pty-data", (event) => {
    const payload = event.payload || { chunk: "" };
    const payloadSessionKey = payload.sessionKey || payload.session_key;
    if (expectedSessionKey && normalizePtySessionKeyForEvent(payloadSessionKey) !== expectedSessionKey) return;
    handler(payload.chunk);
  });
}

// endregion

// region: Token 统计命令

export function countTokens(text: string): Promise<number> {
  return invoke<number>("count_tokens", { text });
}

// endregion
