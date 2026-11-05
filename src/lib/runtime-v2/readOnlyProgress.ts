import { extractReadFileWindowMetadata } from "../readFileWindow";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import type { RuntimeV2ProviderRecoveryWindow } from "./providerRecovery";
import { runtimeV2EvidenceVersion } from "./evidenceVersion";
import { latestRuntimeV2Answer, runtimeV2ProviderAnswerText } from "./providerAnswer";

export function normalizedEvidenceUrl(value: unknown): string {
  try {
    let url = new URL(String(value || ""));
    if ((url.hostname === "bing.com" || url.hostname.endsWith(".bing.com")) && url.pathname === "/ck/a") {
      const encoded = url.searchParams.get("u") || "";
      const target = encoded.startsWith("a1")
        ? new TextDecoder().decode(Uint8Array.from(atob(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)))
        : encoded;
      const destination = new URL(target);
      if (["http:", "https:"].includes(destination.protocol)) url = destination;
    }
    if (url.hostname === "r.jina.ai" && /^\/https?:\/\//.test(url.pathname)) url = new URL(url.pathname.slice(1) + url.search);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return String(value || "").trim(); }
}

function record(value: unknown): Record<string, any> | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** Query wording, rankings and provider timing are not new evidence. */
export function webEvidenceVersions(toolName: string, output: unknown): string[] | null {
  const data = record(output);
  if (!data) return null;
  const text = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  if (toolName === "web_search" && Array.isArray(data.results)) {
    return [...new Set(data.results.map((item: any) => runtimeV2EvidenceVersion({
      url: normalizedEvidenceUrl(item.url), title: text(item.title), snippet: text(item.snippet ?? item.description),
    })))].sort();
  }
  if (toolName === "web_fetch") {
    if (!text(data.content) || data.retrieval?.usable === false) return [];
    return [runtimeV2EvidenceVersion({ url: normalizedEvidenceUrl(data.finalUrl || data.final_url || data.url), content: text(data.content), truncated: data.truncated === true })];
  }
  return null;
}

export function readOnlyEvidenceVersion(toolName: string, output: unknown): string | null {
  const versions = webEvidenceVersions(toolName, output);
  return versions ? runtimeV2EvidenceVersion(versions) : null;
}

export function latestReadOnlyAnswer(state: TurnAggregateV1, input: {
  readonly allowPendingChildJoin?: boolean;
} = {}): string {
  return latestRuntimeV2Answer(state, false, input);
}

/** Count settled provider batches, never individual calls in a parallel batch.
 * Receipts and their novelty are reconstructed from the canonical ledger. */
export function deriveReadOnlyRecoveryWindow(state: TurnAggregateV1, policy: {
  readonly finalTextIsProgress?: boolean;
} = {}): RuntimeV2ProviderRecoveryWindow | null {
  if (state.pendingToolCalls.length || state.scheduledCommands.length) return null;
  const commands = new Map(state.events.flatMap((event) => event.type === "command.scheduled" ? [[event.command.idempotencyKey, event.command] as const] : []));
  const completions = new Map<string, Array<Extract<RuntimeV2Event, { type: "tool.completed" }>>>();
  for (const event of state.events) {
    if (event.type === "tool.completed") {
      const key = String(commands.get(event.idempotencyKey)?.payload.toolCallId || "");
      completions.set(key, [...(completions.get(key) || []), event]);
    }
  }
  const responses = state.events.filter((event) => event.type === "provider.responded");
  const nextResponseSequence = new Map(responses.map((event, index) => [event.sequence, responses[index + 1]?.sequence ?? Infinity]));
  const seen = new Set<string>();
  const providerCallIds = new Set(state.events.flatMap((event) => event.type === "provider.responded" ? event.result.toolCalls.map((call) => call.id) : []));
  const coverage = new Map<string, Array<[number, number]>>();
  let occurrence = 0;
  let startedAt = 0;
  // Search returns candidate locations. Reworded discovery alone cannot
  // renew the lease forever; a newly read source reopens that frontier.
  let discoveryPending = false;
  let reason: RuntimeV2ProviderRecoveryWindow["pressure"]["reason"] = "empty_response";
  const fail = (at: number, nextReason: typeof reason) => {
    if (!occurrence) startedAt = at;
    occurrence += 1;
    reason = nextReason;
  };
  for (const event of state.events) {
    // Scheduling and settling delegated work are decision boundaries, not
    // source/acceptance evidence. In particular, time spent joining a child
    // must not consume the parent's semantic-recovery lease. A failed child
    // also returns its obligation to the parent, even with no source receipt.
    if (event.type === "subagents.scheduled" || event.type === "subagent.handoff_delivered") {
      const keys = event.type === "subagents.scheduled"
        ? event.jobs.map((job) => `child-scheduled:${job.id}`)
        : [`child-delivered:${event.jobId}`, ...event.evidenceIds.map((id) => `child:${event.jobId}:${id}`)];
      if (keys.some((key) => !seen.has(key))) { occurrence = 0; discoveryPending = false; }
      keys.forEach((key) => seen.add(key));
      continue;
    }
    if (policy.finalTextIsProgress === false && event.type === "tool.completed" && event.status === "failed" &&
      !providerCallIds.has(String(commands.get(event.idempotencyKey)?.payload.toolCallId || ""))) {
      fail(event.at, "non_novel_evidence");
      continue;
    }
    if (event.type === "command.completed" && event.status === "failed" && commands.get(event.idempotencyKey)?.kind === "request_model") {
      fail(event.at, "provider_request_failed");
      continue;
    }
    if (event.type !== "provider.responded") continue;
    if (policy.finalTextIsProgress !== false && runtimeV2ProviderAnswerText(state, event)) {
      occurrence = 0;
      continue;
    }
    let novel = false;
    let sourceProgress = false;
    let searchCandidates = false;
    let settledAt = event.at;
    for (const call of event.result.toolCalls) {
      // Providers may reuse a tool-call ID in a later response. Its receipt
      // belongs only to this response's interval, never a future replay.
      const receipt = completions.get(call.id)?.find((item) => item.sequence > event.sequence && item.sequence < nextResponseSequence.get(event.sequence)!);
      if (!receipt) continue;
      settledAt = Math.max(settledAt, receipt.at);
      if (receipt.status !== "succeeded" || receipt.receiptOrigin === "replayed" || !receipt.evidence.length) continue;
      const web = webEvidenceVersions(call.name, receipt.modelContent);
      if (call.name === "web_search" && web?.length) searchCandidates = true;
      const keys = web !== null ? web.map((version) => `${call.name}:${version}`) : receipt.evidence.filter((item) => !!item.version).flatMap((item) => {
        const key = `${item.kind}:${item.target}:${item.version}`;
        const window = item.kind === "source" ? extractReadFileWindowMetadata(receipt.modelContent || "") : null;
        if (!window) return [key];
        const chars = window.returnedStartChar !== undefined && window.returnedEndChar !== undefined;
        const start = chars ? window.returnedStartChar! : window.returnedStartLine;
        const end = chars ? window.returnedEndChar! : window.returnedEndLine + 1;
        const coverageKey = `${key}:${chars ? "chars" : "lines"}`;
        const ranges = coverage.get(coverageKey) || [];
        let cursor = start;
        for (const [left, right] of ranges) {
          if (left > cursor) break;
          cursor = Math.max(cursor, right);
        }
        if (end > cursor) { novel = true; sourceProgress = true; }
        const merged: Array<[number, number]> = [];
        for (const range of [...ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0])) {
          const previous = merged[merged.length - 1];
          if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
          else merged.push([...range]);
        }
        coverage.set(coverageKey, merged);
        return [];
      });
      for (const key of keys) {
        if (!seen.has(key)) {
          if (call.name !== "web_search") { novel = true; sourceProgress = true; }
          else if (!discoveryPending) novel = true;
        }
        seen.add(key);
      }
    }
    if (sourceProgress) discoveryPending = false;
    else if (event.result.toolCalls.some((call) => call.name === "web_fetch" || call.name === "read_file")) {
      discoveryPending = false;
    } else if (searchCandidates) discoveryPending = true;
    if (novel) occurrence = 0;
    else fail(settledAt, event.result.toolCalls.length ? "non_novel_evidence" : event.result.diagnostics.some((item) => item.code === "repeated_action_rejected") ? "repeated_action_rejected" : "empty_response");
  }
  return occurrence ? { startedAt, pressure: { schemaVersion: "runtime-v2-provider-recovery.v1", reason, occurrence, stage: occurrence >= 2 ? "reframe" : "reconsider" } } : null;
}
