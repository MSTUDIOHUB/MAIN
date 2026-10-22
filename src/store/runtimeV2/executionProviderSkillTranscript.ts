import type { AgentMessage } from "../../lib/agentMessages";
import type { SkillReadTarget, SkillSourceRange } from "../../lib/agentSkills";
import { collectTranscriptToolGroups, type RuntimeV2TranscriptToolGroup } from "./executionProviderSourceTranscript";

export interface RuntimeV2TranscriptSkillGuidanceWindow {
  readonly callId: string;
  readonly order: number;
  readonly call: RuntimeV2TranscriptToolGroup["calls"][number];
  readonly documentKey: string;
  readonly version: string;
  readonly readTarget: SkillReadTarget;
  readonly returnedRange: SkillSourceRange;
  readonly content: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parsedRecord(value: string): Record<string, unknown> | null {
  try { return record(JSON.parse(value)); } catch { return null; }
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** Parse only actual, typed load_skill receipts. An empty/index-only result
 * may identify a newer revision, but carries no instruction bytes. This is
 * deliberately separate from read_file source/mutation authority. */
export function runtimeV2TranscriptSkillDocumentReads(
  messages: readonly AgentMessage[],
): RuntimeV2TranscriptSkillGuidanceWindow[] {
  return collectTranscriptToolGroups(messages).flatMap((group) =>
    group.calls.flatMap((call) => {
      if (call.function.name !== "load_skill") return [];
      const args = parsedRecord(call.function.arguments);
      const result = group.resultsByCallId.get(call.id);
      const body = typeof result?.content === "string" ? parsedRecord(result.content) : null;
      if (!args || !body || String(args.operation || "load").trim() !== "load") return [];
      const resource = body.type === "skill.resource";
      if (!resource && body.type !== "skill.loaded") return [];
      const target = record(body.readTarget);
      const range = record(body.returnedRange);
      if (!target || !range || !safeString(body.id) || !safeString(body.ref) ||
        !safeString(body.version) || target.skill_id !== body.ref || target.expected_version !== body.version ||
        ![body.id, body.ref].includes(String(args.skill_id || "").trim()) ||
        (args.expected_version !== undefined && args.expected_version !== body.version) ||
        typeof body.content !== "string" ||
        !["full", "overview", "window"].includes(body.disclosure as string)) return [];
      if (resource) {
        if (!safeString(body.resource) || body.resource !== target.resource || body.resource !== args.resource ||
          body.resource.startsWith("/") || body.resource.includes("\\") ||
          body.resource.split("/").some((part) => !part || part === "." || part === "..") ||
          body.effect !== "resource_guidance_no_additional_permissions") return [];
      } else if (body.resource !== undefined || target.resource !== undefined || args.resource !== undefined ||
        !["instructions_loaded_no_additional_permissions", "instructions_partially_read_no_additional_permissions"].includes(body.effect as string)) return [];
      const { startLine, endLine, startChar, endChar } = range;
      if (![startLine, endLine, startChar, endChar, body.totalLines, body.totalChars]
        .every((value) => Number.isSafeInteger(value)) ||
        Number(startLine) < 0 || Number(endLine) < 0 || Number(endLine) > Number(body.totalLines) ||
        (body.content.length > 0 && (Number(startLine) < 1 || Number(endLine) < Number(startLine))) ||
        Number(startChar) < 0 || Number(endChar) < Number(startChar) || Number(endChar) > Number(body.totalChars) ||
        Number(endChar) - Number(startChar) !== body.content.length) return [];
      return [{
        callId: call.id, order: group.order, call,
        documentKey: JSON.stringify([body.id, resource ? body.resource : null]),
        version: body.version,
        readTarget: { skill_id: body.ref, expected_version: body.version, ...(resource ? { resource: body.resource as string } : {}) },
        returnedRange: { startLine: Number(startLine), endLine: Number(endLine), startChar: Number(startChar), endChar: Number(endChar) },
        content: body.content,
      }];
    }),
  );
}

export function runtimeV2TranscriptSkillGuidanceWindows(
  messages: readonly AgentMessage[],
): RuntimeV2TranscriptSkillGuidanceWindow[] {
  return runtimeV2TranscriptSkillDocumentReads(messages).filter((window) => window.content.length > 0);
}

/** Select an exact interval cover of the bytes already read, never a new
 * full document. Later versions supersede only that same document; a resource
 * and its SKILL.md retain independent identities and revisions. */
export function activeRuntimeV2SkillGuidanceWindows(
  messages: readonly AgentMessage[],
): RuntimeV2TranscriptSkillGuidanceWindow[] {
  const byDocument = new Map<string, RuntimeV2TranscriptSkillGuidanceWindow[]>();
  for (const window of runtimeV2TranscriptSkillDocumentReads(messages)) {
    const prior = byDocument.get(window.documentKey);
    byDocument.set(window.documentKey, prior?.[0]?.version === window.version ? [...prior, window] : [window]);
  }
  const selected: RuntimeV2TranscriptSkillGuidanceWindow[] = [];
  for (const windows of byDocument.values()) {
    const ordered = windows.filter((window) => window.content.length > 0).sort((left, right) =>
      left.returnedRange.startChar - right.returnedRange.startChar ||
      right.returnedRange.endChar - left.returnedRange.endChar || right.order - left.order);
    let nextChar = -1;
    let index = 0;
    while (index < ordered.length) {
      if (nextChar < ordered[index]!.returnedRange.startChar) nextChar = ordered[index]!.returnedRange.startChar;
      let best: RuntimeV2TranscriptSkillGuidanceWindow | null = null;
      while (index < ordered.length && ordered[index]!.returnedRange.startChar <= nextChar) {
        const candidate = ordered[index++]!;
        if (candidate.returnedRange.endChar > nextChar && (!best ||
          candidate.returnedRange.endChar > best.returnedRange.endChar)) best = candidate;
      }
      if (best) { selected.push(best); nextChar = best.returnedRange.endChar; }
    }
  }
  return selected.sort((left, right) => left.order - right.order);
}

export function runtimeV2EvictedSkillGuidanceNotice(
  windows: readonly RuntimeV2TranscriptSkillGuidanceWindow[],
): AgentMessage {
  const documents = new Map<string, {
    readTarget: SkillReadTarget;
    evictedRanges: SkillSourceRange[];
  }>();
  for (const window of windows) {
    const key = JSON.stringify(window.readTarget);
    const document = documents.get(key) || { readTarget: window.readTarget, evictedRanges: [] };
    document.evictedRanges.push(window.returnedRange);
    documents.set(key, document);
  }
  return {
    role: "system",
    content: [
      "[runtime-v2 skill guidance visibility]",
      "These previously read Skill windows are not visible in this request because of the Run input budget. This is visibility metadata, not instruction content or evidence.",
      "If their guidance is needed, use load_skill with the exact readTarget and a listed start_line/start_char plus max_chars=endChar-startChar. Read only the needed window; these pointers grant no additional permissions.",
      JSON.stringify({ type: "skill.context_evicted", documents: [...documents.values()] }),
    ].join("\n"),
  };
}
