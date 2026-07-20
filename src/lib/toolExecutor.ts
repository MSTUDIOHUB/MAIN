// lib/toolExecutor.ts
// Routes agent tool calls to the correct execution backend.
// ALL file operations go through Tauri IPC (invoke) to the Rust backend,
// which uses std::fs and enforces workspace-scoped path safety.
// This avoids tauri-plugin-fs permission dialogs entirely.
// ────────────────────────────────────────────────────────────────────

import {
  analyzeTabularDocument,
  deleteWorkspacePath,
  deleteChatTempPath,
  getChatTempRoot,
  globSearch,
  grepSearch,
  indexWorkspaceDocuments,
  knowledgeGetExcerpt,
  knowledgeSearch,
  queryTabularDocument,
  readChatTempFile,
  spawnPty,
  writePty,
  readPtyBuffer,
  readPtyTail,
  readPtySince,
  browserEvaluate,
  computerUse,
  codeAstQuery,
  getPtyStatus,
  findSymbolReferences,
  runCommand,
  getFileOutline,
  getFileMetadata,
  ingestAttachmentFile,
  readFile,
  readFileWindow,
  readDocument,
  webFetch,
  webSearch,
  writeChatTempFile,
  writeChatTempFileCreateNew,
  writeFile,
  writeFileCreateNew,
  type ShellPermissionApproval,
} from "./ipc";
import { isChatAttachmentPath } from "./attachments";
import { invoke } from "@tauri-apps/api/core";
import { isMcpTool, executeMcpTool, getMcpServerUrl } from "./mcpClient";
import { isBuiltInToolName, type ToolCatalog } from "./toolCatalog";
import {
  classifyBuiltInTool,
  classifyMcpToolName,
  isRiskAutoExecutable,
  normalizeLocalFileReadPath,
} from "./toolCapabilities";
import { applyShellCwd } from "./toolExecutionContract";
import { formatDirectoryNodesForTool } from "./workspacePaths";
import { formatReadFileWindowForModel, formatReadFileWindowPayloadForModel } from "./readFileWindow";
import { applyWorkspacePatch, summarizeApplyPatchTarget } from "./applyPatchTool";
import { repoMapContext, repoMapFiles, repoMapImpact, repoMapSearch, repoMapStatus } from "./repoMapTools";
import { sanitizePtyOutput } from "./ptyOutputSanitizer";
import {
  buildPtyShellLaunchError,
  buildUnconfirmedPtyCommandError,
  buildPtyControlId,
  describePtyControlEffect,
  hasActivePtyForeground,
  normalizePtyInput,
  resolvePtyCommandAdmission,
} from "./ptyCommandRuntime";
import { runGitDiffTool, runGitStatusTool } from "./gitTools";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitizes raw PTY output by stripping ANSI escape sequences and
 * resolving carriage returns (\r) to avoid progress bar string inflation.
 */
function sanitizePtyResult<T extends { text?: string; tail?: string }>(result: T): T {
  if (!result) return result;
  return {
    ...result,
    ...(typeof result.text === "string" ? { text: sanitizePtyOutput(result.text) } : {}),
    ...(typeof result.tail === "string" ? { tail: sanitizePtyOutput(result.tail) } : {}),
  };
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseOptionalStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value !== "string") return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const LOCAL_FILE_READ_TOOLS = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
]);

const GLOBAL_CHAT_CONTEXT_READ_TOOLS = new Set([
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
]);

const WORKSPACE_REQUIRED_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "code_ast_query",
  "find_symbol_references",
  "get_project_skeleton",
  "get_file_outline",
  "index_workspace_documents",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "git_status",
  "git_diff",
  "delete_workspace_path",
  "run_command",
  "browser_evaluate",
  "computer_use",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

function isMissingPtySessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /PTY.*(?:尚未启动|not started|not active)/i.test(message);
}

async function ensurePtySession(
  sessionKey: string | undefined,
  workspace: string,
) {
  let status = await getPtyStatus(sessionKey).catch(() => null);
  if (!status?.active || !status.running) {
    await spawnPty(140, 40, sessionKey, workspace);
    status = await getPtyStatus(sessionKey);
  }
  return status;
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function pathStartsWithRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeLocalFileReadPath(path);
  const normalizedRoot = normalizeLocalFileReadPath(root);
  if (!normalizedPath || !normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function shouldReturnRawReadFile(args: Record<string, unknown>): boolean {
  return args.__raw === true || args.__raw === "true";
}

function parseWindowLineArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = parseOptionalNumber(args[key]);
  if (value === undefined) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function shouldUseChatTempStorage(workspace: string, sessionKey?: string): boolean {
  return !workspace.trim() && !!sessionKey;
}

function isGlobalChatContextReadToolCall(
  name: string,
  args: Record<string, unknown>,
  sessionKey?: string,
): boolean {
  if (!GLOBAL_CHAT_CONTEXT_READ_TOOLS.has(name) || !sessionKey) return false;
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  return !!rawPath && isChatAttachmentPath(rawPath);
}

function assertWorkspaceAvailableForTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  sessionKey?: string,
): void {
  if (workspace.trim()) return;
  if (isGlobalChatContextReadToolCall(name, args, sessionKey)) return;
  if (!WORKSPACE_REQUIRED_TOOL_NAMES.has(name) && !GLOBAL_CHAT_CONTEXT_READ_TOOLS.has(name)) return;
  throw new Error(
    `WORKSPACE_REQUIRED_FOR_TOOL: ${name} requires an active workspace. Global Chat can only read explicitly attached chat files; open a project conversation or attach/@ a specific file first.`,
  );
}

function isMissingReadFileWindowCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /read_file_window/i.test(message) && /(unknown|not found|unhandled|not implemented|command)/i.test(message);
}

async function resolveWorkspaceForReadPath(
  rawPath: string,
  workspace: string,
  sessionKey?: string,
): Promise<string> {
  if (sessionKey && isChatAttachmentPath(rawPath)) {
    return await getChatTempRoot(sessionKey);
  }
  return workspace;
}

function buildChatTempSuccessMessage(
  action: "written" | "updated",
  requestedPath: string,
  temporaryPath: string,
): string {
  const verb = action === "written" ? "written" : "updated";
  return [
    `File ${requestedPath} was ${verb} in the temporary chat .tmp workspace.`,
    `Temporary path: ${temporaryPath}`,
    "Next: save/export it to a local folder, then continue from that folder.",
  ].join("\n");
}

export interface ToolExecutionOptions {
  allowExternalLocalRead?: boolean;
  shellPermissionApproval?: ShellPermissionApproval;
  toolCatalog?: ToolCatalog;
}

async function prepareExternalLocalReadArgs(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  sessionKey?: string,
  options: ToolExecutionOptions = {},
): Promise<{
  args: Record<string, unknown>;
  workspace: string;
  externalLocalReadIngested?: boolean;
}> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!LOCAL_FILE_READ_TOOLS.has(name) || !rawPath || !isAbsoluteLocalPath(rawPath)) {
    return { args, workspace };
  }
  if (workspace && pathStartsWithRoot(rawPath, workspace)) {
    return { args, workspace };
  }
  if (!sessionKey) {
    throw new Error("Reading a local file outside the workspace requires an active session.");
  }
  if (!options.allowExternalLocalRead) {
    throw new Error("Reading a local file outside the workspace requires user approval.");
  }

  const ingested = await ingestAttachmentFile(sessionKey, rawPath);
  return {
    args: {
      ...args,
      path: ingested.path,
    },
    workspace: ingested.workspace,
    externalLocalReadIngested: true,
  };
}

/**
 * Execute a tool by name and return the result.
 *
 * - Read-only tools (list_directory, read_file, read_document, glob_search, grep_search):
 *   auto-execute without user review.
 *
 * - replace_in_file / write_file: routed through workspace-safe IPC.
 *
 * - execute_command / read_pty_buffer: routed through PTY IPC.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  sessionKey?: string,
  options: ToolExecutionOptions = {},
): Promise<unknown> {
  let executionName = name;
  if (options.toolCatalog) {
    const resolution = options.toolCatalog.lookup(name);
    if (resolution.status === "ambiguous") {
      throw new Error(
        `AMBIGUOUS_TOOL: "${name}" matches ${resolution.candidates.map((entry) => entry.canonicalName).join(", ")}.`,
      );
    }
    if (resolution.status === "unknown") {
      throw new Error(`UNKNOWN_TOOL: "${name}" is not registered for this Turn.`);
    }
    executionName = resolution.entry.executionName;
    if (resolution.entry.source === "mcp") {
      if (!resolution.entry.serverUrl) {
        throw new Error(`MCP server URL not found for tool "${resolution.entry.canonicalName}".`);
      }
      return await executeMcpTool(
        resolution.entry.serverUrl,
        resolution.entry.executionName,
        args,
      );
    }
    if (resolution.entry.source === "skill") {
      if (!resolution.entry.skillId) {
        throw new Error(
          `SKILL_IDENTITY_REQUIRED: "${resolution.entry.canonicalName}" has no stable Skill identity.`,
        );
      }
      try {
        return await invoke<string>("execute_skill", {
          name: resolution.entry.executionName,
          skillId: resolution.entry.skillId,
          packagePath: resolution.entry.packagePath ?? null,
          entryPoint: resolution.entry.entryPoint ?? null,
          args,
        });
      } catch (err) {
        const msg = (err as Error).message || String(err);
        if (msg.includes("not found") || msg.includes("Unknown")) {
          throw new Error(
            `Skill tool "${resolution.entry.executionName}" is not registered in the backend. ` +
            `MAIN currently exposes Tool Skills as function schemas only; real execution needs a built-in tool, MCP tool, or a Rust "execute_skill" handler.`
          );
        }
        throw new Error(`Skill tool "${resolution.entry.executionName}" execution failed: ${msg}`);
      }
    }
  }

  // ── MCP tool routing ────────────────────────────────────────
  // If the tool was discovered from an MCP server, forward the call
  // via HTTP JSON-RPC to that server instead of using Tauri IPC.
  // Built-ins own their bare names even while legacy callers still rely on
  // the process-wide MCP map. Turn execution uses the ToolCatalog above.
  if (!isBuiltInToolName(name) && isMcpTool(name)) {
    const serverUrl = getMcpServerUrl(name);
    if (!serverUrl) {
      throw new Error(`MCP server URL not found for tool "${name}". The server may have been disconnected.`);
    }
    return await executeMcpTool(serverUrl, name, args);
  }

  name = executionName;

  const prepared = await prepareExternalLocalReadArgs(name, args, workspace, sessionKey, options);
  args = prepared.args;
  workspace = prepared.workspace;
  const effectiveSessionKey = prepared.externalLocalReadIngested ? undefined : sessionKey;
  assertWorkspaceAvailableForTool(name, args, workspace, effectiveSessionKey);

  switch (name) {
    // ── Tauri IPC (std::fs on Rust side) ──────────────────────

    case "list_directory": {
      const rawPath = (args.path as string) || ".";
      const dirPath = rawPath === "." ? workspace : rawPath;
      const nodes = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>("list_directory", { path: dirPath, workspace });
      return formatDirectoryNodesForTool(nodes, workspace);
    }

    case "read_file": {
      const rawPath = (args.path as string) || "";
      const readWorkspace = await resolveWorkspaceForReadPath(rawPath, workspace, effectiveSessionKey);
      const startLine = parseWindowLineArg(args, "start_line");
      const endLine = parseWindowLineArg(args, "end_line");
      const maxLines = parseWindowLineArg(args, "max_lines");
      const maxChars = parseWindowLineArg(args, "max_chars");
      let content: string;
      if (shouldReturnRawReadFile(args)) {
        if (readWorkspace !== workspace) {
          content = await readFile(rawPath, readWorkspace);
        } else if (shouldUseChatTempStorage(workspace, sessionKey)) {
          content = await readChatTempFile(sessionKey!, rawPath);
        } else {
          content = await readFile(rawPath, workspace);
        }
        return content;
      }

      if (readWorkspace !== workspace || !shouldUseChatTempStorage(workspace, sessionKey)) {
        try {
          const payload = await readFileWindow(
            rawPath,
            readWorkspace,
            startLine,
            endLine,
            maxLines,
            maxChars,
          );
          return formatReadFileWindowPayloadForModel(rawPath, payload, args);
        } catch (error) {
          if (!isMissingReadFileWindowCommand(error)) throw error;
          content = await readFile(rawPath, readWorkspace);
          return formatReadFileWindowForModel(rawPath, content, args);
        }
      }

      if (readWorkspace !== workspace) {
        content = await readFile(rawPath, readWorkspace);
      } else if (shouldUseChatTempStorage(workspace, sessionKey)) {
        content = await readChatTempFile(sessionKey!, rawPath);
      } else {
        content = await readFile(rawPath, workspace);
      }
      return formatReadFileWindowForModel(rawPath, content, args);
    }

    case "read_document": {
      const rawPath = (args.path as string) || "";
      if (!rawPath) throw new Error("Missing required parameter 'path'.");
      const readWorkspace = await resolveWorkspaceForReadPath(rawPath, workspace, effectiveSessionKey);
      return await readDocument(
        rawPath,
        parseOptionalNumber(args.max_chars),
        parseOptionalNumber(args.max_blocks),
        parseOptionalNumber(args.row_offset),
        parseOptionalNumber(args.max_rows),
        parseOptionalString(args.sheet),
        readWorkspace,
      );
    }

    case "analyze_tabular_document": {
      const rawPath = (args.path as string) || "";
      if (!rawPath) throw new Error("Missing required parameter 'path'.");
      const readWorkspace = await resolveWorkspaceForReadPath(rawPath, workspace, effectiveSessionKey);
      return await analyzeTabularDocument(
        rawPath,
        parseOptionalString(args.sheet),
        parseOptionalNumber(args.max_columns),
        parseOptionalNumber(args.sample_rows),
        parseOptionalString(args.focus_columns),
        readWorkspace,
      );
    }

    case "query_tabular_document": {
      const rawPath = (args.path as string) || "";
      if (!rawPath) throw new Error("Missing required parameter 'path'.");
      const readWorkspace = await resolveWorkspaceForReadPath(rawPath, workspace, effectiveSessionKey);
      return await queryTabularDocument(
        rawPath,
        parseOptionalString(args.sheet),
        parseOptionalString(args.select_columns),
        parseOptionalString(args.filters),
        parseOptionalString(args.filter_logic),
        parseOptionalString(args.group_by),
        parseOptionalString(args.aggregations),
        parseOptionalString(args.sort_by),
        parseOptionalNumber(args.row_offset),
        parseOptionalNumber(args.limit),
        readWorkspace,
      );
    }

    // ── Custom Tauri IPC commands ─────────────────────────────

    case "glob_search":
      return await globSearch(args.pattern as string, workspace);

    case "grep_search": {
      const query = args.query as string;
      const path = (args.path as string) || ".";
      return await grepSearch(query, path, workspace);
    }

    case "web_search": {
      const query = parseOptionalString(args.query);
      if (!query) throw new Error("Missing required parameter 'query'.");
      return await webSearch(
        query,
        parseOptionalString(args.provider),
        parseOptionalNumber(args.max_results ?? args.maxResults),
      );
    }

    case "web_fetch": {
      const url = parseOptionalString(args.url);
      if (!url) throw new Error("Missing required parameter 'url'.");
      return await webFetch(url, parseOptionalNumber(args.max_chars ?? args.maxChars));
    }

    case "repo_map_status":
      return await repoMapStatus(workspace);

    case "repo_map_search":
      return await repoMapSearch(args, workspace);

    case "repo_map_context":
      return await repoMapContext(args, workspace);

    case "repo_map_files":
      return await repoMapFiles(args, workspace);

    case "repo_map_impact":
      return await repoMapImpact(args, workspace);

    case "code_ast_query": {
      const path = parseOptionalString(args.path);
      if (!path) throw new Error("Missing required parameter 'path'.");
      return JSON.stringify(await codeAstQuery({
        path,
        query: parseOptionalString(args.query),
        kinds: parseOptionalString(args.kinds),
        maxResults: parseOptionalNumber(args.max_results ?? args.maxResults),
      }, workspace));
    }

    case "find_symbol_references": {
      const symbol = parseOptionalString(args.symbol);
      if (!symbol) throw new Error("Missing required parameter 'symbol'.");
      return JSON.stringify(await findSymbolReferences({
        symbol,
        path: parseOptionalString(args.path),
        maxResults: parseOptionalNumber(args.max_results ?? args.maxResults),
      }, workspace));
    }

    case "git_status":
      return await runGitStatusTool(
        workspace,
        !(args.include_stats === false || args.include_stats === "false"),
      );

    case "git_diff":
      return await runGitDiffTool(args, workspace);

    case "execute_command": {
      const command = applyShellCwd((args.command as string) || "", args, workspace);
      if (!command) throw new Error("Missing required parameter 'command'.");
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 4000, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let initialStatus = await ensurePtySession(sessionKey, workspace);
      const admission = resolvePtyCommandAdmission(initialStatus);
      if (!admission.allowed) throw new Error(admission.reason);
      let beforeOffset = initialStatus.bufferEndOffset;
      try {
        await writePty(command + "\n", sessionKey, options.shellPermissionApproval);
      } catch (error) {
        if (!isMissingPtySessionError(error)) throw error;
        await spawnPty(140, 40, sessionKey, workspace);
        initialStatus = await getPtyStatus(sessionKey);
        beforeOffset = initialStatus.bufferEndOffset;
        await writePty(command + "\n", sessionKey, options.shellPermissionApproval);
      }
      await sleep(waitMs);
      let output = await readPtySince(beforeOffset, maxChars, sessionKey);

      // Adaptive extend: if the PTY buffer is still growing, wait more
      // to capture ongoing output (up to 2 extra rounds of 2000ms each).
      const maxExtends = 2;
      const extendMs = 2000;
      let extendCount = 0;
      let statusAfter = await getPtyStatus(sessionKey);
      while (extendCount < maxExtends) {
        if (statusAfter.bufferEndOffset <= output.endOffset) break;
        await sleep(extendMs);
        const extendedOutput = await readPtySince(output.endOffset, maxChars, sessionKey);
        if (!extendedOutput.text.trim()) break;
        output = {
          text: output.text + extendedOutput.text,
          startOffset: output.startOffset,
          endOffset: extendedOutput.endOffset,
          truncated: output.truncated || extendedOutput.truncated,
          bufferStartOffset: output.bufferStartOffset,
          bufferEndOffset: extendedOutput.bufferEndOffset,
        };
        extendCount++;
        statusAfter = await getPtyStatus(sessionKey);
      }

      const sanitizedOutput = sanitizePtyOutput(output.text);
      const shellLaunchError = buildPtyShellLaunchError(sanitizedOutput);
      if (shellLaunchError) throw new Error(shellLaunchError);
      const unconfirmedError = buildUnconfirmedPtyCommandError(command, sanitizedOutput);
      if (unconfirmedError) throw new Error(unconfirmedError);

      return JSON.stringify({
        command,
        output: sanitizedOutput,
        startOffset: output.startOffset,
        endOffset: output.endOffset,
        truncated: output.truncated,
        foregroundPid: statusAfter.foregroundPid ?? null,
        shellAvailable: statusAfter.shellAvailable ?? null,
        foregroundState: statusAfter.foregroundState ?? null,
        foregroundGeneration: statusAfter.foregroundGeneration ?? null,
        commandAccepted: true,
        note: "If the process is still running or output is incomplete, call read_pty_since with endOffset or read_pty_tail.",
      });
    }

    case "read_pty_buffer": {
      const [text, status] = await Promise.all([
        readPtyBuffer(parseOptionalNumber(args.max_chars), sessionKey),
        getPtyStatus(sessionKey),
      ]);
      return JSON.stringify(sanitizePtyResult({
        ...status,
        text,
        startOffset: status.bufferStartOffset,
        endOffset: status.bufferEndOffset,
        truncated: false,
      }));
    }

    case "read_pty_tail":
      await sleep(Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 0, 0), 30_000));
      return sanitizePtyResult(await readPtyTail(parseOptionalNumber(args.max_chars), sessionKey));

    case "read_pty_since": {
      const offset = parseOptionalNumber(args.offset);
      if (offset === undefined) throw new Error("Missing required parameter 'offset'.");
      await sleep(Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 0, 0), 30_000));
      return sanitizePtyResult(await readPtySince(offset, parseOptionalNumber(args.max_chars), sessionKey));
    }

    case "get_pty_status":
      await sleep(Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 0, 0), 30_000));
      return sanitizePtyResult(await getPtyStatus(sessionKey));

    case "send_pty_input": {
      const rawInput = typeof args.input === "string" ? args.input : "";
      const requestedControl = typeof args.control === "string" ? args.control : undefined;
      if (!rawInput && !requestedControl) throw new Error("Missing required parameter 'input' or 'control'.");
      const normalizedInput = normalizePtyInput(rawInput, requestedControl);
      const appendNewline = args.append_newline === true || args.append_newline === "true";
      if (requestedControl && rawInput) {
        const rawOnly = normalizePtyInput(rawInput);
        if (rawOnly.controlAction !== normalizedInput.controlAction) {
          throw new Error("PTY_CONTROL_INPUT_CONFLICT: control and input describe different PTY actions.");
        }
      }
      if (normalizedInput.controlAction && appendNewline) {
        throw new Error("PTY_CONTROL_NEWLINE_FORBIDDEN: control actions cannot append a newline.");
      }
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 500, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      const statusBefore = await getPtyStatus(sessionKey);
      if (!hasActivePtyForeground(statusBefore)) {
        if (normalizedInput.controlAction) {
          // Interrupt/EOF controls are idempotent lifecycle requests. If the
          // foreground has already gone away, the requested end state is
          // satisfied; turning this into a tool failure makes weaker models
          // resend the same control until the repetition guard stops the run.
          return JSON.stringify({
            input: normalizedInput.displayValue,
            accepted: true,
            duplicate: true,
            controlAction: normalizedInput.controlAction,
            controlEffect: "foreground_released",
            deliveryState: "not_needed",
            normalizedAlias: normalizedInput.normalizedAlias,
            foregroundPidBefore: statusBefore.foregroundPid ?? null,
            foregroundStateBefore: statusBefore.foregroundState ?? null,
            foregroundGeneration: statusBefore.foregroundGeneration ?? null,
            shellAvailableBefore: statusBefore.shellAvailable ?? null,
            ptyRunningAfter: statusBefore.running ?? null,
            exitCodeAfter: statusBefore.exitCode ?? null,
            nextAction: "Observe with get_pty_status/read_pty_since or continue the next task; do not resend this control.",
          });
        }
        throw new Error(
          "PTY_INPUT_NO_ACTIVE_FOREGROUND: send_pty_input requires an existing foreground process. " +
          "Do not create a shell or type into an idle prompt; use execute_command for a new command.",
        );
      }
      const controlId = normalizedInput.controlAction
        ? buildPtyControlId({
          sessionKey: sessionKey || workspace,
          action: normalizedInput.controlAction,
          status: statusBefore,
        })
        : undefined;
      const beforeOffset = statusBefore.bufferEndOffset;
      let writeResult: Awaited<ReturnType<typeof writePty>> | undefined;
      try {
        writeResult = await writePty(
          normalizedInput.value + (appendNewline ? "\n" : ""),
          sessionKey,
          options.shellPermissionApproval,
          false,
          true,
          typeof statusBefore.foregroundPid === "number" ? statusBefore.foregroundPid : undefined,
          typeof statusBefore.foregroundGeneration === "number" ? statusBefore.foregroundGeneration : undefined,
          controlId,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "");
        if (!normalizedInput.controlAction || /PTY_(?:INPUT_NO_ACTIVE_FOREGROUND|FOREGROUND_CHANGED|CONTROL_INPUT_CONFLICT|CONTROL_NEWLINE_FORBIDDEN)/.test(message)) {
          throw error;
        }
        // Once a control write crosses the IPC boundary, a transport rejection
        // cannot prove that the byte was not delivered. Report an accepted
        // attempt with unknown delivery so the model does not replay Ctrl+C.
        return JSON.stringify({
          input: normalizedInput.displayValue,
          accepted: true,
          controlAction: normalizedInput.controlAction,
          controlEffect: "status_unknown",
          deliveryState: "unknown",
          controlId,
          observationError: message || "PTY control delivery could not be observed.",
          foregroundPidBefore: statusBefore.foregroundPid ?? null,
          foregroundGeneration: statusBefore.foregroundGeneration ?? null,
        });
      }
      await sleep(waitMs);
      let output: Awaited<ReturnType<typeof readPtySince>> | null = null;
      let statusAfter: Awaited<ReturnType<typeof getPtyStatus>> | null = null;
      const observationErrors: string[] = [];
      try {
        output = await readPtySince(beforeOffset, maxChars, sessionKey);
      } catch (error) {
        observationErrors.push(error instanceof Error ? error.message : String(error || ""));
      }
      try {
        statusAfter = await getPtyStatus(sessionKey);
      } catch (error) {
        observationErrors.push(error instanceof Error ? error.message : String(error || ""));
      }
      const controlEffect = normalizedInput.controlAction
        ? statusAfter
          ? describePtyControlEffect({ before: statusBefore, after: statusAfter })
          : "status_unknown"
        : undefined;
      return JSON.stringify({
        input: normalizedInput.displayValue,
        accepted: true,
        ...(writeResult?.duplicate ? { duplicate: true } : {}),
        ...(normalizedInput.controlAction ? { controlAction: normalizedInput.controlAction, controlEffect } : {}),
        deliveryState: writeResult?.deliveryState || "delivered",
        ...(controlId ? { controlId } : {}),
        ...(writeResult?.error ? { deliveryError: writeResult.error } : {}),
        ...(observationErrors.length > 0 ? { observationError: observationErrors.join("; ") } : {}),
        normalizedAlias: normalizedInput.normalizedAlias,
        output: output?.text || "",
        startOffset: output?.startOffset ?? beforeOffset,
        endOffset: output?.endOffset ?? beforeOffset,
        truncated: output?.truncated ?? false,
        foregroundPidBefore: statusBefore.foregroundPid ?? null,
        foregroundPidAfter: statusAfter?.foregroundPid ?? null,
        foregroundStateBefore: statusBefore.foregroundState ?? null,
        foregroundStateAfter: statusAfter?.foregroundState ?? null,
        foregroundGeneration: statusBefore.foregroundGeneration ?? null,
        shellAvailableBefore: statusBefore.shellAvailable ?? null,
        shellAvailableAfter: statusAfter?.shellAvailable ?? null,
        ptyRunningAfter: statusAfter?.running ?? null,
        exitCodeAfter: statusAfter?.exitCode ?? null,
        ...(writeResult?.duplicate
          ? { nextAction: "Observe with get_pty_status/read_pty_since or continue the next task; do not resend this control." }
          : {}),
      });
    }

    case "run_command": {
      const command = applyShellCwd((args.command as string) || "", args, workspace);
      if (!command) throw new Error("Missing required parameter 'command'.");
      return await runCommand(
        command,
        parseOptionalString(args.input),
        parseOptionalNumber(args.timeout_ms),
        workspace,
        options.shellPermissionApproval,
      );
    }

    case "browser_evaluate": {
      const url = parseOptionalString(args.url);
      if (!url) throw new Error("Missing required parameter 'url'.");
      return await browserEvaluate({
        url,
        actions: parseOptionalString(args.actions),
        checks: parseOptionalString(args.checks),
        waitForText: parseOptionalString(args.wait_for_text) ?? parseOptionalString(args.waitForText),
        waitForSelector: parseOptionalString(args.wait_for_selector) ?? parseOptionalString(args.waitForSelector),
        screenshot:
          args.screenshot === undefined || args.screenshot === null
            ? undefined
            : args.screenshot === true || args.screenshot === "true",
        failOnConsoleError:
          args.fail_on_console_error === false || args.fail_on_console_error === "false" ||
          args.failOnConsoleError === false || args.failOnConsoleError === "false"
            ? false
            : undefined,
        timeoutMs: parseOptionalNumber(args.timeout_ms) ?? parseOptionalNumber(args.timeoutMs),
      }, workspace);
    }

    case "computer_use": {
      const appName = parseOptionalString(args.app_name) ?? parseOptionalString(args.appName) ?? parseOptionalString(args.app);
      if (!appName) throw new Error("Missing required parameter 'app_name'.");
      return await computerUse({
        appName,
        appPath: parseOptionalString(args.app_path) ?? parseOptionalString(args.appPath),
        launch: args.launch === true || args.launch === "true" ? true : undefined,
        activate:
          args.activate === false || args.activate === "false"
            ? false
            : undefined,
        actions: parseOptionalString(args.actions),
        checks: parseOptionalString(args.checks),
        screenshot: args.screenshot === true || args.screenshot === "true" ? true : undefined,
        timeoutMs: parseOptionalNumber(args.timeout_ms) ?? parseOptionalNumber(args.timeoutMs),
      }, workspace);
    }

    case "get_project_skeleton": {
      const depth = typeof args.depth === "string" ? parseInt(args.depth, 10) : args.depth;
      return await invoke<string>("get_project_skeleton", { depth, workspace });
    }

    case "get_file_outline": {
      const outlinePath = (args.path as string) || "";
      return await getFileOutline(outlinePath, workspace);
    }

    case "index_workspace_documents": {
      const rootPath = (args.path as string) || ".";
      return await indexWorkspaceDocuments(
        rootPath,
        parseOptionalNumber(args.max_files),
        parseOptionalNumber(args.max_chars_per_file),
        typeof args.extensions === "string" ? args.extensions : undefined,
        workspace,
      );
    }

    case "knowledge_search": {
      const query = parseOptionalString(args.query);
      if (!query) throw new Error("Missing required parameter 'query'.");
      return await knowledgeSearch(
        query,
        parseOptionalStringList(args.kb_ids ?? args.kbIds),
        parseOptionalNumber(args.limit),
      );
    }

    case "knowledge_get_excerpt": {
      const sourceId = parseOptionalString(args.source_id ?? args.sourceId);
      const chunkId = parseOptionalString(args.chunk_id ?? args.chunkId);
      if (!sourceId) throw new Error("Missing required parameter 'source_id'.");
      if (!chunkId) throw new Error("Missing required parameter 'chunk_id'.");
      return await knowledgeGetExcerpt(sourceId, chunkId);
    }

    case "replace_in_file": {
      const replacePath = (args.path as string) || "";
      const searchText = (args.search_text as string) || "";
      const replaceText = (args.replace_text as string) || "";
      if (!replacePath) throw new Error("Missing required parameter 'path'.");
      if (!searchText) throw new Error("Missing required parameter 'search_text'.");
      const original = shouldUseChatTempStorage(workspace, sessionKey)
        ? await readChatTempFile(sessionKey!, replacePath)
        : await readFile(replacePath, workspace);
      if (!original.includes(searchText)) {
        throw new Error("search_text mismatch. The file content has likely changed. Please use the read_file tool or grep_search to view the current file content before attempting to edit again.");
      }
      const updated = original.replace(searchText, replaceText);
      if (updated === original) {
        throw new Error("替换结果为空变更，未执行写入。");
      }
      if (shouldUseChatTempStorage(workspace, sessionKey)) {
        const temporaryPath = await writeChatTempFile(sessionKey!, replacePath, updated);
        return buildChatTempSuccessMessage("updated", replacePath, temporaryPath);
      }
      await writeFile(replacePath, updated, workspace);
      return JSON.stringify({
        success: true,
        message: `File ${replacePath} updated successfully.`,
      });
    }

    case "write_file": {
      const writePath = (args.path as string) || "";
      const writeContent = (args.content as string) || "";
      if (!writePath) throw new Error("Missing required parameter 'path'.");
      if (shouldUseChatTempStorage(workspace, sessionKey)) {
        try {
          const original = await readChatTempFile(sessionKey!, writePath);
          if (original === writeContent) {
            return JSON.stringify({ success: true, noOp: true, message: `File ${writePath} already matched requested content.` });
          }
        } catch {
          // Missing temp file is fine; the write below will create it.
        }
        const temporaryPath = await writeChatTempFile(sessionKey!, writePath, writeContent);
        return buildChatTempSuccessMessage("written", writePath, temporaryPath);
      }
      try {
        const original = await readFile(writePath, workspace);
        if (original === writeContent) {
          return JSON.stringify({ success: true, noOp: true, message: `File ${writePath} already matched requested content.` });
        }
      } catch {
        // Missing file is fine; the write below will create it.
      }
      await writeFile(writePath, writeContent, workspace);
      return JSON.stringify({ success: true, message: `File ${writePath} written successfully.` });
    }

    case "apply_patch": {
      const patch = (args.patch as string) || "";
      if (!patch.trim()) throw new Error("Missing required parameter 'patch'.");
      const readPatchFile = async (path: string) => {
        return shouldUseChatTempStorage(workspace, sessionKey)
          ? await readChatTempFile(sessionKey!, path)
          : await readFile(path, workspace);
      };
      const writePatchFile = async (path: string, content: string) => {
        if (shouldUseChatTempStorage(workspace, sessionKey)) {
          await writeChatTempFile(sessionKey!, path, content);
        } else {
          await writeFile(path, content, workspace);
        }
      };
      const writeNewPatchFile = async (path: string, content: string) => {
        if (shouldUseChatTempStorage(workspace, sessionKey)) {
          await writeChatTempFileCreateNew(sessionKey!, path, content);
        } else {
          await writeFileCreateNew(path, content, workspace);
        }
      };
      const deletePatchPath = async (path: string) => {
        if (shouldUseChatTempStorage(workspace, sessionKey)) {
          await deleteChatTempPath(sessionKey!, path);
        } else {
          await deleteWorkspacePath(path, workspace);
        }
      };
      const probePatchPath = async (path: string) => {
        if (shouldUseChatTempStorage(workspace, sessionKey)) {
          try {
            await readChatTempFile(sessionKey!, path);
            return "exists" as const;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error || "");
            return /(?:FILE_METADATA_NOT_FOUND:|No such file or directory|os error 2)/i.test(message)
              ? "absent" as const
              : "unknown" as const;
          }
        }
        try {
          await getFileMetadata(path, workspace);
          return "exists" as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "");
          return message.startsWith("FILE_METADATA_NOT_FOUND:")
            ? "absent" as const
            : "unknown" as const;
        }
      };
      const result = await applyWorkspacePatch(patch, {
        readFile: readPatchFile,
        writeFile: writePatchFile,
        writeNewFile: writeNewPatchFile,
        deletePath: deletePatchPath,
        probePath: probePatchPath,
      });
      if (!result.ok) {
        throw new Error(result.error || "apply_patch failed.");
      }
      return JSON.stringify({
        success: true,
        message: `Patch applied to ${summarizeApplyPatchTarget(patch) || "workspace"}.`,
        changedFiles: result.changes.map((change) => change.path),
      });
    }

    case "delete_workspace_path": {
      const targetPath = (args.path as string) || "";
      if (!targetPath) throw new Error("Missing required parameter 'path'.");
      if (shouldUseChatTempStorage(workspace, sessionKey)) {
        await deleteChatTempPath(sessionKey!, targetPath);
        return JSON.stringify({
          success: true,
          message: `Temporary chat path ${targetPath} deleted successfully.`,
        });
      }
      await deleteWorkspacePath(targetPath, workspace);
      return JSON.stringify({
        success: true,
        message: `Path ${targetPath} deleted successfully.`,
      });
    }

    // Unknown names cannot safely fall through to Skill execution. Tool
    // Skills are admitted above only after the Turn catalog resolves their
    // exact package identity.
    default:
      throw new Error(
        `UNKNOWN_TOOL: "${name}" is not a built-in or MCP tool. ` +
        "Tool Skills require an exact ToolCatalog identity.",
      );
  }
}

/**
 * Legacy helper for callers that only have a tool name. The orchestrator uses
 * the richer ToolCapabilityRegistry so MCP descriptions and per-call SQL risk
 * can refine this default classification.
 */
export function isReadOnlyTool(name: string): boolean {
  const risk = !isBuiltInToolName(name) && isMcpTool(name)
    ? classifyMcpToolName(name)
    : classifyBuiltInTool(name);
  return isRiskAutoExecutable(risk);
}
