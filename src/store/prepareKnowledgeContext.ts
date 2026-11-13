import {
  knowledgeCitationInScope,
  freezeKnowledgeData,
  normalizeKnowledgeReferences,
  type KnowledgeContextHit,
  type KnowledgeContextPacket,
  type KnowledgeReference,
} from "../lib/knowledgeReferences";
import type { RuntimeContextBudget } from "../lib/runtimeContextBudget";

export async function prepareKnowledgeContext(input: {
  readonly references: unknown;
  readonly query: string;
  readonly budget: RuntimeContextBudget | null;
  readonly reservedInputTokens: number;
  readonly signal: AbortSignal;
}, dependencies: {
  readonly search?: (query: string, refs: readonly KnowledgeReference[], limit: number) => Promise<{ hits: readonly KnowledgeContextHit[]; note?: string }>;
} = {}): Promise<KnowledgeContextPacket | undefined> {
  const references = normalizeKnowledgeReferences(input.references);
  if (!references) throw new Error("INVALID_KNOWLEDGE_REFERENCES");
  if (!references.length) return undefined;
  input.signal.throwIfAborted();
  const remainingTokens = input.budget
    ? Math.max(0, input.budget.inputBudget - input.reservedInputTokens)
    : 8_192;
  const maxChars = Math.max(0, Math.min(input.budget?.readWindowChars ?? 12_000, remainingTokens));
  const explicitRefs = references.filter(
    (ref) => !(ref.kind === "base" && ref.activationMode === "workspace_active"),
  );
  if (explicitRefs.length === 0) {
    return freezeKnowledgeData({
      modelContextCharBudget: maxChars,
      state: "standby",
      query: "",
      references,
      hits: Object.freeze([]),
      omittedHits: 0,
      note: "Active engine manual knowledge base is in standby (zero pre-turn token injection). Call knowledge_search on demand.",
    });
  }
  const query = input.query.trim() || explicitRefs.map(ref => ref.label || "").filter(Boolean).join(" ") || "资料概览";
  try {
    const search = dependencies.search || (async (text, scope, limit) => {
      const { knowledgeSearch } = await import("../lib/ipc");
      return knowledgeSearch(text, scope, limit, { mode: "local" }, input.signal);
    });
    const result = await search(query, explicitRefs, 6);
    input.signal.throwIfAborted();
    // The final decision-view budget still accounts for complete prompts and schemas.
    // RAG uses at most half the currently available input and one shared read window.
    const hits: KnowledgeContextHit[] = [];
    let used = query.length + 1_024;
    for (const hit of result.hits) {
      if (!knowledgeCitationInScope(hit.citation, references)) throw new Error("KNOWLEDGE_SCOPE_MISMATCH");
      const cost = JSON.stringify(hit).length + JSON.stringify(references.filter(reference => knowledgeCitationInScope(hit.citation, [reference]))).length;
      if (used + cost > maxChars) continue;
      hits.push(hit);
      used += cost;
    }
    return freezeKnowledgeData({
      modelContextCharBudget: maxChars,
      state: result.hits.length ? "retrieved" : "no_hits",
      query, references, hits: Object.freeze(hits),
      omittedHits: result.hits.length - hits.length,
      note: [result.note || "", hits.length < result.hits.length ? "Some whole excerpts were omitted to preserve the Run input budget; if no hits remain, there is no source evidence for an answer. Do not claim complete coverage." : ""].filter(Boolean).join(" "),
    });
  } catch (error) {
    input.signal.throwIfAborted();
    const code = error instanceof Error ? error.message : String(error);
    const stale = code.includes("STALE_KNOWLEDGE_REFERENCE");
    return freezeKnowledgeData({ modelContextCharBudget: Math.max(0, Math.min(input.budget?.readWindowChars ?? 12_000, input.budget ? input.budget.inputBudget - input.reservedInputTokens : 8_192)), state: stale ? "stale" : "error", query, references, hits: [], note: stale
      ? "选中的资料已经更新、重建或删除，请重新选择资料。本轮没有读取替代来源。"
      : "本轮所选资料检索失败，没有可引用的知识库证据。请检查资料的索引状态后重试。" });
  }
}
