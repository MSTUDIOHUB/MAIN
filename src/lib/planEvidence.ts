import {
  normalizePlanEvidenceValue,
  type PlanExecutionEvidenceEntry,
} from "./workflowModels";

const NON_EXECUTION_EVIDENCE_TOOLS = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
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
  "grep_search",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

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

export function createPlanExecutionEvidenceEntry(input: {
  toolName: string;
  target: string;
  result: string;
  noOp?: boolean;
}): PlanExecutionEvidenceEntry | null {
  const target = String(input.target || "").trim();
  if (!target || input.noOp || isPlanArtifactPath(target)) return null;

  const timestamp = Date.now();
  if (input.toolName === "write_file" || input.toolName === "replace_in_file" || input.toolName === "delete_workspace_path") {
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "file",
      value: target,
      target,
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
      sourceTool: input.toolName,
      createdAt: timestamp,
    };
  }

  if (VERIFICATION_EVIDENCE_TOOLS.has(input.toolName)) {
    return {
      id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "tool",
      value: target,
      target,
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
