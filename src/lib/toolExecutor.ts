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
  globSearch,
  grepSearch,
  indexWorkspaceDocuments,
  queryTabularDocument,
  readChatTempFile,
  spawnPty,
  writePty,
  readPtyBuffer,
  readPtyTail,
  readPtySince,
  clearPtyBuffer,
  getPtyStatus,
  runCommand,
  getFileOutline,
  readFile,
  readDocument,
  writeChatTempFile,
  writeFile,
} from "./ipc";
import { invoke } from "@tauri-apps/api/core";
import { isMcpTool, executeMcpTool, getMcpServerUrl } from "./mcpClient";
import {
  classifyBuiltInTool,
  classifyMcpToolName,
  isRiskAutoExecutable,
} from "./toolCapabilities";
import { formatDirectoryNodesForTool } from "./workspacePaths";

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

function shouldUseChatTempStorage(workspace: string, sessionKey?: string): boolean {
  return !workspace.trim() && !!sessionKey;
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
      if (shouldUseChatTempStorage(workspace, sessionKey)) {
        return await readChatTempFile(sessionKey!, rawPath);
      }
      return await readFile(rawPath, workspace);
    }

    case "read_document": {
      const rawPath = (args.path as string) || "";
      if (!rawPath) throw new Error("Missing required parameter 'path'.");
      return await readDocument(
        rawPath,
        parseOptionalNumber(args.max_chars),
        parseOptionalNumber(args.max_blocks),
        parseOptionalNumber(args.row_offset),
        parseOptionalNumber(args.max_rows),
        parseOptionalString(args.sheet),
        workspace,
      );
    }

    case "analyze_tabular_document": {
      const rawPath = (args.path as string) || "";
      if (!rawPath) throw new Error("Missing required parameter 'path'.");
      return await analyzeTabularDocument(
        rawPath,
        parseOptionalString(args.sheet),
        parseOptionalNumber(args.max_columns),
        parseOptionalNumber(args.sample_rows),
        parseOptionalString(args.focus_columns),
        workspace,
      );
    }

    case "query_tabular_document": {
      const rawPath = (args.path as string) || "";
      if (!rawPath) throw new Error("Missing required parameter 'path'.");
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
        workspace,
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

    case "execute_command": {
      const command = args.command as string;
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 1500, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let beforeOffset = 0;
      try {
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(command + "\n", sessionKey);
      } catch {
        await spawnPty(140, 40, sessionKey, workspace);
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(command + "\n", sessionKey);
      }
      await sleep(waitMs);
      const output = await readPtySince(beforeOffset, maxChars, sessionKey);
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
      return await readPtyTail(parseOptionalNumber(args.max_chars), sessionKey);

    case "read_pty_since": {
      const offset = parseOptionalNumber(args.offset);
      if (offset === undefined) throw new Error("Missing required parameter 'offset'.");
      return await readPtySince(offset, parseOptionalNumber(args.max_chars), sessionKey);
    }

    case "get_pty_status":
      return await getPtyStatus(sessionKey);

    case "clear_pty_buffer":
      return await clearPtyBuffer(sessionKey);

    case "send_pty_input": {
      const input = (args.input as string) || "";
      if (!input) throw new Error("Missing required parameter 'input'.");
      const appendNewline = args.append_newline === true || args.append_newline === "true";
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 500, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let beforeOffset = 0;
      try {
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(input + (appendNewline ? "\n" : ""), sessionKey);
      } catch {
        await spawnPty(140, 40, sessionKey, workspace);
        beforeOffset = (await getPtyStatus(sessionKey)).bufferEndOffset;
        await writePty(input + (appendNewline ? "\n" : ""), sessionKey);
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
      const command = (args.command as string) || "";
      if (!command) throw new Error("Missing required parameter 'command'.");
      return await runCommand(
        command,
        parseOptionalString(args.input),
        parseOptionalNumber(args.timeout_ms),
        workspace,
      );
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
            `Please ensure the Rust handler for "execute_skill" is implemented.`
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
