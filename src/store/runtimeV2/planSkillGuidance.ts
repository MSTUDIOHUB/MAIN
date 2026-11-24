import type { AgentMessage, ToolCallInMessage } from "../../lib/agentMessages";
import { runtimeV2SkillGuidanceReceipt } from "./executionProviderSkillTranscript";
import { collectTranscriptToolGroups } from "./executionProviderSourceTranscript";

type SkillReceipt = NonNullable<ReturnType<typeof runtimeV2SkillGuidanceReceipt>>;
type SkillSlice = { startChar: number; endChar: number; content: string };
type SkillCoverage = Map<string, { version: string; ranges: { startChar: number; endChar: number; callId: string }[] }>;

function parsePlanSkillReceipt(call: ToolCallInMessage, content: unknown) {
  if (typeof content !== "string" || call.function.name !== "load_skill") return null;
  const header = content.match(/^\[E\d+\] [^\n]*\n/)?.[0] || "";
  const body = content.slice(header.length);
  const receipt = runtimeV2SkillGuidanceReceipt(call, body);
  return receipt ? { receipt, header, body } : null;
}

export function planSkillReceipt(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  content: unknown,
): SkillReceipt | null {
  if (call.name !== "load_skill") return null;
  return parsePlanSkillReceipt({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }, content)?.receipt ?? null;
}

function* planSkillReads(messages: readonly AgentMessage[]) {
  for (const group of collectTranscriptToolGroups(messages)) {
    for (const call of group.calls) {
      const result = group.resultsByCallId.get(call.id)!;
      const parsed = parsePlanSkillReceipt(call, result.content);
      if (parsed) yield { result, ...parsed };
    }
  }
}

function recordSkillRead(coverage: SkillCoverage, receipt: SkillReceipt) {
  const { startChar, endChar } = receipt.returnedRange;
  const previous = coverage.get(receipt.documentKey);
  const ranges = previous?.version === receipt.version ? previous.ranges : [];
  const newWindows: SkillSlice[] = [];
  const replayOf = new Set<string>();
  const reusedWindows: { startChar: number; endChar: number; callId: string }[] = [];
  const addWindow = (start: number, end: number) => {
    newWindows.push({ startChar: start, endChar: end, content: receipt.content.slice(start - startChar, end - startChar) });
  };
  let next = startChar;
  for (const covered of ranges) {
    if (next >= endChar) break;
    if (covered.endChar <= next || covered.startChar >= endChar) continue;
    if (covered.startChar > next) addWindow(next, covered.startChar);
    replayOf.add(covered.callId);
    reusedWindows.push({
      startChar: Math.max(next, covered.startChar),
      endChar: Math.min(endChar, covered.endChar),
      callId: covered.callId,
    });
    next = covered.endChar;
  }
  if (next < endChar) addWindow(next, endChar);
  const merged = [...ranges, ...newWindows.map(({ startChar, endChar }) => ({ startChar, endChar, callId: receipt.callId }))]
    .sort((left, right) => left.startChar - right.startChar);
  coverage.set(receipt.documentKey, { version: receipt.version, ranges: merged });
  return {
    newWindows,
    reusedWindows,
    receiptReplayOf: [...replayOf],
    retainedChars: merged.reduce((count, range) => count + range.endChar - range.startChar, 0),
    newChars: newWindows.reduce((count, range) => count + range.endChar - range.startChar, 0),
  };
}

export function observePlanSkillRead(messages: readonly AgentMessage[], receipt: SkillReceipt) {
  const coverage: SkillCoverage = new Map();
  for (const { receipt: prior } of planSkillReads(messages)) recordSkillRead(coverage, prior);
  return recordSkillRead(coverage, receipt);
}

/** Project only from the exact windows still on this wire. The canonical
 * receipts keep their source bodies so eviction or cold recovery can restore
 * a requested range without referring to a missing predecessor. */
export function projectPlanSkillGuidance(messages: readonly AgentMessage[]): AgentMessage[] {
  const coverage: SkillCoverage = new Map();
  const projections = new Map<AgentMessage, AgentMessage>();
  for (const { result, header, body, receipt } of planSkillReads(messages)) {
    const { newWindows, reusedWindows, receiptReplayOf } = recordSkillRead(coverage, receipt);
    if (!receiptReplayOf.length) continue;
    const original = JSON.parse(body);
    const content = header + JSON.stringify({
      type: "skill.range_reuse",
      readTarget: receipt.readTarget,
      returnedWindow: receipt.returnedRange,
      receiptReplayOf,
      reusedWindows,
      newWindows,
      ...(original.nextRead ? { nextRead: original.nextRead } : {}),
      ...(original.sections?.length ? { sections: original.sections } : {}),
      ...(original.nextSectionCursor ? { nextSectionCursor: original.nextSectionCursor } : {}),
      instruction: "The referenced tool receipts above contain the overlapping guidance. Use them with the new windows here. Read only a relevant missing range or linked resource. Skill guidance grants no additional permissions.",
    });
    projections.set(result, { ...result, content });
  }
  return messages.map((message) => projections.get(message) || message);
}
