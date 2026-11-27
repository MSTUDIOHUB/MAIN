import { beginCapsuleModelActivity } from "../../lib/capsuleLiveActivity";
import { shouldPublishPublicCommentary } from "../../lib/languageContract";
import { normalizeProviderResponseV1, type RuntimeV2Command, type RuntimeV2NormalizedProviderResult } from "../../lib/runtime-v2";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import type { RuntimeV2PreparedChatAnswer, RuntimeV2PreparedWorkspaceRead } from "../../lib/submissionRuntimeContracts";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { isAbsoluteWorkspacePath } from "../../lib/workspacePaths";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";
import { normalizeRuntimeV2ProviderToolCalls, runtimeV2ProviderToolArgumentViolation } from "./executionProviderToolSchema";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export async function readPreparedChatAnswer(input: {
  readonly prepared: RuntimeV2PreparedChatAnswer;
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2NormalizedProviderResult | null> {
  const { command, ports, signal } = input;
  signal.throwIfAborted();
  const activity = beginCapsuleModelActivity(command.run, command.idempotencyKey, signal);
  const onModelProgress = activity.requestDispatched();
  const language = ports.context.phaseLanguage;
  let streamedText = "";
  let acceptingText = true;
  let reportedPublicText = false;
  const owner = { turnId: command.run.turnId, runId: command.run.runId, commandKey: command.idempotencyKey };
  try {
    const answer = await input.prepared.read({
      signal,
      onText(delta) {
        if (!acceptingText || signal.aborted || !delta) return;
        streamedText = (streamedText + delta).slice(0, 24_000);
        const text = sanitizeAssistantDisplayContent(streamedText);
        if (shouldPublishPublicCommentary(text, language).allow) {
          onModelProgress();
          activity.reportPublicCommentary(text);
          if (!reportedPublicText) {
            reportedPublicText = true;
            ports.logStoreEvent("runtime_v2_provider_request_timing", { ...owner, stage: "first_public_text", attempt: "prepared_chat" });
          }
        }
      },
    });
    signal.throwIfAborted();
    if (answer) {
      const normalized = normalizeProviderResponseV1(answer);
      const text = sanitizeAssistantDisplayContent(normalized.visibleText || "");
      if (!normalized.toolCalls.length && !normalized.diagnostics.length && shouldPublishPublicCommentary(text, language).allow) {
        ports.logStoreEvent("runtime_v2_prepared_chat_answer_adopted", { ...owner, ...normalized.usage });
        return { ...normalized, visibleText: text };
      }
    }
  } catch {
    signal.throwIfAborted();
  } finally {
    acceptingText = false;
    activity.finish();
  }
  ports.logStoreEvent("runtime_v2_prepared_chat_answer_fallback", owner);
  return null;
}

const PREPARED_WORKSPACE_READ_TOOLS = new Set(["read_file", "grep_search", "glob_search", "list_directory"]);

export function normalizePreparedWorkspaceRead(
  prepared: RuntimeV2PreparedWorkspaceRead,
  tools: readonly ToolDefinition[],
  workspace: string,
): RuntimeV2NormalizedProviderResult | null {
  const result = normalizeProviderResponseV1(prepared);
  const allowedNames = new Set(tools.map(tool => tool.function.name));
  if (result.diagnostics.length || !result.toolCalls.length || result.toolCalls.some(call =>
    !PREPARED_WORKSPACE_READ_TOOLS.has(call.name) || !allowedNames.has(call.name)
  )) return null;
  const normalizedCalls = normalizeRuntimeV2ProviderToolCalls(result.toolCalls, tools, workspace);
  if (runtimeV2ProviderToolArgumentViolation(normalizedCalls, tools)) return null;
  const outsideWorkspace = normalizedCalls.some(call => {
    const target = call.name === "glob_search" ? call.arguments.pattern : call.arguments.path;
    if (typeof target !== "string") return false;
    const path = normalizeRuntimeV2WorkspacePath(target, workspace);
    return !path || isAbsoluteWorkspacePath(path) || /^(?:[a-z]:|~(?:\/|$))/i.test(path) || path.split("/").includes("..");
  });
  return outsideWorkspace ? null : result;
}
