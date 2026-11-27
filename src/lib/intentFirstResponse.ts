import type { AppConfig } from "./appTypes";
import { normalizeLocalToolProtocol } from "./cloudProtocol";
import { buildIntentPreflightPrompt, deriveIntentStreamSettings, normalizePreflightResult, runIntentPreflight } from "./intentPreflight";
import { buildRuntimeLanguageDirective } from "./languageContract";
import { endpointLooksOpenAiCompatible } from "./localProviderRouting";
import { acquireModelLane } from "./modelLaneCoordinator";
import type { IntentPreflightResult } from "./runIntent";
import { streamChatCompletion, type StreamResult, type StreamedToolCall } from "./streaming";
import type { RuntimeV2PreparedChatAnswer } from "./submissionRuntimeContracts";

const HEADER_PREFIX = "MAIN_INTENT ";
const MAX_HEADER_CHARS = 4096;
const FIRST_READ_NAMES = new Set(["read_file", "grep_search", "glob_search", "list_directory"]);

export function supportsOmlxFirstResponse(config: AppConfig): boolean {
  return config.experimentalOmlxFirstResponse === true && config.activeProfile === "local" &&
    config.local.provider === "OMLX" && !!config.local.model && endpointLooksOpenAiCompatible(config.local.endpoint);
}

export function decodeFirstResponseHeader(text: string): { intent: unknown; body: string } | "invalid" | null {
  let start = text.trimStart();
  if (start.length < HEADER_PREFIX.length && HEADER_PREFIX.startsWith(start)) return null;
  const fenced = start.startsWith("```");
  if (fenced) {
    const newline = start.indexOf("\n");
    if (newline < 0) return start.length > 10 ? "invalid" : null;
    if (!/^```(?:json)?\s*$/i.test(start.slice(0, newline))) return "invalid";
    start = start.slice(newline + 1).trimStart();
  } else if (start === "`" || start === "``") return null;
  if (start.startsWith(HEADER_PREFIX)) start = start.slice(HEADER_PREFIX.length).trimStart();
  if (!start) return null;
  if (!start.startsWith("{")) return "invalid";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < Math.min(start.length, MAX_HEADER_CHARS); index++) {
    const char = start[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0) return start.length >= MAX_HEADER_CHARS ? "invalid" : null;
  let remainder = start.slice(end);
  if (fenced) {
    remainder = remainder.trimStart();
    if (!remainder.startsWith("```")) return "```".startsWith(remainder) ? null : "invalid";
    remainder = remainder.slice(3);
  }
  const newline = remainder.indexOf("\n");
  if (newline < 0) return remainder.trim() ? "invalid" : null;
  if (remainder.slice(0, newline).trim()) return "invalid";
  try {
    return { intent: JSON.parse(start.slice(0, end)), body: remainder.slice(newline + 1) };
  } catch {
    return "invalid";
  }
}

function firstReadProposals(intent: unknown): StreamedToolCall[] | null {
  if (!intent || typeof intent !== "object" || !("firstReads" in intent)) return [];
  if (!Array.isArray(intent.firstReads) || intent.firstReads.length > 6) return null;
  const calls: StreamedToolCall[] = [];
  for (const proposal of intent.firstReads) {
    if (!proposal || !FIRST_READ_NAMES.has(proposal.name) || !proposal.arguments ||
        typeof proposal.arguments !== "object" || Array.isArray(proposal.arguments)) return null;
    const index = calls.length;
    calls.push({ id: `first-read-${index}`, index, name: proposal.name, arguments: JSON.stringify(proposal.arguments) });
  }
  return calls;
}

export async function runIntentFirstResponse(params: Parameters<typeof runIntentPreflight>[0] & {
  config: AppConfig;
  recentConversation: readonly { role: "user" | "assistant"; content: string }[];
  mentionedPaths?: readonly string[];
  offerWorkspaceReads?: boolean;
  replyLanguage: "zh" | "en";
  onOutcome: (outcome: "admitted" | "fallback" | "canceled") => void;
}): Promise<IntentPreflightResult | null> {
  const controller = new AbortController();
  const dispose = () => controller.abort();
  params.signal?.addEventListener("abort", dispose, { once: true });
  if (params.signal?.aborted) dispose();
  const { systemPrompt, userPrompt, planContinuationCandidates } = buildIntentPreflightPrompt(params);
  const settings = deriveIntentStreamSettings(params.config);
  const offerReads = params.hasWorkspace && params.offerWorkspaceReads &&
    normalizeLocalToolProtocol(params.config.local.toolProtocol, "OMLX") !== "xml";
  const instructions = [
    `First emit ${HEADER_PREFIX.trimEnd()} followed by a space and the complete intent JSON on the same line. End that line with a newline.`,
    "For an unambiguous answer needing no capabilities and no plan continuation, write the actual user-facing answer after the first newline. For every other intent, stop after the intent line.",
    "Preserve the current user's requested answer format and literal wording. For a request to repeat text, emit exactly the requested text after the intent line.",
    ...(offerReads ? [
      'For a workspace investigation you may add firstReads to the intent JSON. Example for a referenced file: "firstReads":[{"name":"read_file","arguments":{"path":"src/file.cs"}}].',
      'Allowed firstReads: read_file(path, start_line?, end_line?), grep_search(pattern, path?), glob_search(pattern), list_directory(path?). Prefer the exact selected file. Omit firstReads for all other intents.',
    ] : []),
    buildRuntimeLanguageDirective(params.replyLanguage),
    systemPrompt,
  ].join("\n");

  let settled = false;
  let validated: IntentPreflightResult | null = null;
  let body = "";
  let streamFailed = false;
  let consumer: ((delta: string) => void) | undefined;
  let consumed = false;
  let adoptionTimer: ReturnType<typeof setTimeout> | undefined;
  let settle: (intent: IntentPreflightResult | null) => void = () => {};
  const admission = new Promise<IntentPreflightResult | null>((resolve) => { settle = resolve; });
  const canAnswerHere = (intent: IntentPreflightResult) => intent.intent === "respond" &&
    intent.semantic.workType === "answer" && intent.semantic.requiredCapabilities.length === 0 &&
    !intent.planContinuation && !params.mentionedPaths?.length;

  const finishAdmission = (intent: IntentPreflightResult | null) => {
    if (settled) return;
    settled = true;
    params.onOutcome(intent ? "admitted" : params.signal?.aborted ? "canceled" : "fallback");
    settle(intent);
  };

  const prepared: RuntimeV2PreparedChatAnswer = {
    dispose,
    async read({ signal, onText }) {
      if (consumed || signal.aborted || controller.signal.aborted) return null;
      consumed = true;
      if (adoptionTimer) clearTimeout(adoptionTimer);
      signal.addEventListener("abort", dispose, { once: true });
      consumer = onText;
      if (body) onText(body);
      try {
        const answer = await completed;
        return signal.aborted ? null : answer;
      } finally {
        consumer = undefined;
        signal.removeEventListener("abort", dispose);
      }
    },
  };

  const completed = (async (): Promise<Awaited<ReturnType<RuntimeV2PreparedChatAnswer["read"]>>> => {
    try {
      const lane = await acquireModelLane({ config: params.config, agentKind: "parent", signal: controller.signal });
      let result: StreamResult;
      try {
        result = await streamChatCompletion([
          { role: "system", content: instructions },
          ...params.recentConversation,
          { role: "user", content: params.mentionedPaths?.length
            ? JSON.stringify({ ...JSON.parse(userPrompt), mentionedPaths: params.mentionedPaths.slice(0, 12) }) : userPrompt },
        ], settings, {
          onToken: () => {},
          onDone: () => {},
          onError: () => { streamFailed = true; },
          onRequestDispatched: () => lane.markFirstToken,
          onPublicText: (publicText) => {
            if (controller.signal.aborted) return;
            const parsed = decodeFirstResponseHeader(publicText);
            if (parsed === null) return;
            if (parsed === "invalid") { dispose(); return; }
            if (!validated) {
              validated = normalizePreflightResult(parsed.intent, params.language, params.explicitIntent, undefined,
                params.input, planContinuationCandidates, params.previousInvestigation?.turnId);
              if (!validated || validated.semantic.clarification || validated.planContinuation?.kind === "ambiguous" ||
                  firstReadProposals(parsed.intent) === null) {
                dispose();
                return;
              }
              if (canAnswerHere(validated) && firstReadProposals(parsed.intent)?.length === 0) {
                adoptionTimer = setTimeout(dispose, 30_000);
                finishAdmission({ ...validated, preparedChatAnswer: prepared });
              }
            }
            if (!parsed.body.startsWith(body)) { dispose(); return; }
            const delta = parsed.body.slice(body.length);
            body = parsed.body;
            if (delta) consumer?.(delta);
          },
        }, controller.signal, [], 2048, { contextOwnership: "caller" });
      } finally {
        lane.release();
      }
      if (controller.signal.aborted || streamFailed || result.clientStopReason || result.protocolViolation ||
          result.finishReason !== "stop" || result.toolCalls.length) return null;
      // Some streams omit the trailing newline on a metadata-only reply.
      const decoded = decodeFirstResponseHeader(`${result.semanticContent ?? result.content}\n`);
      if (!decoded || decoded === "invalid") return null;
      const intent = normalizePreflightResult(decoded.intent, params.language, params.explicitIntent, undefined,
        params.input, planContinuationCandidates, params.previousInvestigation?.turnId);
      if (!intent || intent.semantic.clarification || intent.planContinuation?.kind === "ambiguous") return null;
      const proposals = firstReadProposals(decoded.intent);
      if (!proposals) return null;
      if (proposals.length) {
        if (settled || !offerReads || intent.intent !== "analyze" || !intent.semantic.requiredCapabilities.includes("workspace_read") ||
            intent.semantic.forbiddenCapabilities.includes("workspace_read")) return null;
        finishAdmission({ ...intent, preparedWorkspaceRead: { toolCalls: proposals, usage: result.usage } });
        return null;
      }
      const visibleText = decoded.body.trim();
      if (!settled) {
        if (canAnswerHere(intent) && visibleText) {
          finishAdmission({ ...intent, preparedChatAnswer: prepared });
        } else {
          finishAdmission(intent);
        }
      }
      return visibleText ? { visibleText, usage: result.usage } : null;
    } catch {
      return null;
    } finally {
      params.signal?.removeEventListener("abort", dispose);
      if (adoptionTimer) clearTimeout(adoptionTimer);
      finishAdmission(null);
    }
  })();

  return admission;
}
