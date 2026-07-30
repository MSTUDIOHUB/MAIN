// region: Tauri IPC 类型定义

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createProjectSessionMutationCoordinator,
  isProjectSessionAdmissionProjectionOwned,
  type ProjectSessionSaveOptions,
} from "./projectSessionMutationCoordinator";

const projectSessionMutations = createProjectSessionMutationCoordinator();
const projectSessionRevisionByOwner = new Map<string, number>();

function projectSessionOwnerKey(workspace: string, sessionId: number | string): string {
  return `${workspace}\u0000${String(sessionId)}`;
}

function normalizeProjectSessionStorageRevision(value: unknown): number | null {
  const revision = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function rememberProjectSessionRevision(ownerKey: string, session: unknown): void {
  const revision = normalizeProjectSessionStorageRevision((session as any)?.storageRevision);
  if (revision === null) return;
  const current = projectSessionRevisionByOwner.get(ownerKey);
  // Read APIs can settle after a newer save. Never let an older projection
  // roll the process-local CAS fence backward.
  if (current === undefined || revision > current) {
    projectSessionRevisionByOwner.set(ownerKey, revision);
  }
}

function rememberProjectSessionList(workspace: string, sessions: unknown): void {
  if (!Array.isArray(sessions)) return;
  sessions.forEach((session) => {
    const sessionId = (session as any)?.id;
    if (typeof sessionId !== "number" && typeof sessionId !== "string") return;
    rememberProjectSessionRevision(projectSessionOwnerKey(workspace, sessionId), session);
  });
}

function clearProjectSessionRevision(ownerKey: string): void {
  projectSessionRevisionByOwner.delete(ownerKey);
}

function clearWorkspaceProjectSessionRevisions(workspace: string): void {
  const ownerPrefix = `${workspace}\u0000`;
  for (const ownerKey of projectSessionRevisionByOwner.keys()) {
    if (ownerKey.startsWith(ownerPrefix)) {
      projectSessionRevisionByOwner.delete(ownerKey);
    }
  }
}

function isProjectSessionObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function projectSessionTranscriptRows(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function projectSessionTranscriptRowId(value: unknown): string | null {
  if (!isProjectSessionObject(value)) return null;
  const id = value.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id !== "string") return null;
  const normalized = id.trim();
  return normalized || null;
}

function mergeProjectSessionTranscriptRows(existing: readonly any[], incoming: readonly any[]): any[] {
  const rows = [...existing];
  const positions = new Map<string, number>();
  rows.forEach((row, index) => {
    const id = projectSessionTranscriptRowId(row);
    if (id) positions.set(id, index);
  });
  incoming.forEach((row) => {
    const id = projectSessionTranscriptRowId(row);
    const position = id ? positions.get(id) : undefined;
    if (position !== undefined) {
      rows[position] = row;
      return;
    }
    if (id) positions.set(id, rows.length);
    rows.push(row);
  });
  return rows;
}

function projectSessionTranscriptIsPartial(session: unknown): boolean {
  if (!isProjectSessionObject(session)) return false;
  const runtime = isProjectSessionObject(session.runtimeSnapshot)
    ? session.runtimeSnapshot
    : null;
  return session.transcriptPartial === true || runtime?.transcriptPartial === true;
}

function projectSessionSaveNeedsTranscriptBase(session: unknown): boolean {
  if (!isProjectSessionObject(session)) return false;
  const runtime = isProjectSessionObject(session.runtimeSnapshot)
    ? session.runtimeSnapshot
    : null;
  return projectSessionTranscriptIsPartial(session) ||
    projectSessionTranscriptRows(session.messages).length === 0 ||
    projectSessionTranscriptRows(runtime?.conversationTurns).length === 0;
}

function prepareProjectSessionSnapshotForSave(session: any, existing: unknown): any {
  const incoming = isProjectSessionObject(session) ? session : {};
  const current = isProjectSessionObject(existing) ? existing : {};
  const incomingRuntime = isProjectSessionObject(incoming.runtimeSnapshot)
    ? incoming.runtimeSnapshot
    : null;
  const currentRuntime = isProjectSessionObject(current.runtimeSnapshot)
    ? current.runtimeSnapshot
    : null;
  const incomingMessages = projectSessionTranscriptRows(incoming.messages);
  const incomingTurns = projectSessionTranscriptRows(incomingRuntime?.conversationTurns);
  const existingMessages = projectSessionTranscriptRows(current.messages);
  const existingTurns = projectSessionTranscriptRows(currentRuntime?.conversationTurns);
  const partial = projectSessionTranscriptIsPartial(incoming);

  let messages = partial
    ? mergeProjectSessionTranscriptRows(existingMessages, incomingMessages)
    : [...incomingMessages];
  let turns = partial
    ? mergeProjectSessionTranscriptRows(existingTurns, incomingTurns)
    : [...incomingTurns];
  if (messages.length === 0 && existingMessages.length > 0) {
    messages = [...existingMessages];
  }
  if (turns.length === 0 && existingTurns.length > 0) {
    turns = [...existingTurns];
  }

  const runtimeSnapshot = {
    ...(currentRuntime || {}),
    ...(incomingRuntime || {}),
    taskFlow: messages,
    conversationTurns: turns,
  };
  return {
    ...current,
    ...incoming,
    messages,
    messageCount: messages.length,
    turnCount: turns.length,
    runtimeSnapshot,
  };
}

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
  contentVersion: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
  nextStartLine?: number | null;
  returnedStartChar?: number | null;
  returnedEndChar?: number | null;
  nextStartChar?: number | null;
}

export interface OpenFileExternalResult {
  path: string;
  opened: boolean;
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

export interface BrowserEvaluateInput {
  url: string;
  actions?: string;
  checks?: string;
  waitForText?: string;
  waitForSelector?: string;
  screenshot?: boolean;
  failOnConsoleError?: boolean;
  timeoutMs?: number;
}

export interface BrowserEvaluateResult {
  ok: boolean;
  failureType?: string | null;
  failureSummary?: string;
  failureReasons?: string[];
  failureFingerprint?: string | null;
  validationSpecError?: Record<string, unknown> | null;
  failedAction?: Record<string, unknown> | null;
  blankPage?: boolean;
  url?: string;
  finalUrl?: string;
  status?: number | null;
  title?: string;
  actions?: Array<Record<string, unknown>>;
  assertions?: Array<Record<string, unknown>>;
  consoleMessages?: Array<Record<string, unknown>>;
  consoleErrors?: string[];
  pageErrors?: string[];
  failedRequests?: string[];
  screenshotPath?: string | null;
  screenshotError?: string | null;
  renderDiagnostics?: Record<string, unknown> | null;
  interactiveElements?: Array<Record<string, unknown>>;
  navigationCompleted?: boolean;
  textPreview?: string;
  durationMs?: number;
  error?: string | null;
}

export interface ComputerUseInput {
  appName: string;
  appPath?: string;
  launch?: boolean;
  activate?: boolean;
  actions?: string;
  checks?: string;
  screenshot?: boolean;
  timeoutMs?: number;
}

export interface ComputerUseResult {
  ok: boolean;
  failureType?: string | null;
  failureSummary?: string | null;
  failureReasons?: string[];
  appName?: string | null;
  launched?: boolean;
  actions?: Array<Record<string, unknown>>;
  assertions?: Array<Record<string, unknown>>;
  causalAssertionSatisfied?: boolean;
  accessibility?: Record<string, unknown> | null;
  screenshotPath?: string | null;
  screenshotError?: string | null;
  durationMs?: number;
  error?: string | null;
}

export type ShellPermissionDecisionKind = "allow" | "ask" | "deny";
export type ShellPermissionRiskLevel = "low" | "medium" | "high" | "critical";

export interface ShellPermissionSegmentDecision {
  command: string;
  decision: ShellPermissionDecisionKind;
  matchedRule?: string | null;
  suggestedRule?: string | null;
  riskLevel?: ShellPermissionRiskLevel | null;
  reviewReason?: string | null;
}

export interface ShellPermissionDecision {
  command: string;
  decision: ShellPermissionDecisionKind;
  source: "builtin_default" | "workspace_file" | string;
  sourcePath?: string | null;
  segmentDecisions: ShellPermissionSegmentDecision[];
  allowedBy?: string | null;
  matchedRule?: string | null;
  suggestedRule?: string | null;
  suggestedRules?: string[];
  riskLevel?: ShellPermissionRiskLevel | null;
  reviewReason?: string | null;
  requiresApproval: boolean;
}

export interface ShellPermissionApproval {
  command: string;
  approvedAtMs?: number | null;
  scope?: "once" | "session" | string | null;
  rules?: string[];
  riskLevel?: ShellPermissionRiskLevel | null;
}

export interface RepositoryIndex {
  root: string;
  generatedAtMs: number;
  symbols: SymbolEntry[];
  imports: ImportEdge[];
  calls?: CallEdge[];
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

export interface CallEdge {
  from: string;
  symbol: string;
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

export interface AstSymbol {
  name: string;
  kind: string;
  syntaxKind: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  signature: string;
}

export interface AstQueryResult {
  path: string;
  language: string;
  rootKind: string;
  hasErrors: boolean;
  errorCount: number;
  /** Exact workspace snapshot parsed by Tree-sitter. */
  sizeBytes: number;
  modifiedMs: number;
  versionToken: string;
  query: string;
  exactMatchCount: number;
  symbols: AstSymbol[];
  truncated: boolean;
  note: string;
}

export interface SourceSyntaxCheckResult {
  path: string;
  language: string | null;
  applicable: boolean;
  hasErrors: boolean;
  errorCount: number;
  firstErrorLine?: number | null;
  firstErrorColumn?: number | null;
  errors?: Array<{
    line: number;
    column: number;
    kind: string;
  }>;
  errorsTruncated?: boolean;
}

export interface SymbolOccurrence {
  path: string;
  language: string;
  role: "definition" | "import" | "call" | "reference" | string;
  syntaxKind: string;
  line: number;
  column: number;
  context: string;
}

export interface SymbolReferencesResult {
  symbol: string;
  scope: string;
  scannedFiles: number;
  skippedFiles: number;
  parseFailures: number;
  occurrences: SymbolOccurrence[];
  truncated: boolean;
  note: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  sourceCount: number;
  indexStatus: string;
  embeddingProfile: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface KnowledgeSource {
  id: string;
  kbId: string;
  title: string;
  originalPath: string;
  storagePath: string;
  ext: string;
  size: number;
  hash: string;
  status: string;
  metadata: Record<string, unknown> | null;
  lastIndexedAtMs: number;
}

export interface KnowledgeCitation {
  kbId: string;
  kbName: string;
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  page?: number | null;
  block?: string | null;
  score: number;
}

export interface KnowledgeSearchHit {
  text: string;
  excerpt: string;
  citation: KnowledgeCitation;
}

export interface KnowledgeSearchResult {
  query: string;
  searchedKnowledgeBaseIds: string[];
  hits: KnowledgeSearchHit[];
  note: string;
}

export interface KnowledgeImportResult {
  base: KnowledgeBase;
  source: KnowledgeSource;
  chunks: number;
  deduped: boolean;
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
  cases: EvalCaseResult[];
}

export interface EvalCaseResult {
  id: string;
  category: string;
  success: boolean;
  retries: number;
  hallucinations: number;
  latencyMs: number;
  toolCalls: number;
  resultKind: TraceResultKind;
  failures: string[];
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

export interface RuntimeHarnessStepInput {
  stepId: string;
  toolCall: string;
  verificationCommand?: string | null;
  terminal?: boolean | null;
}

export interface RuntimeHarnessRequest {
  taskId?: string | null;
  steps: RuntimeHarnessStepInput[];
  activeFiles?: string[];
  workingMemory?: string[];
  summaries?: string[];
  maxAttempts?: number | null;
  retryBackoffMs?: number | null;
  timeoutMs?: number | null;
}

export interface RuntimeStepSummary {
  stepId: string;
  toolCall: string;
  verification: string;
  success: boolean;
}

export interface RuntimeContext {
  activeFiles: string[];
  recentSteps: RuntimeStepSummary[];
  workingMemory: string[];
  summaries: string[];
  mistakes: string[];
}

export interface TraceRecord {
  schemaVersion: number;
  runId: string | null;
  sequence: number;
  attempt: number;
  taskId: string;
  stepId: string;
  eventName: string;
  toolCall: string;
  inputDigest: string;
  stdout: string;
  stderr: string;
  structuredOutput: unknown;
  outputDigest: string;
  success: boolean;
  resultKind: TraceResultKind;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  verification: string;
  latencyMs: number;
  events: string[];
  metadata: unknown;
}

export interface RuntimeHarnessReport {
  run: {
    taskId: string;
    runId: string;
    resultKind: TraceResultKind;
    summary: string;
    stepsExecuted: number;
  };
  context: RuntimeContext;
  traces: TraceRecord[];
  events: unknown[];
}

export type AgentRole = "planner" | "executor" | "critic";
export type TraceResultKind = "success" | "partial" | "blocked" | "error" | "canceled";

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
  runId: string;
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
  runId?: string | null;
  sequence?: number | null;
}

export interface McpToolCall {
  id: string;
  taskId: string;
  runId?: string | null;
  tool: string;
  arguments: unknown;
  replay?: McpReplayRef | null;
}

export interface McpToolResult {
  id: string;
  taskId: string;
  tool: string;
  success: boolean;
  resultKind: TraceResultKind;
  content: unknown;
  stdout: string;
  stderr: string;
  latencyMs: number;
  tracePath?: string | null;
  runId: string | null;
  traceSequence: number | null;
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

/**
 * Keep every Git-diff consumer on one stable collection contract. Tauri's
 * native command returns an array, but older/test bridges can legitimately
 * resolve an empty command payload as null. Treat that as an empty diff and
 * discard malformed records before they reach tool formatting or the UI.
 */
export function normalizeGitDiffEntries(payload: unknown): GitDiffEntry[] {
  if (!Array.isArray(payload)) return [];
  const entries: GitDiffEntry[] = [];
  for (const candidate of payload) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) continue;
    const oldText = typeof record.old === "string" ? record.old : "";
    const newText = typeof record.new === "string" ? record.new : "";
    entries.push({
      path,
      status: typeof record.status === "string" && record.status.trim() ? record.status.trim() : "M",
      old: oldText,
      new: newText,
      existed: typeof record.existed === "boolean" ? record.existed : oldText.length > 0,
      fullFile: typeof record.fullFile === "boolean" ? record.fullFile : true,
      ...(record.binary === true ? { binary: true } : {}),
    });
  }
  return entries;
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
  foregroundGeneration?: number;
  foregroundGenerationStartOffset?: number;
}

export interface PtyStatus {
  active: boolean;
  running: boolean;
  pid?: number | null;
  foregroundPid?: number | null;
  shellAvailable?: boolean;
  foregroundState?: "busy" | "idle" | "unknown" | "stopped";
  foregroundGeneration?: number;
  foregroundGenerationStartOffset?: number;
  exitCode?: number | null;
  bufferStartOffset: number;
  bufferEndOffset: number;
  bufferBytes: number;
  tail: string;
}

export interface PtyWriteResult {
  accepted: boolean;
  duplicate: boolean;
  deliveryState: "delivered" | "unknown" | "duplicate";
  foregroundPid?: number | null;
  foregroundState?: "busy" | "idle" | "unknown" | "stopped";
  foregroundGeneration?: number;
  error?: string | null;
}

export interface PtyCloseResult {
  sessionKey: string;
  closed: boolean;
  pid?: number | null;
  exitCode?: number | null;
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

export interface ImageStudioEngineCheckResult {
  ready: boolean;
  message: string;
  capabilities?: Record<string, unknown>;
}

export interface ImageStudioProxyRequestInput {
  engine?: string;
  endpoint: string;
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: string;
  streamId?: string;
}

export interface ImageStudioProxyResponse {
  status: number;
  ok: boolean;
  body: string;
  contentType?: string | null;
}

export interface ImageStudioStreamChunkPayload {
  streamId: string;
  chunk: string;
}

export interface ImageStudioStreamDonePayload {
  streamId: string;
  status: "ok" | "error" | "cancelled";
  error?: string | null;
}

export type WebSearchProvider = "duckduckgo" | "bing" | "baidu";

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  results: WebSearchResultItem[];
  truncated: boolean;
  sourceUrl: string;
  fallbackProvider?: string;
  fallbackReason?: string;
}

export interface WebFetchResponse {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
  charCount: number;
  truncated: boolean;
  source: string;
}

// endregion

// region: 文件与搜索命令

export interface SystemMemoryInfo {
  total_gb: number;
  available_gb: number;
  total_bytes: number;
  available_bytes: number;
}

export function getSystemMemory(): Promise<SystemMemoryInfo> {
  return invoke("get_system_memory");
}

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
  startChar?: number,
): Promise<ReadFileWindowResult> {
  return invoke<ReadFileWindowResult>("read_file_window", {
    path,
    workspace,
    startLine,
    endLine,
    maxLines,
    maxChars,
    startChar,
  });
}

export function webSearch(
  query: string,
  provider?: WebSearchProvider | string,
  maxResults?: number,
): Promise<WebSearchResponse> {
  return invoke<WebSearchResponse>("web_search", { query, provider, maxResults });
}

export function webFetch(url: string, maxChars?: number): Promise<WebFetchResponse> {
  return invoke<WebFetchResponse>("web_fetch", { url, maxChars });
}

export function getFileMetadata(path: string, workspace?: string): Promise<FileMetadata> {
  return invoke<FileMetadata>("get_file_metadata", { path, workspace });
}

export function openFileExternal(path: string, workspace?: string): Promise<OpenFileExternalResult> {
  return invoke<OpenFileExternalResult>("open_file_external", { path, workspace });
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

export function writeFileCreateNew(path: string, content: string, workspace?: string): Promise<void> {
  return invoke<void>("write_file_create_new", { path, content, workspace });
}

export function writeFileAtomic(path: string, content: string, workspace?: string): Promise<void> {
  return invoke<void>("write_file_atomic", { path, content, workspace });
}

export function writeChatTempFile(sessionKey: string, path: string, content: string): Promise<string> {
  return invoke<string>("write_chat_temp_file", { sessionKey, path, content });
}

export function writeChatTempFileCreateNew(
  sessionKey: string,
  path: string,
  content: string,
): Promise<string> {
  return invoke<string>("write_chat_temp_file_create_new", { sessionKey, path, content });
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

export function checkImageStudioEngine(config: { engine: string; endpoint: string }): Promise<ImageStudioEngineCheckResult> {
  return invoke<ImageStudioEngineCheckResult>("check_image_studio_engine", {
    engine: config.engine,
    endpoint: config.endpoint,
  });
}

export function proxyImageStudioRequest(input: ImageStudioProxyRequestInput): Promise<ImageStudioProxyResponse> {
  return invoke<ImageStudioProxyResponse>("proxy_image_studio_request", input as unknown as Record<string, unknown>);
}

export function cancelImageStudioJob(): Promise<void> {
  return invoke<void>("cancel_image_studio_job");
}

export function saveImageStudioOutput(sessionKey: string, fileName: string, dataUrl: string): Promise<string> {
  return invoke<string>("save_image_studio_output", { sessionKey, fileName, dataUrl });
}

export function saveImageStudioRemoteOutput(sessionKey: string, fileName: string, imageUrl: string): Promise<string> {
  return invoke<string>("save_image_studio_remote_output", { sessionKey, fileName, imageUrl });
}

export function openImageStudioOutput(path: string): Promise<OpenFileExternalResult> {
  return invoke<OpenFileExternalResult>("open_image_studio_output", { path });
}

export function listenImageStudioStreamChunk(
  handler: (payload: ImageStudioStreamChunkPayload) => void,
): Promise<UnlistenFn> {
  return listen<ImageStudioStreamChunkPayload>("image-studio-stream-chunk", (event) => handler(event.payload));
}

export function listenImageStudioStreamDone(
  handler: (payload: ImageStudioStreamDonePayload) => void,
): Promise<UnlistenFn> {
  return listen<ImageStudioStreamDonePayload>("image-studio-stream-done", (event) => handler(event.payload));
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

export async function listProjectSessions(workspace: string): Promise<any[]> {
  const sessions = await invoke<any[]>("list_project_sessions", { workspace });
  rememberProjectSessionList(workspace, sessions);
  return sessions;
}

export async function rebuildProjectSessionsIndex(workspace: string): Promise<any[]> {
  const sessions = await invoke<any[]>("rebuild_project_sessions_index", { workspace });
  rememberProjectSessionList(workspace, sessions);
  return sessions;
}

export function saveProjectSession(
  workspace: string,
  session: any,
  options?: ProjectSessionSaveOptions & { allowPersistingWorkspaceReceiptId?: string },
): Promise<any> {
  const sessionId = String(session?.id ?? "unknown");
  const ownerKey = projectSessionOwnerKey(workspace, sessionId);
  const capturedStorageRevision = normalizeProjectSessionStorageRevision(
    session?.storageRevision,
  ) ?? 0;
  const cachedRevisionAtEnqueue = projectSessionRevisionByOwner.get(ownerKey);
  // A caller already behind the known owner revision is a genuine stale
  // write. Preserve its revision so SQLite can reject it instead of silently
  // rebasing stale content over a newer snapshot.
  const mayAdvanceQueuedRevision = cachedRevisionAtEnqueue === undefined ||
    capturedStorageRevision === cachedRevisionAtEnqueue;
  const isCurrent = () => (
    isProjectSessionAdmissionProjectionOwned(
      session,
      options?.allowPersistingWorkspaceReceiptId,
    ) &&
    (options?.isCurrent ? options.isCurrent() : true)
  );
  return projectSessionMutations.save(
    ownerKey,
    async (lease) => {
      // The coordinator serializes the writes, but callers construct their
      // snapshots before entering that queue. Resolve the CAS revision only
      // when this owner reaches the queue head so two snapshots captured from
      // revision N are persisted with expected revisions N and N + 1. The
      // enqueue-time fence above deliberately excludes already-stale callers.
      let existingSession: any = null;
      let reconciledStorageRevision: number | null = null;
      if (projectSessionSaveNeedsTranscriptBase(session)) {
        existingSession = await invoke<any>("load_project_session", {
          workspace,
          sessionId,
        });
        rememberProjectSessionRevision(ownerKey, existingSession);
        if (lease.revisionReconciliationRequired) {
          reconciledStorageRevision = normalizeProjectSessionStorageRevision(
            existingSession?.storageRevision,
          ) ?? 0;
        }
      } else if (lease.revisionReconciliationRequired) {
        // A previous invoke crossed the JavaScript settlement boundary. It
        // may have committed before its response was lost, so refresh Rust's
        // authoritative CAS revision before this writer selects its base.
        const meta = await invoke<any>("load_project_session_meta", {
          workspace,
          sessionId,
        });
        rememberProjectSessionRevision(ownerKey, meta);
        reconciledStorageRevision = normalizeProjectSessionStorageRevision(
          meta?.storageRevision,
        ) ?? 0;
      }
      const storageRevision = mayAdvanceQueuedRevision
        ? reconciledStorageRevision ??
          projectSessionRevisionByOwner.get(ownerKey) ??
          capturedStorageRevision
        : capturedStorageRevision;
      const queuedSession = {
        ...prepareProjectSessionSnapshotForSave(session, existingSession),
        storageRevision,
      };
      const saved = await invoke<any>("save_project_session", {
        workspace,
        session: queuedSession,
        mutationDeadlineMs: lease.mutationDeadlineMs,
      });
      rememberProjectSessionRevision(ownerKey, saved);
      return saved;
    },
    {
      isCurrent,
      settlementTimeoutMs: options?.settlementTimeoutMs,
    },
  );
}

export async function loadProjectSession(workspace: string, sessionId: number | string): Promise<any> {
  const session = await invoke<any>("load_project_session", { workspace, sessionId });
  rememberProjectSessionRevision(projectSessionOwnerKey(workspace, sessionId), session);
  return session;
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

export async function loadProjectSessionMeta(workspace: string, sessionId: number | string): Promise<any> {
  const session = await invoke<any>("load_project_session_meta", { workspace, sessionId });
  rememberProjectSessionRevision(projectSessionOwnerKey(workspace, sessionId), session);
  return session;
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
  const ownerKey = projectSessionOwnerKey(workspace, sessionId);
  return projectSessionMutations.delete(ownerKey, async () => {
    const sessions = await invoke<any[]>("delete_project_session", { workspace, sessionId });
    clearProjectSessionRevision(ownerKey);
    rememberProjectSessionList(workspace, sessions);
    return sessions;
  });
}

export function clearProjectSessions(
  workspace: string,
  sessionIds: readonly (number | string)[] = [],
): Promise<void> {
  const ownerKeys = sessionIds.map((sessionId) => projectSessionOwnerKey(workspace, sessionId));
  return projectSessionMutations.clear(workspace, ownerKeys, async () => {
    await invoke<void>("clear_project_sessions", { workspace });
    clearWorkspaceProjectSessionRevisions(workspace);
  });
}

export function exportTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("export_text_file", { path, content });
}

export async function listDirectory(path: string, workspace?: string): Promise<FileNode[]> {
  const result = await invoke<unknown>("list_directory", { path, workspace });
  return Array.isArray(result)
    ? result.filter((entry): entry is FileNode => !!entry && typeof entry === "object")
    : [];
}

export async function globSearch(pattern: string, workspace?: string): Promise<string[]> {
  const result = await invoke<unknown>("glob_search", { pattern, workspace });
  return Array.isArray(result)
    ? result.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function grepSearch(query: string, path: string, workspace?: string): Promise<string> {
  return invoke<string>("grep_search", { query, path, workspace });
}

export async function getProjectSkeleton(depth?: number, workspace?: string): Promise<string> {
  const result = await invoke<unknown>("get_project_skeleton", { depth, workspace });
  return typeof result === "string" ? result : "";
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

export function knowledgeListBases(): Promise<KnowledgeBase[]> {
  return invoke<KnowledgeBase[]>("knowledge_list_bases");
}

export function knowledgeCreateBase(name: string, description?: string): Promise<KnowledgeBase> {
  return invoke<KnowledgeBase>("knowledge_create_base", { name, description });
}

export function knowledgeSetBaseEnabled(kbId: string, enabled: boolean): Promise<KnowledgeBase> {
  return invoke<KnowledgeBase>("knowledge_set_base_enabled", { kbId, enabled });
}

export function knowledgeDeleteBase(kbId: string): Promise<void> {
  return invoke<void>("knowledge_delete_base", { kbId });
}

export function knowledgeListSources(kbId: string): Promise<KnowledgeSource[]> {
  return invoke<KnowledgeSource[]>("knowledge_list_sources", { kbId });
}

export function knowledgeImportSource(
  kbId: string,
  path: string,
  workspace?: string,
): Promise<KnowledgeImportResult> {
  return invoke<KnowledgeImportResult>("knowledge_import_source", { kbId, path, workspace });
}

export function knowledgeRebuildBase(kbId: string): Promise<KnowledgeBase> {
  return invoke<KnowledgeBase>("knowledge_rebuild_base", { kbId });
}

export function knowledgeSearch(
  query: string,
  kbIds?: string[],
  limit?: number,
): Promise<KnowledgeSearchResult> {
  return invoke<KnowledgeSearchResult>("knowledge_search", { query, kbIds, limit });
}

export function knowledgeGetExcerpt(
  sourceId: string,
  chunkId: string,
): Promise<KnowledgeSearchHit | null> {
  return invoke<KnowledgeSearchHit | null>("knowledge_get_excerpt", { sourceId, chunkId });
}

export function knowledgeImportUrl(
  kbId: string,
  url: string,
  recursive: boolean,
  maxDepth?: number,
  maxPages?: number,
): Promise<KnowledgeBase> {
  return invoke<KnowledgeBase>("knowledge_import_url", {
    kbId,
    url,
    recursive,
    maxDepth,
    maxPages,
  });
}

export function knowledgeCancelImportUrl(kbId: string): Promise<void> {
  return invoke<void>("knowledge_cancel_import_url", { kbId });
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
  permissionApproval?: ShellPermissionApproval,
  workingDirectory?: string,
): Promise<TerminalCommandOutput> {
  return invoke<TerminalCommandOutput>("run_command", {
    command,
    input,
    timeoutMs,
    workspace,
    permissionApproval,
    workingDirectory,
  });
}

export function browserEvaluate(
  input: BrowserEvaluateInput,
  workspace?: string,
): Promise<BrowserEvaluateResult> {
  return invoke<BrowserEvaluateResult>("browser_evaluate", {
    url: input.url,
    actions: input.actions,
    checks: input.checks,
    waitForText: input.waitForText,
    waitForSelector: input.waitForSelector,
    screenshot: input.screenshot,
    failOnConsoleError: input.failOnConsoleError,
    timeoutMs: input.timeoutMs,
    workspace,
  });
}

export function computerUse(
  input: ComputerUseInput,
  workspace?: string,
): Promise<ComputerUseResult> {
  return invoke<ComputerUseResult>("computer_use", {
    appName: input.appName,
    appPath: input.appPath,
    launch: input.launch,
    activate: input.activate,
    actions: input.actions,
    checks: input.checks,
    screenshot: input.screenshot,
    timeoutMs: input.timeoutMs,
    workspace,
  });
}

export function shellPermissionPreflight(
  command: string,
  workspace?: string,
): Promise<ShellPermissionDecision> {
  return invoke<ShellPermissionDecision>("shell_permission_preflight", {
    command,
    workspace,
  });
}

export function buildRepositoryIndex(workspace?: string): Promise<RepositoryIndex> {
  return invoke<RepositoryIndex>("build_repository_index", { workspace });
}

export function codeAstQuery(input: {
  path: string;
  query?: string;
  kinds?: string;
  maxResults?: number;
}, workspace?: string): Promise<AstQueryResult> {
  return invoke<AstQueryResult>("code_ast_query", {
    path: input.path,
    query: input.query,
    kinds: input.kinds,
    maxResults: input.maxResults,
    workspace,
  });
}

export function checkSourceSyntax(
  path: string,
  content: string,
): Promise<SourceSyntaxCheckResult> {
  return invoke<SourceSyntaxCheckResult>("check_source_syntax", {
    path,
    content,
  });
}

export function findSymbolReferences(input: {
  symbol: string;
  path?: string;
  maxResults?: number;
}, workspace?: string): Promise<SymbolReferencesResult> {
  return invoke<SymbolReferencesResult>("find_symbol_references", {
    symbol: input.symbol,
    path: input.path,
    maxResults: input.maxResults,
    workspace,
  });
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

export function runRuntimeHarness(
  request: RuntimeHarnessRequest,
  workspace?: string,
): Promise<RuntimeHarnessReport> {
  return invoke<RuntimeHarnessReport>("run_runtime_harness", { request, workspace });
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

export async function getGitDiff(workspace: string, path?: string, filter?: string): Promise<GitDiffEntry[]> {
  const payload = await invoke<unknown>("get_git_diff", { workspace, path, filter });
  return normalizeGitDiffEntries(payload);
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

export function closePty(sessionKey?: string): Promise<PtyCloseResult> {
  return invoke<PtyCloseResult>("close_pty", { sessionKey });
}

export function resizePty(cols: number, rows: number, sessionKey?: string): Promise<void> {
  return invoke<void>("resize_pty", { cols, rows, sessionKey });
}

export function writePty(
  input: string,
  sessionKey?: string,
  permissionApproval?: ShellPermissionApproval,
  workingDirectory?: string,
  userTerminal?: boolean,
  allowForegroundInput?: boolean,
  expectedForegroundPid?: number,
  expectedForegroundGeneration?: number,
  controlId?: string,
): Promise<PtyWriteResult> {
  return invoke<PtyWriteResult>("write_pty", {
    input,
    sessionKey,
    permissionApproval,
    workingDirectory,
    userTerminal,
    allowForegroundInput,
    expectedForegroundPid,
    expectedForegroundGeneration,
    controlId,
  });
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
