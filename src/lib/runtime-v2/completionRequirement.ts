import { looksLikeExplicitWorkspaceMutationRequest } from "../runIntent";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2CompletionRequirement } from "./contracts";
import { normalizedEvidenceUrl } from "./readOnlyProgress";

const NETWORK_REQUEST = /^(?:请\s*|帮我\s*)?(?:联网搜索|搜索网页|在线搜索|(?:打开|访问|抓取|读取)\s*(?:(?:以下|这个)?(?:网页|链接)\s*|https?:\/\/))|^(?:please\s+)?(?:(?:search|browse)\s+(?:the\s+)?(?:web|online)\b|(?:open|fetch|visit|read)\s+https?:\/\/|web_search\b|web_fetch\b)/i;

export function requestedRuntimeV2NetworkRead(objective: string, networkRequired = false): Extract<RuntimeV2CompletionRequirement, { channel: "network" }> | undefined {
  if (!networkRequired && !NETWORK_REQUEST.test(objective.trim())) return;
  const targetUrls = [...new Set(Array.from(objective.matchAll(/https?:\/\/[^\s<>`"')\]，。！？；]+/gi),
    ([url]) => normalizedEvidenceUrl(url.replace(/[.,;!?]+$/, ""))))];
  return targetUrls.length > 0
    ? { kind: "requested_operation", channel: "network", toolName: "web_fetch", targetUrls }
    : { kind: "requested_operation", channel: "network", toolName: "web_search" };
}

/** Older ledgers can still finish an explicitly requested web lookup. The
 * missing field never authorizes a tool or turns an incidental read into success. */
export function effectiveRuntimeV2CompletionRequirement(aggregate: TurnAggregateV1): RuntimeV2CompletionRequirement | undefined {
  const { completionRequirement, text } = aggregate.objective;
  if (completionRequirement) return completionRequirement;
  if (aggregate.networkRead?.enabled && !looksLikeExplicitWorkspaceMutationRequest(text)) {
    return requestedRuntimeV2NetworkRead(text);
  }
}
