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
  clearPtyBuffer,
  getPtyStatus,
  runCommand,
  getFileOutline,
  ingestAttachmentFile,
  readFile,
  readFileWindow,
  readDocument,
  webFetch,
  webSearch,
  writeChatTempFile,
  writeFile,
  type ShellPermissionApproval,
} from "./ipc";
import { isChatAttachmentPath } from "./attachments";
import { invoke } from "@tauri-apps/api/core";
import { isMcpTool, executeMcpTool, getMcpServerUrl } from "./mcpClient";
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

/** Delay helper for waiting on PTY output after a command. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  "get_project_skeleton",
  "get_file_outline",
  "index_workspace_documents",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "delete_workspace_path",
  "run_command",
  "browser_evaluate",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

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
  // ── MCP tool routing ────────────────────────────────────────
  // If the tool was discovered from an MCP server, forward the call
  // via HTTP JSON-RPC to that server instead of using Tauri IPC.
  if (isMcpTool(name)) {
    const serverUrl = getMcpServerUrl(name);
    if (!serverUrl) {
      throw new Error(`MCP server URL not found for tool "${name}". The server may have been disconnected.`);
    }
    return await executeMcpTool(serverUrl, name, args);
  }

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

    case "execute_command": {
      const command = applyShellCwd((args.command as string) || "", args);
      if (!command) throw new Error("Missing required parameter 'command'.");
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 4000, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let beforeOffset = 0;
      try {
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(command + "\n", sessionKey, options.shellPermissionApproval);
      } catch {
        await spawnPty(140, 40, sessionKey, workspace);
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(command + "\n", sessionKey, options.shellPermissionApproval);
      }
      await sleep(waitMs);
      let output = await readPtySince(beforeOffset, maxChars, sessionKey);

      // Adaptive extend: if the PTY buffer is still growing, wait more
      // to capture ongoing output (up to 2 extra rounds of 2000ms each).
      const maxExtends = 2;
      const extendMs = 2000;
      let extendCount = 0;
      while (extendCount < maxExtends) {
        const statusAfter = await getPtyStatus(sessionKey);
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
      }

      return JSON.stringify({
        command,
        output: output.text,
        startOffset: output.startOffset,
        endOffset: output.endOffset,
        truncated: output.truncated,
        note: "If the process is still running or output is incomplete, call read_pty_since with endOffset or read_pty_tail.",
      });
    }

    case "read_pty_buffer":
      return await readPtyBuffer(parseOptionalNumber(args.max_chars), sessionKey);

    case "read_pty_tail":
      await sleep(Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 0, 0), 30_000));
      return await readPtyTail(parseOptionalNumber(args.max_chars), sessionKey);

    case "read_pty_since": {
      const offset = parseOptionalNumber(args.offset);
      if (offset === undefined) throw new Error("Missing required parameter 'offset'.");
      await sleep(Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 0, 0), 30_000));
      return await readPtySince(offset, parseOptionalNumber(args.max_chars), sessionKey);
    }

    case "get_pty_status":
      await sleep(Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 0, 0), 30_000));
      return await getPtyStatus(sessionKey);

    case "clear_pty_buffer":
      return await clearPtyBuffer(sessionKey);

    case "send_pty_input": {
      const input = (args.input as string) || "";
      if (!input) throw new Error("Missing required parameter 'input'.");
      const appendNewline = args.append_newline === true || args.append_newline === "true";
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 1500, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let beforeOffset = 0;
      try {
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(input + (appendNewline ? "\n" : ""), sessionKey, options.shellPermissionApproval);
      } catch {
        await spawnPty(140, 40, sessionKey, workspace);
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(input + (appendNewline ? "\n" : ""), sessionKey, options.shellPermissionApproval);
      }
      await sleep(waitMs);
      const output = await readPtySince(beforeOffset, maxChars, sessionKey);
      return JSON.stringify({
        input,
        output: output.text,
        startOffset: output.startOffset,
        endOffset: output.endOffset,
        truncated: output.truncated,
      });
    }

    case "run_command": {
      const command = applyShellCwd((args.command as string) || "", args);
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
        screenshot: args.screenshot === true || args.screenshot === "true",
        failOnConsoleError:
          args.fail_on_console_error === false || args.fail_on_console_error === "false" ||
          args.failOnConsoleError === false || args.failOnConsoleError === "false"
            ? false
            : undefined,
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
        throw new Error("search_text 与文件内容不一致，未执行写入。");
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
      const deletePatchPath = async (path: string) => {
        if (shouldUseChatTempStorage(workspace, sessionKey)) {
          await deleteChatTempPath(sessionKey!, path);
        } else {
          await deleteWorkspacePath(path, workspace);
        }
      };
      const result = await applyWorkspacePatch(patch, {
        readFile: readPatchFile,
        writeFile: writePatchFile,
        deletePath: deletePatchPath,
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

    // ── Custom skill tools → route to Tauri backend ──────────
    default:
      try {
        const result = await invoke<string>("execute_skill", { name, args });
        return result;
      } catch (err) {
        // If the Tauri command doesn't exist, provide a clear message
        const msg = (err as Error).message || String(err);
        if (msg.includes("not found") || msg.includes("Unknown")) {
          throw new Error(
            `Skill tool "${name}" is not registered in the backend. ` +
            `MAIN currently exposes Tool Skills as function schemas only; real execution needs a built-in tool, MCP tool, or a Rust "execute_skill" handler.`
          );
        }
        throw new Error(`Skill tool "${name}" execution failed: ${msg}`);
      }
  }
}

/**
 * Legacy helper for callers that only have a tool name. The orchestrator uses
 * the richer ToolCapabilityRegistry so MCP descriptions and per-call SQL risk
 * can refine this default classification.
 */
export function isReadOnlyTool(name: string): boolean {
  const risk = isMcpTool(name) ? classifyMcpToolName(name) : classifyBuiltInTool(name);
  return isRiskAutoExecutable(risk);
}
