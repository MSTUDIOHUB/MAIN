import {
  normalizePlanEvidenceValue,
  type PlanExecutionEvidenceEntry,
} from "./workflowModels";

const NON_EXECUTION_EVIDENCE_TOOLS = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "read_file",
  "read_document",
  "knowledge_search",
  "knowledge_get_excerpt",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

const VERIFICATION_EVIDENCE_TOOLS = new Set([
  "read_file",
  "read_document",
  "knowledge_search",
  "knowledge_get_excerpt",
  "grep_search",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const WORKSPACE_FILE_REF_RE =
  /(?:^|[\s`"'(（])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s`"',，。；;:)）])/g;
const MAX_EVIDENCE_REFERENCES = 20;

function sourceToolLooksLikeBrowserAutomation(toolName: string): boolean {
  return /(?:browser|playwright|puppeteer|cypress)/i.test(String(toolName || ""));
}

function sourceToolLooksLikeTauriAutomation(toolName: string): boolean {
  return /(?:tauri|desktop|computer|osascript|applescript|webdriver)/i.test(String(toolName || ""));
}

function commandLooksLikeDevServerOrHttpProbe(value: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:dev|preview|vite)\b/i.test(String(value || "")) ||
    /\b(?:vite|webpack-dev-server|next\s+dev)\b/i.test(String(value || "")) ||
    /\bcurl\b[\s\S]{0,120}\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)/i.test(String(value || ""));
}

export function isPlanArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/");
}

export function commandResultLooksSuccessful(toolName: string, result: string): boolean {
  if (toolName !== "run_command") return true;
  try {
    const parsed = JSON.parse(result);
    const exitCode = parsed?.exitCode ?? parsed?.code ?? parsed?.status;
    if (typeof exitCode === "number") return exitCode === 0;
    if (typeof parsed?.success === "boolean") return parsed.success;
  } catch {
    // Some command adapters return plain text; treat a completed tool call as
    // evidence unless it clearly carries an error marker.
  }
  return !/\b(exit\s*code\s*[=:]\s*[1-9]\d*|command failed|error:)\b/i.test(result);
}

export function browserResultLooksSuccessful(result: string): boolean {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.ok === false || record.success === false) return false;
      if (typeof record.error === "string" && record.error.trim()) return false;
      if (Array.isArray(record.assertions)) {
        return !record.assertions.some((item) =>
          item && typeof item === "object" && (item as Record<string, unknown>).passed === false
        );
      }
    }
  } catch {
    // Some browser adapters return plain text; reject clear failure markers.
  }
  return !/(?:"ok"\s*:\s*false|"success"\s*:\s*false|browser validation failed|assertion failed|error:)/i.test(result);
}

export function isPlanExecutionEvidenceTool(toolName: string, target: string): boolean {
  if (NON_EXECUTION_EVIDENCE_TOOLS.has(toolName)) {
    return false;
  }

  if (target && isPlanArtifactPath(target)) {
    return false;
  }

  return true;
}

export function isPlanEvidenceLedgerTool(toolName: string, target: string): boolean {
  if (target && isPlanArtifactPath(target)) {
    return false;
  }
  return isPlanExecutionEvidenceTool(toolName, target) || VERIFICATION_EVIDENCE_TOOLS.has(toolName);
}

function extractWorkspaceFileReferences(...values: string[]): string[] {
  const seen = new Set<string>();
  const references: string[] = [];
  for (const value of values) {
    for (const matched of String(value || "").matchAll(WORKSPACE_FILE_REF_RE)) {
      const candidate = String(matched[1] || "").replace(/\\/g, "/").trim();
      if (!candidate || isPlanArtifactPath(candidate)) continue;
      const key = normalizePlanEvidenceValue(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      references.push(candidate);
      if (references.length >= MAX_EVIDENCE_REFERENCES) return references;
    }
  }
  return references;
}

export function createPlanExecutionEvidenceEntry(input: {
  toolName: string;
  target: string;
  result: string;
  noOp?: boolean;
}): PlanExecutionEvidenceEntry | null {
  const target = String(input.target || "").trim();
  if (!target || input.noOp || isPlanArtifactPath(target)) return null;

  const timestamp = Date.now();
  if (input.toolName === "write_file" || input.toolName === "replace_in_file" || input.toolName === "apply_patch" || input.toolName === "delete_workspace_path") {
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "file",
      value: target,
      target,
      references: extractWorkspaceFileReferences(target),
      sourceTool: input.toolName,
      createdAt: timestamp,
    };
  }

  if (input.toolName === "run_command" || input.toolName === "execute_command" || input.toolName === "send_pty_input") {
    if (!commandResultLooksSuccessful(input.toolName, input.result)) return null;
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "cmd",
      value: target,
      target,
      references: extractWorkspaceFileReferences(target, input.result),
      sourceTool: input.toolName,
      createdAt: timestamp,
    };
  }

  if (sourceToolLooksLikeBrowserAutomation(input.toolName)) {
    if (!browserResultLooksSuccessful(input.result)) return null;
    const isScreenshot = /screenshot|snapshot|capture/i.test(input.toolName) || /screenshot|image|png|jpeg|webp/i.test(input.result);
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: isScreenshot ? "browser_screenshot" : "browser_dom",
      value: target,
      target,
      references: extractWorkspaceFileReferences(target, input.result),
      sourceTool: input.toolName,
      createdAt: timestamp,
    };
  }

  if (sourceToolLooksLikeTauriAutomation(input.toolName)) {
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "tauri_required",
      value: target,
      target,
      references: extractWorkspaceFileReferences(target, input.result),
      sourceTool: input.toolName,
      createdAt: timestamp,
    };
  }

  if (VERIFICATION_EVIDENCE_TOOLS.has(input.toolName)) {
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: commandLooksLikeDevServerOrHttpProbe(target) ? "dev_server_url" : "tool",
      value: target,
      target,
      references: extractWorkspaceFileReferences(target, input.result),
      sourceTool: input.toolName,
      createdAt: timestamp,
    };
  }

  return null;
}

export function appendPlanEvidenceEntry(
  ledger: PlanExecutionEvidenceEntry[],
  entry: PlanExecutionEvidenceEntry | null,
): PlanExecutionEvidenceEntry[] {
  if (!entry) return ledger;
  const entryKey = `${entry.kind}:${normalizePlanEvidenceValue(entry.value)}:${entry.sourceTool}`;
  if (ledger.some((item) => `${item.kind}:${normalizePlanEvidenceValue(item.value)}:${item.sourceTool}` === entryKey)) {
    return ledger;
  }
  return [...ledger, entry].slice(-200);
}
