// lib/toolExecutor.ts
// Routes agent tool calls to the correct execution backend.
// ALL file operations go through Tauri IPC (invoke) to the Rust backend,
// which uses std::fs and enforces workspace-scoped path safety.
// This avoids tauri-plugin-fs permission dialogs entirely.
// ────────────────────────────────────────────────────────────────────

import {
  analyzeTabularDocument,
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
      const nodes = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>("list_directory", { path: dirPath });
      return formatDirectoryNodesForTool(nodes, workspace);
    }

    case "read_file": {
      const rawPath = (args.path as string) || "";
      if (shouldUseChatTempStorage(workspace, sessionKey)) {
        return await readChatTempFile(sessionKey!, rawPath);
      }
      return await invoke<string>("read_file", { path: rawPath });
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
      );
    }

    // ── Custom Tauri IPC commands ─────────────────────────────

    case "glob_search":
      return await globSearch(args.pattern as string);

    case "grep_search": {
      const query = args.query as string;
      const path = (args.path as string) || ".";
      return await grepSearch(query, path);
    }

    case "execute_command": {
      const command = args.command as string;
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 1500, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let beforeOffset = 0;
      try {
        beforeOffset = (await getPtyStatus()).bufferEndOffset;
        await writePty(command + "\n");
      } catch {
        await spawnPty(140, 40);
        beforeOffset = (await getPtyStatus()).bufferEndOffset;
        await writePty(command + "\n");
      }
      await sleep(waitMs);
      const output = await readPtySince(beforeOffset, maxChars);
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
      return await readPtyBuffer(parseOptionalNumber(args.max_chars));

    case "read_pty_tail":
      return await readPtyTail(parseOptionalNumber(args.max_chars));

    case "read_pty_since": {
      const offset = parseOptionalNumber(args.offset);
      if (offset === undefined) throw new Error("Missing required parameter 'offset'.");
      return await readPtySince(offset, parseOptionalNumber(args.max_chars));
    }

    case "get_pty_status":
      return await getPtyStatus();

    case "clear_pty_buffer":
      return await clearPtyBuffer();

    case "send_pty_input": {
      const input = (args.input as string) || "";
      if (!input) throw new Error("Missing required parameter 'input'.");
      const appendNewline = args.append_newline === true || args.append_newline === "true";
      const waitMs = Math.min(Math.max(parseOptionalNumber(args.wait_ms) ?? 500, 0), 30_000);
      const maxChars = Math.min(Math.max(parseOptionalNumber(args.max_chars) ?? 8000, 100), 200_000);
      let beforeOffset = 0;
      try {
        beforeOffset = (await getPtyStatus()).bufferEndOffset;
        await writePty(input + (appendNewline ? "\n" : ""));
      } catch {
        await spawnPty(140, 40);
        beforeOffset = (await getPtyStatus()).bufferEndOffset;
        await writePty(input + (appendNewline ? "\n" : ""));
      }
      await sleep(waitMs);
      const output = await readPtySince(beforeOffset, maxChars);
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
      );
    }

    case "get_project_skeleton": {
      const depth = typeof args.depth === "string" ? parseInt(args.depth, 10) : args.depth;
      return await invoke<string>("get_project_skeleton", { depth });
    }

    case "get_file_outline": {
      const outlinePath = (args.path as string) || "";
      return await getFileOutline(outlinePath);
    }

    case "index_workspace_documents": {
      const rootPath = (args.path as string) || ".";
      return await indexWorkspaceDocuments(
        rootPath,
        parseOptionalNumber(args.max_files),
        parseOptionalNumber(args.max_chars_per_file),
        typeof args.extensions === "string" ? args.extensions : undefined,
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
        : await readFile(replacePath);
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
      await writeFile(replacePath, updated);
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
        const temporaryPath = await writeChatTempFile(sessionKey!, writePath, writeContent);
        return buildChatTempSuccessMessage("written", writePath, temporaryPath);
      }
      await writeFile(writePath, writeContent);
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
      await invoke<void>("delete_workspace_path", { path: targetPath });
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
 * Returns true if a tool is read-only and can be auto-executed
 * without user review.
 *
 * MCP tools are NOT considered read-only — they control external
 * engines (like Unity) and must go through the human review gate.
 */
export function isReadOnlyTool(name: string): boolean {
  if (isMcpTool(name)) return false;
  return [
    "list_directory",
    "read_file",
    "read_document",
    "analyze_tabular_document",
    "query_tabular_document",
    "index_workspace_documents",
    "glob_search",
    "grep_search",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
    "clear_pty_buffer",
    "get_project_skeleton",
    "get_file_outline",
  ].includes(name);
}
