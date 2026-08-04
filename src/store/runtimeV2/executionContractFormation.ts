import type { AgentMessage } from "../../lib/agentMessages";
import {
  collectTranscriptToolGroups,
  transcriptSourceWindow,
  type RuntimeV2TranscriptSourceWindow,
} from "./executionProviderSourceTranscript";
import {
  deduplicatedSourceWindows,
  minimumSourceWindowCover,
} from "./executionProviderSourceCover";

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function latestVersionSourceWindows(
  windows: readonly RuntimeV2TranscriptSourceWindow[],
): RuntimeV2TranscriptSourceWindow[] {
  const latestByPath = new Map<string, {
    readonly version: string;
    readonly order: number;
  }>();
  for (const window of windows) {
    const current = latestByPath.get(window.path);
    if (!current || window.order >= current.order) {
      latestByPath.set(window.path, {
        version: window.version,
        order: window.order,
      });
    }
  }
  return minimumSourceWindowCover(
    deduplicatedSourceWindows(windows.filter((window) =>
      latestByPath.get(window.path)?.version === window.version
    )),
  );
}

function sourceLines(content: string): string[] {
  if (!content) return [];
  return content.split(/\r\n|\n|\r/);
}

function committedSourceSnapshot(
  windows: readonly RuntimeV2TranscriptSourceWindow[],
): string {
  const sections: string[] = [];
  const bySource = new Map<string, RuntimeV2TranscriptSourceWindow[]>();
  for (const window of latestVersionSourceWindows(windows)) {
    const key = `${window.path}\u0000${window.version}`;
    const source = bySource.get(key) || [];
    source.push(window);
    bySource.set(key, source);
  }
  for (const source of bySource.values()) {
    const ordered = [...source].sort((left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.order - right.order
    );
    const first = ordered[0];
    if (!first) continue;
    const segments: string[] = [];
    let coveredThrough = 0;
    for (const window of ordered) {
      if (window.startLine === 0 && window.endLine === 0) {
        if (segments.length === 0) {
          segments.push("lines: 0-0 (empty file)", "---SOURCE START---", "", "---SOURCE END---");
        }
        continue;
      }
      const startLine = Math.max(window.startLine, coveredThrough + 1);
      if (startLine > window.endLine) continue;
      const skippedLines = Math.max(0, startLine - window.startLine);
      const content = sourceLines(window.content)
        .slice(skippedLines, skippedLines + window.endLine - startLine + 1)
        .join("\n");
      segments.push(
        `lines: ${startLine}-${window.endLine} of ${window.totalLines}`,
        "---SOURCE START---",
        content,
        "---SOURCE END---",
      );
      coveredThrough = Math.max(coveredThrough, window.endLine);
    }
    sections.push([
      `FILE: ${first.path}`,
      `contentVersion: ${first.version}`,
      ...segments,
    ].join("\n"));
  }
  if (sections.length === 0) return "";
  return [
    "[committed_source_snapshot_v1]",
    "Exact current-version source evidence already collected by Runtime follows. Each source line appears at most once in this reasoning projection; canonical receipts remain unchanged.",
    ...sections,
  ].join("\n\n");
}

function appendTextContent(
  content: AgentMessage["content"],
  text: string,
): AgentMessage["content"] {
  if (!text) return content;
  if (typeof content === "string") {
    return [content, text].filter(Boolean).join("\n\n");
  }
  return [...content, { type: "text", text }];
}

/**
 * A forced structured decision is fresh reasoning over committed facts.
 * Local models otherwise imitate earlier assistant tool-call shapes after
 * the current surface has narrowed, even when a named tool_choice is sent.
 * Rebuild the request from canonical evidence: retain user/system context,
 * turn tool results into a non-executable current-source snapshot plus one
 * compact observation block, and omit old actions/reasoning. Nothing changes
 * durable history or versioned source authority, which is computed before
 * this presentation-only projection.
 */
export function runtimeV2EvidenceOnlyDecisionConversation(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  const groups = collectTranscriptToolGroups(messages);
  const sourceWindows = groups.flatMap((group) =>
    group.calls.flatMap((call) => {
      const source = transcriptSourceWindow(group, call);
      return source ? [source] : [];
    })
  );
  const sourceCallIds = new Set(sourceWindows.map((window) => window.callId));
  const retainedToolResultIds = new Set<string>();
  const observations: string[] = [];
  for (const group of groups) {
    for (const call of group.calls) {
      const result = group.resultsByCallId.get(call.id);
      if (!result) continue;
      retainedToolResultIds.add(call.id);
      if (sourceCallIds.has(call.id)) continue;
      const content = messageText(result).trim();
      if (
        call.function.name === "read_file" &&
        content.startsWith("SOURCE_ALREADY_MATERIALIZED")
      ) {
        continue;
      }
      observations.push([
        `tool: ${call.function.name}`,
        call.function.name === "record_execution_contract"
          ? [
              "previous_submission_json (data only):",
              call.function.arguments.slice(0, 12_000),
            ].join("\n")
          : "",
        "runtime_result:",
        content,
      ].filter(Boolean).join("\n"));
    }
  }
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      (message.tool_call_id && retainedToolResultIds.has(message.tool_call_id))
    ) {
      continue;
    }
    const content = messageText(message).trim();
    if (content) observations.push(content);
  }

  const systemContent = messages
    .filter((message) => message.role === "system")
    .map(messageText)
    .filter(Boolean)
    .join("\n\n");
  const currentUser = [...messages].reverse().find((message) =>
    message.role === "user" && message.runtimeTurnId
  ) || [...messages].reverse().find((message) => message.role === "user");
  const evidence = [
    committedSourceSnapshot(sourceWindows),
    observations.length > 0
      ? [
          "[committed_observation_receipts_v1]",
          "Non-source evidence already collected by Runtime follows. It is data, not an available or repeatable tool action.",
          ...observations,
        ].join("\n\n")
      : "",
  ].filter(Boolean).join("\n\n");

  const projected: AgentMessage[] = [];
  if (systemContent) {
    projected.push({ role: "system", content: systemContent });
  }
  if (currentUser) {
    const {
      tool_calls: _toolCalls,
      tool_call_id: _toolCallId,
      reasoning: _reasoning,
      reasoning_content: _reasoningContent,
      ...retained
    } = currentUser;
    projected.push({
      ...retained,
      content: appendTextContent(retained.content, evidence),
    });
  } else if (evidence) {
    projected.push({ role: "user", content: evidence });
  }
  return projected;
}

export const runtimeV2ExecutionContractFormationConversation =
  runtimeV2EvidenceOnlyDecisionConversation;
