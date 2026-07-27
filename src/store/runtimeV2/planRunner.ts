import type { AgentMessage } from "../../lib/agentMessages";
import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { getToolTarget } from "../../lib/toolTarget";
import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  pausedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import { sha256Hex } from "../../lib/sha256";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { streamChatCompletion } from "../../lib/streaming";
import { executeTool } from "../../lib/toolExecutor";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  WORK_PLAN_V1_SCHEMA_VERSION,
  buildRuntimeV2CapsuleProjection,
  buildRuntimeV2TimelineProjection,
  canRecordRuntimeV2Recovery,
  createRuntimeV2Checkpoint,
  finishRuntimeV2CheckpointTerminal,
  normalizeProviderResponseV1,
  runtimeV2EvidenceVersion,
  runtimeV2ActionFingerprint,
  sealWorkPlanV1,
  type CheckpointPort,
  type ProjectionPort,
  type RuntimeV2Command,
  type RuntimeV2Event,
  type RuntimeV2EventDraft,
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2Projection,
  type RuntimeV2RecoveryScope,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
  type RuntimeV2WorkPlanReference,
  type SealedWorkPlanV1,
  type TurnAggregateV1,
  type WorkPlanDraftV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import { getRuntimeV2Checkpoint, createRuntimeV2CheckpointPort } from "./checkpointPort";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import {
  createRuntimeV2PlanReviewCommit,
  resolveRuntimeV2PlanReviewFromAggregate,
  toRuntimeV2WorkPlanReference,
  type RuntimeV2PlanReviewCommit,
} from "./workPlanAdapter";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2PlanRunnerInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  readonly getSessionRevisionToken: () => unknown;
  readonly sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  readonly normalizeSessionRuntimeSnapshot: (snapshot: any) => unknown;
  readonly publishOwnerScopedRuntimeProjection: (input: {
    projectedState: any;
    durableState?: any;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
  }) => { published: boolean; disposition: string };
  readonly persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

const SUBMIT_WORK_PLAN_TOOL_NAME = "submit_runtime_v2_work_plan";
const PLAN_MODEL_COMPACTION_INTERVAL = 10;
const PLAN_MODEL_DEADLINE_MS = 8 * 60_000;
const PLAN_MODEL_REQUEST_TIMEOUT_MS = 90_000;
const PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS = 3 * 60_000;
const PLAN_DISCOVERY_DEADLINE_MS = 3 * 60_000;
const PLAN_DISCOVERY_ACTION_BUDGET = 8;
const PLAN_AUDIT_DISCOVERY_DEADLINE_MS = 2 * 60_000;
const PLAN_AUDIT_ACTION_BUDGET = 3;
const PLAN_CONTEXT_RESULT_CHARS = 10_000;
const PLAN_SYNTHESIS_EVIDENCE_CHARS = 36_000;
const PLAN_SYNTHESIS_RECOVERY_EVIDENCE_CHARS = 18_000;
const PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS = 90_000;
const PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS = 4_096;
const PLAN_READ_ONLY_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "get_file_outline",
  "git_status",
  "git_diff",
  "get_project_skeleton",
]);

const SUBMIT_WORK_PLAN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_WORK_PLAN_TOOL_NAME,
    description: "Submit an evidence-grounded plan for review. The narrative is open Markdown; only concrete changes and validations are structurally required. This does not modify project files.",
    parameters: {
      type: "object",
      properties: {
        planMarkdown: {
          type: "string",
          description: "Free task-specific Markdown for the diagnosis, approach, decisions, or caveats that add value. State proved causes rather than guesses. Do not repeat the changes or validation lists; the runtime renders those.",
        },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              operation: {
                type: "string",
                enum: ["modify", "create", "delete", "preserve"],
              },
              targets: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
              change: {
                type: "string",
                description: "The exact code, contract, or behavior change. Include relevant symbols and preserved boundaries.",
              },
              expectedOutcome: { type: "string" },
            },
            required: ["targets", "change"],
          },
        },
        validations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop", "assertion", "advisory"],
              },
              command: {
                type: "string",
                description: "Only for finite_command. Use a bounded build, test, check, or lint command; never a dev server, watcher, or manual instruction.",
              },
              cwd: { type: "string" },
              expectedOutcome: {
                type: "string",
                description: "The observable pass condition. Put browser or desktop interaction details here.",
              },
              required: { type: "boolean" },
            },
            required: ["kind", "expectedOutcome"],
          },
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "Optional decisions that genuinely require the user. Omit when evidence resolves the task.",
        },
      },
      required: [
        "planMarkdown",
        "changes",
        "validations",
      ],
    },
  },
};

const PLAN_MODEL_TOOLS = [
  ...TOOL_DEFINITIONS.filter((definition) =>
    PLAN_READ_ONLY_TOOL_NAMES.has(definition.function.name)
  ),
  SUBMIT_WORK_PLAN_TOOL,
];
const PLAN_AUDIT_TOOLS = PLAN_MODEL_TOOLS.filter(
  (definition) => definition.function.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
);

type PlanModelStage =
  | "discovery"
  | "synthesis"
  | "audit_discovery"
  | "audit_synthesis";

function isPlanSubmissionStage(stage: PlanModelStage): boolean {
  return stage === "synthesis" || stage === "audit_synthesis";
}

function boundedContent(value: unknown, max = PLAN_CONTEXT_RESULT_CHARS): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const text = String(raw || "").trim();
  return text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 48))}\n[Runtime v2 truncated this read result.]`;
}

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find((turn: ConversationTurn) => turn.id === turnId) || null;
}

function sessionEpochFor(state: any, context: RuntimeV2SubmissionContext, turn: ConversationTurn): string {
  const lifecycle = state?.planLifecycle;
  if (lifecycle?.sessionKey === context.runSessionKey && String(lifecycle.sessionEpoch || "").trim()) {
    return String(lifecycle.sessionEpoch).trim();
  }
  return `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
}

function identities(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): { readonly turn: RuntimeV2TurnIdentity; readonly run: RuntimeV2RunIdentity } {
  const sessionEpoch = sessionEpochFor(state, context, turn);
  return {
    turn: {
      workspaceKey: String(context.runWorkspace || "global").trim() || "global",
      sessionKey: context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
      turnId: context.turnId,
    },
    run: {
      sessionKey: context.runSessionKey,
      sessionEpoch,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      attemptId: context.harnessRunId,
    },
  };
}

function settlement(
  context: RuntimeV2SubmissionContext,
  outcome: AgentLoopOutcome = pausedAgentLoopOutcome(
    "runtime_v2_plan_review_required",
    "action_required",
  ),
): RuntimeRunSettlement {
  return {
    disposition: "projected",
    reason: outcome.reason,
    identity: {
      sessionKey: context.runSessionKey,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      outerRunId: context.harnessRunId,
    },
    outcome,
  };
}

function terminalAgentOutcome(
  resultKind: RuntimeV2ResultKind,
  reason: string,
): AgentLoopOutcome {
  return resultKind === "canceled"
    ? abortedAgentLoopOutcome(reason)
    : completedAgentLoopOutcome(reason, resultKind);
}

class PlanLedger {
  private revision: number;
  private aggregate: TurnAggregateV1 | null;
  private ordinal = 0;
  private lastAt = 0;

  constructor(
    private readonly owner: RuntimeV2TurnIdentity,
    private readonly port: CheckpointPort,
    private readonly projection: ProjectionPort,
    initial: { readonly revision: number; readonly aggregate: TurnAggregateV1 } | null,
  ) {
    this.revision = initial?.revision || 0;
    this.aggregate = initial?.aggregate || null;
    this.lastAt = initial?.aggregate.updatedAt || 0;
  }

  snapshot(): TurnAggregateV1 | null {
    return this.aggregate;
  }

  nextId(scope: string): string {
    this.ordinal += 1;
    return `${scope}:${this.owner.turnId}:${Date.now().toString(36)}:${this.ordinal}`;
  }

  private eventBase() {
    const at = Math.max(Date.now(), this.lastAt);
    this.lastAt = at;
    return {
      schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: this.aggregate?.nextSequence || 0,
      eventId: this.nextId("runtime-v2-plan-event"),
      at,
    };
  }

  async append(draft: RuntimeV2EventDraft): Promise<RuntimeV2Event> {
    const event = { ...draft, ...this.eventBase() } as RuntimeV2Event;
    const result = await this.port.append({
      owner: this.owner,
      expectedRevision: this.revision,
      event,
    });
    if (result.disposition === "conflict" || !result.checkpoint) {
      throw new Error("RUNTIME_V2_PLAN_CHECKPOINT_CONFLICT");
    }
    this.revision = result.checkpoint.revision;
    this.aggregate = result.checkpoint.aggregate;
    return event;
  }

  async schedule(
    run: RuntimeV2RunIdentity,
    kind: RuntimeV2Command["kind"],
    payload: Readonly<Record<string, unknown>>,
  ): Promise<RuntimeV2Command> {
    const phase = this.aggregate?.phase;
    if (!phase || phase === "completed") throw new Error("RUNTIME_V2_PLAN_RUN_NOT_ACTIVE");
    const command: RuntimeV2Command = {
      idempotencyKey: this.nextId(`runtime-v2-plan-${kind}`),
      kind,
      run,
      phase,
      payload,
    };
    await this.append({
      type: "command.scheduled",
      run,
      command,
    });
    const aggregate = this.aggregate!;
    await this.publish(buildRuntimeV2CapsuleProjection(
      aggregate,
      this.nextId("runtime-v2-plan-capsule"),
    ));
    await this.publish(buildRuntimeV2TimelineProjection(
      this.aggregate!,
      command,
      this.nextId("runtime-v2-plan-timeline"),
    ));
    return command;
  }

  async publish(projection: RuntimeV2Projection): Promise<void> {
    const aggregate = this.aggregate;
    const run = aggregate?.run?.identity;
    if (!aggregate || !run) throw new Error("RUNTIME_V2_PLAN_RUN_NOT_ACTIVE");
    const event = await this.append({
      type: "projection.published",
      run,
      audience: projection.audience,
      projectionId: projection.id,
      projection,
    });
    try {
      await this.projection.publish({
        aggregate: this.aggregate!,
        audience: projection.audience,
        projection,
        event: event as Extract<RuntimeV2Event, { type: "projection.published" }>,
      });
    } catch {
      // The durable projection event is replay authority. Presentation failure
      // must not strand a command or turn the Plan Run into a model retry.
    }
  }

  async settleScheduled(
    run: RuntimeV2RunIdentity,
    status: "succeeded" | "failed" | "canceled",
  ): Promise<void> {
    for (const command of [...(this.aggregate?.scheduledCommands || [])]) {
      await this.append({
        type: "command.completed",
        run,
        idempotencyKey: command.idempotencyKey,
        status,
      });
    }
  }

  async recordRecovery(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly scope: RuntimeV2RecoveryScope;
    readonly fingerprint: string;
    readonly reason: string;
  }): Promise<boolean> {
    const aggregate = this.aggregate;
    if (!aggregate || aggregate.recovery.exhausted) return false;
    if (canRecordRuntimeV2Recovery(
      aggregate.recovery,
      input.scope,
      input.fingerprint,
    )) {
      await this.append({
        type: "recovery.recorded",
        run: input.run,
        scope: input.scope,
        fingerprint: input.fingerprint,
      });
      return true;
    }
    await this.append({
      type: "recovery.exhausted",
      run: input.run,
      scope: input.scope,
      fingerprint: input.fingerprint,
      reason: input.reason,
    });
    return false;
  }

  async recordSoftSignal(
    run: RuntimeV2RunIdentity,
    signal: "no_tool_call" | "empty_response" | "repeat" | "context_pressure" | "iteration_limit",
  ): Promise<void> {
    await this.append({ type: "soft_signal.observed", run, signal });
  }

  async finishTerminal(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly resultKind: RuntimeV2ResultKind;
    readonly reason: string;
    readonly finalMarkdown?: string;
  }): Promise<void> {
    const aggregate = this.aggregate;
    if (!aggregate || !aggregate.run) throw new Error("RUNTIME_V2_PLAN_RUN_NOT_ACTIVE");
    const checkpoint = await finishRuntimeV2CheckpointTerminal({
      checkpoint: this.port,
      projection: this.projection,
      owner: this.owner,
      run: input.run,
      current: createRuntimeV2Checkpoint({
        revision: this.revision,
        aggregate,
        updatedAt: aggregate.updatedAt,
      }),
      resultKind: input.resultKind,
      reason: input.reason,
      ...(input.finalMarkdown ? { finalMarkdown: input.finalMarkdown } : {}),
      now: Date.now,
      nextId: (scope) => this.nextId(scope),
    });
    this.revision = checkpoint.revision;
    this.aggregate = checkpoint.aggregate;
    this.lastAt = checkpoint.aggregate.updatedAt;
  }
}

function providerMessages(input: {
  readonly turn: ConversationTurn;
  readonly context: RuntimeV2SubmissionContext;
  readonly overview: string;
}): AgentMessage[] {
  const language = input.context.phaseLanguage === "en" ? "English" : "简体中文";
  return [
    {
      role: "system",
      content: [
        "[MAIN RUNTIME V2 PLAN]",
        `Workspace: ${input.context.runWorkspace || "global"}`,
        `Respond in: ${language}`,
        "You are preparing a reviewable plan, not implementing it. Only the supplied read-only tools and submit_runtime_v2_work_plan are available.",
        "Base the plan on tool evidence. Do not invent source facts, edit project files, or write plan.md.",
        "Read every exact modify/delete target before submitting; the runtime binds its versioned evidence automatically.",
        "Trace the complete cause across owners before submitting. If an investigated owner must remain unchanged, say so in the narrative or add a preserve change instead of proposing an unnecessary edit.",
        "When evidence is sufficient, call submit_runtime_v2_work_plan exactly once. Write task-specific Markdown rather than filling a fixed report template.",
        "The submission only needs a concrete change list and validation list. The runtime owns evidence binding, dependencies, approval identity and rendering.",
        "Use finite_command for a bounded build/test/check command when the workspace provides one. Use browser only for web DOM behavior and desktop for native GUI behavior; put interaction details in expectedOutcome, not command.",
        "Use questions only for a real user-owned decision.",
      ].join("\n"),
    },
    { role: "user", content: input.turn.userPrompt },
    {
      role: "user",
      content: `[E1] workspace overview\n${boundedContent(input.overview, 12_000)}`,
    },
  ];
}

function boundedPlanTranscript(messages: readonly AgentMessage[]): AgentMessage[] {
  if (messages.length <= 24) return [...messages];
  // The plan authority and the user's objective must never fall out of the
  // provider window. Retain complete recent assistant/tool pairs behind them.
  return [
    ...messages.slice(0, 3),
    ...messages.slice(-(24 - Math.min(3, messages.length))),
  ];
}

function compactRetainedPlanObservation(value: string, max: number): string {
  if (value.length <= max) return value;
  const window = Math.max(1, Math.floor((max - 120) / 3));
  const middle = Math.max(0, Math.floor((value.length - window) / 2));
  return [
    value.slice(0, window),
    "[Runtime v2 omitted unchanged middle context.]",
    value.slice(middle, middle + window),
    "[Runtime v2 omitted unchanged middle context.]",
    value.slice(-window),
  ].join("\n");
}

function latestSubmittedPlanArguments(
  messages: readonly AgentMessage[],
  beforeIndex = messages.length,
): string {
  return messages
    .slice(0, beforeIndex)
    .reverse()
    .flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
        return [];
      }
      const call = [...message.tool_calls].reverse().find(
        (entry) => entry.function?.name === SUBMIT_WORK_PLAN_TOOL_NAME,
      );
      return call ? [String(call.function.arguments || "")] : [];
    })[0] || "";
}

function compactPlanEvidencePacket(input: {
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly charBudget?: number;
}): string {
  const charBudget = input.charBudget || PLAN_SYNTHESIS_EVIDENCE_CHARS;
  const perEvidenceBudget = Math.max(
    input.charBudget ? 1_400 : 2_400,
    Math.min(
      8_000,
      Math.floor(
        charBudget / Math.max(1, input.evidence.length),
      ),
    ),
  );
  return [
    "[Runtime v2 evidence packet]",
    ...input.evidence.map((entry) => {
      const observed = input.evidenceContents.get(entry.id) || entry.statement;
      return [
        `${entry.id} · ${entry.target} · ${entry.version || "unversioned"}`,
        compactRetainedPlanObservation(observed, perEvidenceBudget),
      ].join("\n");
    }),
  ].join("\n\n");
}

function synthesisPlanTranscript(input: {
  readonly messages: readonly AgentMessage[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly audit: boolean;
  readonly compactRecovery: boolean;
}): AgentMessage[] {
  let lastSubmissionOutcomeIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (
      message.role === "tool" &&
      /^WORK_PLAN_(?:REJECTED|DRAFT_ACCEPTED_FOR_AUDIT)\b/.test(
        String(message.content || ""),
      )
    ) {
      lastSubmissionOutcomeIndex = index;
      break;
    }
  }
  const lastSubmissionOutcome = lastSubmissionOutcomeIndex >= 0
    ? input.messages[lastSubmissionOutcomeIndex]
    : null;
  const lastRejection = lastSubmissionOutcome &&
    String(lastSubmissionOutcome.content || "").startsWith("WORK_PLAN_REJECTED:")
    ? lastSubmissionOutcome
    : null;
  const rejectedSubmission = lastRejection
    ? latestSubmittedPlanArguments(input.messages, lastSubmissionOutcomeIndex)
    : "";
  if (lastRejection && rejectedSubmission) {
    return [
      ...input.messages.slice(0, 2),
      {
        role: "system",
        content: "Correct the rejected WorkPlan structure and call submit_runtime_v2_work_plan. Do not investigate again.",
      },
      {
        role: "user",
        content: [
          `Validation feedback:\n${String(lastRejection.content || "").slice(0, 4_000)}`,
          `Rejected submission to correct:\n${rejectedSubmission.slice(0, 12_000)}`,
        ].join("\n\n"),
      },
    ];
  }
  return [
    ...input.messages.slice(0, 3),
    {
      role: "user",
      content: compactPlanEvidencePacket({
        ...input,
        ...(input.compactRecovery
          ? { charBudget: PLAN_SYNTHESIS_RECOVERY_EVIDENCE_CHARS }
          : {}),
      }),
    },
    {
      role: "system",
      content: [
        ...(input.compactRecovery
          ? [
              "The preceding synthesis request was closed at the transport deadline. This is the single bounded recovery request: use only this compact evidence packet and submit one complete plan now.",
            ]
          : []),
        input.audit
        ? [
            "This is the mandatory evidence audit. Write the final plan independently from the audited evidence; do not preserve the first draft's wording, target choices, or assumptions.",
            "For every user-reported symptom, verify an exact trigger → function or contract → state transition → visible outcome chain from the retained source.",
            "Challenge plausible but unproved explanations. Check initial placeholder state, programmatic UI updates versus user input, and serialized argument names across framework or language boundaries whenever the evidence contains them.",
            "Account for each relevant source owner with a concrete modify or preserve decision. Remove unnecessary changes, source-sized code patches, unresolved source-reading questions, dev servers, and manual instructions from command fields.",
          ].join(" ")
        : [
            "The read-only discovery window is closed. Call submit_runtime_v2_work_plan now; no other tool is available.",
            "Before submitting, reconcile the evidence into a concrete causal chain, cover every required source owner with a modify or preserve decision, and use observable bounded validation.",
            "Do not submit speculation, a dev-server command as a finite check, or manual click instructions in the command field.",
          ].join(" "),
      ].join(" "),
    },
  ];
}

function auditDiscoveryPlanTranscript(input: {
  readonly messages: readonly AgentMessage[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
}): AgentMessage[] {
  return [
    ...input.messages.slice(0, 3),
    {
      role: "user",
      content: compactPlanEvidencePacket(input),
    },
    {
      role: "system",
      content: [
        "Perform an independent evidence audit; do not rely on or repair the first draft.",
        "Use exactly one read-only action now to investigate the most consequential causal link that the current evidence does not make exact.",
        "Compare every user-reported symptom with an exact trigger → function or contract → state transition → visible outcome chain.",
        "Prioritize a missing source owner or a different source window; do not reread an unchanged observation.",
        "You cannot submit during this bounded audit-discovery pass. The runtime will request one final corrected plan after the audit reads close.",
      ].join(" "),
    },
  ];
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isProviderRequestTimeout(
  error: unknown,
  requestSignal: AbortSignal,
  parentSignal: AbortSignal,
): boolean {
  if (parentSignal.aborted) return false;
  if (requestSignal.aborted) return true;
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error || "");
  return name === "AbortError" ||
    /\b(?:STREAM|HTTP|PROVIDER)[A-Z0-9_ -]*TIMEOUT\b/i.test(detail) ||
    /\b(?:timed?\s*out|timeout)\b/i.test(detail);
}

function parseJsonArrayFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  required = false,
): readonly unknown[] {
  const field = fields.find((candidate) => record[candidate] !== undefined);
  if (!field) {
    if (required) throw new Error(`${fields[0]} is required.`);
    return [];
  }
  const value = record[field];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a JSON array string.`);
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${field} must decode to an array.`);
  return parsed;
}

function parseArrayFields(
  record: Record<string, unknown>,
  directFields: readonly string[],
  legacyJsonFields: readonly string[],
  required = false,
): readonly unknown[] {
  const directField = directFields.find((candidate) => record[candidate] !== undefined);
  if (directField) {
    const value = record[directField];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    }
    throw new Error(`${directField} must be an array or JSON array string.`);
  }
  return parseJsonArrayFields(record, legacyJsonFields, required);
}

function workPlanDraftFromSubmission(
  candidate: Record<string, unknown>,
  evidence: readonly WorkPlanRuntimeEvidence[],
  objective: string,
): { readonly draft: WorkPlanDraftV1; readonly normalized: boolean } {
  const raw = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: String(objective || candidate.objective || ""),
    summary: String(
      candidate.planMarkdown ||
      candidate.plan ||
      candidate.summary ||
      objective ||
      "",
    ),
    findings: parseJsonArrayFields(
      candidate,
      ["findingsJson"],
    ) as WorkPlanDraftV1["findings"],
    steps: parseArrayFields(
      candidate,
      ["changes"],
      ["changesJson", "stepsJson"],
      true,
    ) as readonly Record<string, any>[],
    validations: parseArrayFields(
      candidate,
      ["validations"],
      ["validationJson", "validationsJson"],
      true,
    ) as readonly Record<string, any>[],
    risks: parseJsonArrayFields(
      candidate,
      ["risksJson"],
    ) as WorkPlanDraftV1["risks"],
    assumptions: parseJsonArrayFields(
      candidate,
      ["assumptionsJson"],
    ) as WorkPlanDraftV1["assumptions"],
    blockingQuestions: parseArrayFields(
      candidate,
      ["questions"],
      ["questionsJson", "blockingQuestionsJson"],
    ) as WorkPlanDraftV1["blockingQuestions"],
  };
  const knownEvidenceIds = new Set(evidence.map((entry) => entry.id));
  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  const knownBasis = (value: unknown): string[] => stringList(value).filter(
    (id) => knownEvidenceIds.has(id),
  );
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((step, index) => {
    const targets = stringList(
      Array.isArray(step?.targets)
        ? step.targets
        : Array.isArray(step?.files)
        ? step.files
        : typeof step?.target === "string"
        ? [step.target]
        : [],
    );
    const targetEvidenceIds = evidence.filter((entry) =>
      entry.version &&
      targets.some((target) =>
        workspacePathsReferToSameFile(entry.target, target)
      )
    ).map((entry) => entry.id);
    const requestedOperation = String(step?.operation || "").trim();
    const operation = (
      ["modify", "create", "delete", "preserve"] as const
    ).find((candidateOperation) => candidateOperation === requestedOperation) || (
      targets.length > 0 &&
      targets.every((target) =>
        evidence.some((entry) =>
          !!entry.version && workspacePathsReferToSameFile(entry.target, target)
        )
      )
        ? "modify"
        : "create"
    );
    const change = String(
      step?.change ||
      step?.approach ||
      step?.description ||
      "",
    ).trim();
    const expectedOutcome = String(
      step?.expectedOutcome ||
      step?.outcome ||
      change,
    ).trim();
    const dependsOn = (Array.isArray(step?.dependsOn) ? step.dependsOn : [])
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value))
      .map((value: number) =>
        value >= index && value > 0 && value - 1 < index ? value - 1 : value
      )
      .filter((value: number) => value >= 0 && value < index);
    return {
      title: String(step?.title || change || targets[0] || `Step ${index + 1}`),
      operation,
      targets,
      basis: [...new Set([
        ...knownBasis(step?.basis),
        ...targetEvidenceIds,
      ])],
      change,
      expectedOutcome,
      dependsOn: [...new Set(dependsOn)],
    };
  }) as WorkPlanDraftV1["steps"];
  const rawValidationIndexes = (Array.isArray(raw.validations) ? raw.validations : [])
    .flatMap((validation) => Array.isArray(validation?.stepIndexes)
      ? validation.stepIndexes.map(Number).filter(Number.isInteger)
      : []);
  const oneBasedValidationIndexes =
    rawValidationIndexes.length > 0 &&
    !rawValidationIndexes.includes(0) &&
    rawValidationIndexes.some((index) => index === steps.length);
  const validations: Array<WorkPlanDraftV1["validations"][number]> = (
    Array.isArray(raw.validations) ? raw.validations : []
  ).map(
    (validation) => {
      const requestedCommand = typeof validation?.command === "string"
        ? validation.command.trim()
        : "";
      const requestedKind = String(validation?.kind || "").trim();
      const kind = (
        ["finite_command", "browser", "desktop", "assertion", "advisory"] as const
      ).find((candidateKind) => candidateKind === requestedKind) || (
        requestedCommand ? "finite_command" : "assertion"
      );
      const command = kind === "finite_command" ? requestedCommand : "";
      const suppliedStepIndexes = Array.isArray(validation?.stepIndexes)
        ? validation.stepIndexes
        : [];
      const stepIndexes = suppliedStepIndexes.length > 0
        ? [...new Set(
            suppliedStepIndexes
              .map((value: unknown) => Number(value))
              .filter((index: number) => Number.isInteger(index))
              .map((index: number) => oneBasedValidationIndexes ? index - 1 : index)
              .filter((index: number) => index >= 0 && index < steps.length),
          )]
        : steps.flatMap((step, index) => step.operation === "preserve" ? [] : [index]);
      return {
        stepIndexes,
        kind,
        ...(command ? { command } : {}),
        ...(typeof validation?.cwd === "string" && validation.cwd.trim()
          ? { cwd: validation.cwd.trim() }
          : {}),
        expectedOutcome: String(
          validation?.expectedOutcome ||
          validation?.outcome ||
          command ||
          "修改后的行为符合计划中的预期结果。",
        ).trim(),
        required:
          validation?.required !== false &&
          kind !== "assertion" &&
          kind !== "advisory",
      };
    },
  ) as Array<WorkPlanDraftV1["validations"][number]>;
  const executableStepIndexes = steps.flatMap((step, index) =>
    step.operation === "preserve" ? [] : [index]
  );
  const firstRequiredValidation = validations.findIndex(
    (validation) => validation.required,
  );
  if (firstRequiredValidation >= 0) {
    const covered = new Set(validations.flatMap((validation) =>
      validation.required ? validation.stepIndexes : []
    ));
    const uncovered = executableStepIndexes.filter((index) => !covered.has(index));
    if (uncovered.length > 0) {
      const validation = validations[firstRequiredValidation]!;
      validations[firstRequiredValidation] = {
        ...validation,
        stepIndexes: [...new Set([...validation.stepIndexes, ...uncovered])],
      };
    }
  }
  const draft: WorkPlanDraftV1 = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: raw.objective,
    summary: raw.summary,
    findings: (Array.isArray(raw.findings) ? raw.findings : []).map((finding) => ({
      statement: String(finding?.statement || ""),
      basis: knownBasis(finding?.basis),
    })),
    steps,
    validations,
    risks: stringList(raw.risks),
    assumptions: stringList(raw.assumptions),
    blockingQuestions: stringList(raw.blockingQuestions),
  };
  return {
    draft,
    normalized: JSON.stringify(draft) !== JSON.stringify(raw),
  };
}

async function requestPlanModel(input: {
  readonly get: StoreGet;
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
  readonly deadlineAt: number;
  readonly stage: PlanModelStage;
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly compactRecovery?: boolean;
  readonly logStoreEvent: RuntimeV2PlanRunnerInput["logStoreEvent"];
}): Promise<RuntimeV2NormalizedProviderResult> {
  const submissionStage = isPlanSubmissionStage(input.stage);
  const offeredTools = submissionStage
    ? [SUBMIT_WORK_PLAN_TOOL]
    : input.stage === "audit_discovery"
    ? PLAN_AUDIT_TOOLS
    : PLAN_MODEL_TOOLS;
  const toolChoice = submissionStage
    ? {
        type: "function" as const,
        function: { name: SUBMIT_WORK_PLAN_TOOL_NAME },
      }
    : "required" as const;
  const command = await input.ledger.schedule(input.run, "request_model", {
    mode: "plan",
    stage: input.stage,
    toolExpectation: "required",
    objective: input.ledger.snapshot()?.objective.text || "",
    evidenceIds: input.ledger.snapshot()?.evidence.map((entry) => entry.id) || [],
  });
  let streamedText = "";
  const requestAbort = new AbortController();
  let requestTimedOut = false;
  const forwardAbort = () => requestAbort.abort(input.context.abortCtrl.signal.reason);
  if (input.context.abortCtrl.signal.aborted) {
    forwardAbort();
  } else {
    input.context.abortCtrl.signal.addEventListener("abort", forwardAbort, { once: true });
  }
  const requestTimeoutMs = Math.max(1, Math.min(
    submissionStage
      ? input.compactRecovery
        ? PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS
        : PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS
      : PLAN_MODEL_REQUEST_TIMEOUT_MS,
    input.deadlineAt - Date.now(),
  ));
  const requestTimeout = setTimeout(() => {
    requestTimedOut = true;
    requestAbort.abort("runtime_v2_plan_provider_request_timeout");
  }, requestTimeoutMs);
  const requestMessages = input.stage === "synthesis"
    ? synthesisPlanTranscript({
        ...input,
        audit: false,
        compactRecovery: !!input.compactRecovery,
      })
    : input.stage === "audit_synthesis"
    ? synthesisPlanTranscript({
        ...input,
        audit: true,
        compactRecovery: !!input.compactRecovery,
      })
    : input.stage === "audit_discovery"
    ? auditDiscoveryPlanTranscript(input)
    : boundedPlanTranscript(input.messages);
  try {
    input.logStoreEvent("runtime_v2_plan_provider_request_opened", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
      stage: input.stage,
      compactRecovery: !!input.compactRecovery,
      offeredToolCount: offeredTools.length,
      offeredToolNames: offeredTools.map((tool) => tool.function.name),
      promptMessageCount: requestMessages.length,
      promptChars: requestMessages.reduce(
        (total, message) => total + String(message.content || "").length,
        0,
      ),
      timeoutMs: requestTimeoutMs,
    });
    const result = await streamChatCompletion(
      requestMessages,
      deriveStreamSettings(input.get().config),
      {
        onToken: (token) => { streamedText += token; },
        onDone: () => undefined,
        onError: () => undefined,
      },
      requestAbort.signal,
      offeredTools,
      input.compactRecovery ? PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS : undefined,
      { toolChoice, timeoutMs: requestTimeoutMs },
    );
    const normalized = normalizeProviderResponseV1({
      visibleText: result.content || streamedText,
      toolCalls: result.toolCalls,
      usage: result.usage,
      diagnostics: result.protocolViolation
        ? [{ code: result.protocolViolation, message: "Plan tool protocol mismatch", retryable: true }]
        : [],
    });
    await input.ledger.append({
      type: "provider.responded",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      result: normalized,
    });
    input.messages.push({
      role: "assistant",
      content: result.content || streamedText,
      ...(result.toolCalls.length > 0
        ? {
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    });
    return normalized;
  } catch (error) {
    const providerRequestTimedOut = requestTimedOut || isProviderRequestTimeout(
      error,
      requestAbort.signal,
      input.context.abortCtrl.signal,
    );
    await input.ledger.append({
      type: "command.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: input.context.abortCtrl.signal.aborted ? "canceled" : "failed",
    });
    input.logStoreEvent("runtime_v2_plan_provider_request_closed", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      stage: input.stage,
      timeoutMs: requestTimeoutMs,
      timedOut: providerRequestTimedOut,
      errorName: error instanceof Error ? error.name : "",
      error: error instanceof Error ? error.message : String(error || ""),
    });
    throw providerRequestTimedOut
      ? new Error("RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT")
      : error;
  } finally {
    clearTimeout(requestTimeout);
    input.context.abortCtrl.signal.removeEventListener("abort", forwardAbort);
  }
}

async function settlePlanTool(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly status: "succeeded" | "failed" | "blocked";
  readonly evidence?: readonly RuntimeV2EvidenceReference[];
}): Promise<void> {
  const command = await input.ledger.schedule(input.run, "execute_tool", {
    toolCallId: input.call.id,
    toolName: input.call.name,
    arguments: input.call.arguments,
  });
  await input.ledger.append({
    type: "tool.completed",
    run: input.run,
    idempotencyKey: command.idempotencyKey,
    status: input.status,
    evidence: input.evidence || [],
  });
}

async function executeReadOnlyPlanTool(input: {
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly messages: AgentMessage[];
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly logStoreEvent: RuntimeV2PlanRunnerInput["logStoreEvent"];
}): Promise<boolean> {
  const args = input.call.arguments;
  const fingerprint = `plan-read:${input.call.name}:${sha256Hex(JSON.stringify(args))}`;
  if (!PLAN_READ_ONLY_TOOL_NAMES.has(input.call.name)) {
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "blocked",
    });
    input.messages.push({
      role: "tool",
      tool_call_id: input.call.id,
      content: "PLAN_TOOL_BLOCKED: use a read-only tool or submit_runtime_v2_work_plan.",
    });
    return input.ledger.recordRecovery({
      run: input.run,
      scope: "action",
      fingerprint,
      reason: `Plan 模型重复请求未授权工具 ${input.call.name}，动作恢复预算已耗尽。`,
    });
  }
  try {
    const output = await executeTool(
      input.call.name,
      args,
      input.context.runWorkspace || "",
      input.context.runSessionKey,
    );
    const target = getToolTarget(input.call.name, args) || input.call.name;
    const content = boundedContent(output);
    // A read window is an observation, not a source version. Hash the exact
    // file content under the same workspace authority so different windows of
    // one unchanged file share one evidence identity without hiding the newly
    // observed window from the model.
    const versionPayload = input.call.name === "read_file"
      ? await executeTool(
          "read_file",
          { ...args, __raw: true },
          input.context.runWorkspace || "",
          input.context.runSessionKey,
        )
      : output;
    const version = runtimeV2EvidenceVersion(versionPayload);
    const existingEvidence = input.evidence.find((entry) =>
      workspacePathsReferToSameFile(entry.target, target) &&
      entry.version === version
    );
    const evidenceEntry = existingEvidence || {
      id: `E${input.evidence.length + 1}`,
      target,
      version,
      statement: `${input.call.name} 已确认 ${target} 的当前内容。`,
    };
    const previousContent = existingEvidence
      ? input.evidenceContents.get(existingEvidence.id) || ""
      : "";
    const repeatedObservation = !!existingEvidence && (
      previousContent === content ||
      previousContent.includes(content)
    );
    if (!existingEvidence) {
      input.evidence.push(evidenceEntry);
      input.evidenceContents.set(evidenceEntry.id, content);
    } else if (!repeatedObservation) {
      input.evidenceContents.set(
        evidenceEntry.id,
        compactRetainedPlanObservation(
          [
            previousContent,
            `[Additional read window for ${target}]`,
            content,
          ].filter(Boolean).join("\n\n"),
          PLAN_CONTEXT_RESULT_CHARS * 2,
        ),
      );
    }
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "succeeded",
      evidence: [{
        id: evidenceEntry.id,
        kind: "source",
        target,
        version,
      }],
    });
    input.messages.push({
      role: "tool",
      tool_call_id: input.call.id,
      content: existingEvidence && repeatedObservation
        ? `[${evidenceEntry.id}] ${target}\nRuntime v2 reused this unchanged source and observation.`
        : `[${evidenceEntry.id}] ${target}\n${content}`,
    });
    input.logStoreEvent(!existingEvidence
      ? "runtime_v2_plan_read_completed"
      : repeatedObservation
      ? "runtime_v2_plan_read_reused"
      : "runtime_v2_plan_read_extended", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      toolName: input.call.name,
      target,
      evidenceId: evidenceEntry.id,
      sourceVersion: version,
      observationVersion: runtimeV2EvidenceVersion(output),
      retainedChars: input.evidenceContents.get(evidenceEntry.id)?.length || 0,
    });
    return true;
  } catch (error) {
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "failed",
    });
    input.messages.push({
      role: "tool",
      tool_call_id: input.call.id,
      content: `PLAN_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    });
    return input.ledger.recordRecovery({
      run: input.run,
      scope: "action",
      fingerprint,
      reason: `读取 ${input.call.name} 的同一结构化目标持续失败，动作恢复预算已耗尽。`,
    });
  }
}

async function writeReviewArtifact(input: {
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly plan: SealedWorkPlanV1;
}): Promise<void> {
  const command = await input.ledger.schedule(input.run, "execute_tool", {
    toolName: "write_file",
    target: ".MAIN/plans/plan.md",
    runtimeOwnedPlanArtifact: true,
  });
  try {
    await executeTool(
      "write_file",
      { path: ".MAIN/plans/plan.md", content: input.plan.markdown },
      input.context.runWorkspace || "",
      input.context.runSessionKey,
    );
    await input.ledger.append({
      type: "tool.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: "succeeded",
      evidence: [{
        id: `plan-artifact:${input.plan.id}:${input.plan.revision}`,
        kind: "tool",
        target: ".MAIN/plans/plan.md",
        version: input.plan.projectionHash,
      }],
    });
  } catch (error) {
    await input.ledger.append({
      type: "tool.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: "failed",
      evidence: [],
    });
    throw error;
  }
}

function reviewRequest(commit: RuntimeV2PlanReviewCommit) {
  return {
    schemaVersion: 1 as const,
    requestId: commit.review.requestId,
    kind: "plan_review" as const,
    sessionKey: commit.review.sessionKey,
    sessionEpoch: commit.review.sessionEpoch,
    turnId: commit.review.turnId,
    runId: commit.review.runId,
    parentRunId: commit.review.parentRunId,
    title: "计划已准备好，请确认是否执行",
    status: "pending" as const,
    createdAt: commit.review.createdAt,
    planRevision: commit.authority.revision,
    artifactHash: commit.authority.projectionHash,
    artifactPaths: [commit.artifact.path],
  };
}

function applyReviewProjection(
  input: RuntimeV2PlanRunnerInput,
  commit: RuntimeV2PlanReviewCommit,
): void {
  input.set((state: any) => ({
    activeActionRequest: reviewRequest(commit),
    showPlanPanel: true,
    rightPanelTab: "plan",
    planStage: "ready_to_execute",
    isPlanApproved: false,
    conversationTurns: state.conversationTurns.map((turn: ConversationTurn) =>
      turn.id === commit.review.turnId
        ? {
            ...turn,
            status: "awaiting_approval" as const,
            summary: commit.panel.title,
          }
        : turn
    ),
  }));
}

async function publishReviewMilestone(input: {
  readonly ledger: PlanLedger;
  readonly commit: RuntimeV2PlanReviewCommit;
}): Promise<void> {
  const projection = {
    id: input.ledger.nextId("runtime-v2-plan-review"),
    audience: "chat_milestone" as const,
    markdown: input.commit.chat.markdown,
    kind: "milestone" as const,
    dedupeKey: input.commit.chat.dedupeKey,
  };
  await input.ledger.publish(projection);
}

function planReference(plan: SealedWorkPlanV1): RuntimeV2WorkPlanReference {
  return toRuntimeV2WorkPlanReference(plan, "pending_review");
}

async function finishPlanTerminal(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
  readonly detailCode: string;
}): Promise<RuntimeRunSettlement> {
  await input.ledger.finishTerminal({
    run: input.run,
    resultKind: input.resultKind,
    reason: input.reason,
  });
  input.runner.logStoreEvent("runtime_v2_plan_terminal", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    resultKind: input.resultKind,
    reason: input.reason,
    detailCode: input.detailCode,
    evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
  });
  return settlement(
    input.runner.context,
    terminalAgentOutcome(input.resultKind, input.reason),
  );
}

export async function runSubmitRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<RuntimeRunSettlement> {
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) throw new Error(`RUNTIME_V2_PLAN_TURN_MISSING:${input.context.turnId}`);
  const identity = identities(initialState, input.context, turn);
  const checkpointPort = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    persistSessionRecord: input.persistSessionRecord,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    logStoreEvent: input.logStoreEvent,
  });
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    throw new Error("RUNTIME_V2_PLAN_STALE_RUN_CHECKPOINT");
  }
  const projectionPort = createRuntimeV2ProjectionPort({
    get: input.get,
    set: input.set,
    nextTaskId: () => input.get()._nextTaskId(),
    language: input.context.phaseLanguage,
    logStoreEvent: input.logStoreEvent,
  });
  const ledger = new PlanLedger(
    identity.turn,
    checkpointPort,
    projectionPort,
    existing ? { revision: existing.revision, aggregate: existing.aggregate } : null,
  );

  try {
    if (existing?.aggregate.terminalOutcome) {
      const terminal = existing.aggregate.terminalOutcome;
      return settlement(
        input.context,
        terminalAgentOutcome(terminal.resultKind, terminal.reason),
      );
    }
    if (existing?.aggregate.phase === "reviewing") {
      const recoveredReview = resolveRuntimeV2PlanReviewFromAggregate(
        existing.aggregate,
      );
      if (!recoveredReview?.pending) {
        throw new Error("RUNTIME_V2_PLAN_REVIEW_AUTHORITY_INVALID");
      }
      applyReviewProjection(input, recoveredReview.commit);
      return settlement(input.context);
    }
    if (!existing) {
      await ledger.append({
        type: "turn.admitted",
        turn: identity.turn,
        strategy: "plan",
        objective: turn.userPrompt,
        constraints: [],
        acceptanceCriteria: [],
      });
      await ledger.append({
        type: "run.started",
        run: identity.run,
        phase: "planning",
      });
    } else if (
      existing.aggregate.strategy !== "plan" ||
      existing.aggregate.phase !== "planning"
    ) {
      throw new Error(`RUNTIME_V2_PLAN_PHASE_INVALID:${existing.aggregate.phase}`);
    } else if (existing.aggregate.scheduledCommands.length > 0) {
      const interrupted = [...existing.aggregate.scheduledCommands];
      await ledger.settleScheduled(identity.run, "failed");
      for (const command of interrupted) {
        const canContinue = await ledger.recordRecovery({
          run: identity.run,
          scope: command.kind === "request_model" ? "transport" : "action",
          fingerprint: `cold-recovery:${runtimeV2ActionFingerprint(command)}`,
          reason: "Plan Run 冷恢复时同一未结动作已超过安全重试预算。",
        });
        if (!canContinue) {
          return finishPlanTerminal({
            runner: input,
            ledger,
            run: identity.run,
            resultKind: "partial",
            reason: "计划生成在恢复未结动作时达到安全重试上限；已保留现有证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_cold_recovery_exhausted",
          });
        }
      }
      input.logStoreEvent("runtime_v2_plan_cold_recovery_settled", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        interruptedKinds: interrupted.map((command) => command.kind),
      });
    }

    const evidence: WorkPlanRuntimeEvidence[] = [];
    const evidenceContents = new Map<string, string>();
    let overview = "";
    const collect = await ledger.schedule(identity.run, "collect_observation", {
      objective: turn.userPrompt,
    });
    try {
      const overviewResult = await executeTool(
        "get_project_skeleton",
        {},
        input.context.runWorkspace || "",
        input.context.runSessionKey,
      );
      overview = boundedContent(overviewResult, 12_000);
      await ledger.append({
        type: "command.completed",
        run: identity.run,
        idempotencyKey: collect.idempotencyKey,
        status: "succeeded",
      });
      evidence.push({
        id: "E1",
        target: input.context.runWorkspace || "workspace",
        version: runtimeV2EvidenceVersion(overviewResult),
        statement: "已读取工作区结构概览。",
      });
      evidenceContents.set("E1", overview);
      await ledger.append({
        type: "observation.recorded",
        run: identity.run,
        evidence: {
          id: "E1",
          kind: "source",
          target: input.context.runWorkspace || "workspace",
          version: evidence[0]!.version,
        },
      });
    } catch (error) {
      await ledger.append({
        type: "command.completed",
        run: identity.run,
        idempotencyKey: collect.idempotencyKey,
        status: "failed",
      });
      overview = "Runtime v2 could not collect the initial workspace overview. Use the available read-only tools to gather targeted evidence.";
      const canContinue = await ledger.recordRecovery({
        run: identity.run,
        scope: "action",
        fingerprint: runtimeV2ActionFingerprint(collect),
        reason: "初始工作区概览持续读取失败。",
      });
      input.logStoreEvent("runtime_v2_plan_overview_failed", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        error: error instanceof Error ? error.message : String(error),
        action: "continue_with_targeted_read_tools",
      });
      if (!canContinue) {
        return finishPlanTerminal({
          runner: input,
          ledger,
          run: identity.run,
          resultKind: "error",
          reason: "无法读取工作区概览，且相同恢复动作已达到安全上限；本轮未生成待审核计划。",
          detailCode: "runtime_v2_plan_overview_recovery_exhausted",
        });
      }
    }

    const messages = providerMessages({ turn, context: input.context, overview });
    const startedAt = Date.now();
    let sealedPlan: SealedWorkPlanV1 | null = null;
    let terminalFailure: {
      readonly resultKind: Extract<RuntimeV2ResultKind, "partial" | "error">;
      readonly reason: string;
      readonly detailCode: string;
    } | null = null;
    let round = 0;
    let discoveryActionCount = 0;
    let auditActionCount = 0;
    let auditDeadlineAt = Number.POSITIVE_INFINITY;
    let stage: PlanModelStage = "discovery";
    let synthesisRecoveryCount = 0;
    let auditSynthesisRecoveryCount = 0;
    const deadlineAt = startedAt + PLAN_MODEL_DEADLINE_MS;
    const discoveryDeadlineAt = startedAt + PLAN_DISCOVERY_DEADLINE_MS;
    planRounds:
    while (!sealedPlan && !terminalFailure) {
      if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
      if (Date.now() >= deadlineAt) {
        await ledger.recordSoftSignal(identity.run, "context_pressure");
        await ledger.recordRecovery({
          run: identity.run,
          scope: "context",
          fingerprint: "plan:lifecycle-deadline",
          reason: "Plan Run 已达到限定生命周期。",
        });
        terminalFailure = {
          resultKind: evidence.length > 0 ? "partial" : "error",
          reason: "计划生成已到达运行时限；已保留现有证据并明确结束本轮，没有留下悬空任务。",
          detailCode: "runtime_v2_plan_deadline_reached",
        };
        break;
      }
      if (
        stage === "discovery" &&
        (
          discoveryActionCount >= PLAN_DISCOVERY_ACTION_BUDGET ||
          Date.now() >= discoveryDeadlineAt
        )
      ) {
        stage = "synthesis";
        const boundary = discoveryActionCount >= PLAN_DISCOVERY_ACTION_BUDGET
          ? "action_budget"
          : "time_budget";
        messages.push({
          role: "system",
          content: [
            "The runtime has closed the read-only discovery window.",
            "Use the evidence already returned and call submit_runtime_v2_work_plan now.",
            "No additional read tool is available in this synthesis stage.",
          ].join(" "),
        });
        input.logStoreEvent("runtime_v2_plan_synthesis_boundary", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          boundary,
          discoveryActionCount,
          evidenceCount: evidence.length,
        });
      }
      if (
        stage === "audit_discovery" &&
        (
          auditActionCount >= PLAN_AUDIT_ACTION_BUDGET ||
          Date.now() >= auditDeadlineAt
        )
      ) {
        const boundary = auditActionCount >= PLAN_AUDIT_ACTION_BUDGET
          ? "action_budget"
          : "time_budget";
        stage = "audit_synthesis";
        input.logStoreEvent("runtime_v2_plan_audit_discovery_boundary", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          boundary,
          auditActionCount,
          evidenceCount: evidence.length,
        });
      }
      if (round > 0 && round % PLAN_MODEL_COMPACTION_INTERVAL === 0) {
        await ledger.recordSoftSignal(identity.run, "iteration_limit");
        if (messages.length > 21) {
          messages.splice(3, messages.length - 21);
        }
        messages.push({
          role: "system",
          content: "The planning context was compacted at a soft pressure boundary. Continue from retained evidence; this signal is not a terminal decision.",
        });
        input.logStoreEvent("runtime_v2_plan_soft_round_signal", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          round,
          terminal: false,
          action: "compact_and_continue",
        });
      }
      round += 1;
      let response: RuntimeV2NormalizedProviderResult;
      try {
        response = await requestPlanModel({
          get: input.get,
          context: input.context,
          ledger,
          run: identity.run,
          messages,
          deadlineAt,
          stage,
          evidence,
          evidenceContents,
          compactRecovery: stage === "synthesis"
            ? synthesisRecoveryCount > 0
            : stage === "audit_synthesis"
            ? auditSynthesisRecoveryCount > 0
            : false,
          logStoreEvent: input.logStoreEvent,
        });
      } catch (error) {
        if (input.context.abortCtrl.signal.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (
          isPlanSubmissionStage(stage) &&
          detail === "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT"
        ) {
          const timedOutStage = stage === "audit_synthesis"
            ? "audit_synthesis"
            : "synthesis";
          const recoveryCount = stage === "audit_synthesis"
            ? auditSynthesisRecoveryCount
            : synthesisRecoveryCount;
          const canAttemptRecovery = recoveryCount < 1 &&
            Date.now() + 5_000 < deadlineAt &&
            await ledger.recordRecovery({
              run: identity.run,
              scope: "transport",
              fingerprint: `plan:${timedOutStage}:closed-request-timeout`,
              reason: `计划 ${timedOutStage} 的限定串行恢复已耗尽。`,
            });
          if (canAttemptRecovery) {
            if (stage === "audit_synthesis") {
              auditSynthesisRecoveryCount += 1;
            } else {
              synthesisRecoveryCount += 1;
            }
            input.logStoreEvent(`runtime_v2_plan_${timedOutStage}_timeout`, {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stage: timedOutStage,
              recoveryAttempt: 1,
              action: "retry_after_closed_request_compact_context",
            });
            continue;
          }
          input.logStoreEvent(`runtime_v2_plan_${timedOutStage}_timeout`, {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            evidenceCount: evidence.length,
            stage: timedOutStage,
            recoveryAttempt: recoveryCount,
            action: "terminal_after_bounded_retry",
          });
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: stage === "audit_synthesis"
              ? "计划证据审计及其一次串行恢复均达到限定时长；运行时已停止请求，现有证据和草案已保留。"
              : "计划合成及其一次串行恢复均达到限定时长；运行时已停止请求，现有证据已保留。",
            detailCode: `runtime_v2_plan_${timedOutStage}_timeout`,
          };
          break;
        }
        const canContinue = await ledger.recordRecovery({
          run: identity.run,
          scope: "transport",
          fingerprint: "plan:provider-request",
          reason: "计划模型传输连续失败，已耗尽限定恢复预算。",
        });
        input.logStoreEvent("runtime_v2_plan_provider_failed", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          round,
          canContinue,
          error: detail,
        });
        if (canContinue) {
          messages.push({
            role: "system",
            content: "The previous provider request failed at the transport boundary. Continue from the retained evidence and use one structured action.",
          });
          continue;
        }
        terminalFailure = {
          resultKind: evidence.length > 0 ? "partial" : "error",
          reason: "计划模型连接连续失败并达到恢复上限；已保留现有证据并明确结束本轮。",
          detailCode: "runtime_v2_plan_provider_recovery_exhausted",
        };
        break;
      }
      if (response.toolCalls.length === 0) {
        await ledger.recordSoftSignal(identity.run, response.visibleText?.trim()
          ? "no_tool_call"
          : "empty_response");
        const canContinue = await ledger.recordRecovery({
          run: identity.run,
          scope: "transport",
          fingerprint: "plan:provider-no-structured-action",
          reason: "计划模型连续未返回结构化动作，已耗尽限定恢复预算。",
        });
        messages.push({
          role: "system",
          content: stage === "audit_discovery"
            ? "No structured audit action was received. Use exactly one focused read-only tool."
            : "No structured action was received. Use one focused read-only tool, or submit the complete WorkPlan now.",
        });
        if (!canContinue) {
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "模型连续未提供可执行的结构化计划动作；已保留证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_no_action_recovery_exhausted",
          };
          break;
        }
        continue;
      }
      if (stage === "discovery") {
        discoveryActionCount += response.toolCalls.filter(
          (call) => call.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
        ).length;
      } else if (stage === "audit_discovery") {
        auditActionCount += response.toolCalls.length;
      }
      const submitCalls = response.toolCalls.filter((call) => call.name === SUBMIT_WORK_PLAN_TOOL_NAME);
      if (stage === "audit_discovery" && submitCalls.length > 0) {
        for (const call of submitCalls) {
          await settlePlanTool({
            ledger,
            run: identity.run,
            call,
            status: "blocked",
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "WORK_PLAN_AUDIT_READ_REQUIRED: use one offered read-only tool before the final audit submission boundary.",
          });
        }
        input.logStoreEvent("runtime_v2_plan_audit_early_submission_blocked", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          round,
          auditActionCount,
          submitCallCount: submitCalls.length,
        });
        for (const call of response.toolCalls.filter(
          (entry) => entry.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
        )) {
          const canContinue = await executeReadOnlyPlanTool({
            context: input.context,
            ledger,
            run: identity.run,
            call,
            messages,
            evidence,
            evidenceContents,
            logStoreEvent: input.logStoreEvent,
          });
          if (!canContinue) {
            terminalFailure = {
              resultKind: evidence.length > 0 ? "partial" : "error",
              reason: "计划审计中的同一只读动作连续失败；已保留证据并明确结束本轮。",
              detailCode: "runtime_v2_plan_audit_read_recovery_exhausted",
            };
            break planRounds;
          }
        }
        continue;
      }
      if (
        stage !== "audit_discovery" &&
        submitCalls.length === 1 &&
        response.toolCalls.length === 1
      ) {
        const call = submitCalls[0]!;
        const candidate = parseArguments(call.arguments);
        if (!candidate) {
          await settlePlanTool({ ledger, run: identity.run, call, status: "failed" });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "WORK_PLAN_REJECTED: submit arguments must be one JSON object.",
          });
          input.logStoreEvent("runtime_v2_plan_submission_rejected", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            detail: "submit arguments must be one JSON object",
            submissionChars: String(call.arguments || "").length,
          });
          const canContinue = await ledger.recordRecovery({
            run: identity.run,
            scope: "diagnostic",
            fingerprint: "plan:invalid-work-plan-submission",
            reason: "模型连续提交无效 WorkPlan，已耗尽限定修正预算。",
          });
          if (!canContinue) {
            terminalFailure = {
              resultKind: evidence.length > 0 ? "partial" : "error",
              reason: "模型连续提交无法验证的计划结构；已保留证据并明确结束本轮。",
              detailCode: "runtime_v2_plan_invalid_submission_exhausted",
            };
            break;
          }
          continue;
        }
        try {
          const compiled = workPlanDraftFromSubmission(
            candidate,
            evidence,
            turn.userPrompt,
          );
          const draft = compiled.draft;
          if (compiled.normalized) {
            input.logStoreEvent("runtime_v2_plan_submission_normalized", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stepCount: draft.steps.length,
              validationCount: draft.validations.length,
            });
          }
          const reviewedPlan = sealWorkPlanV1({
            draft,
            evidence,
            createdAt: Date.now(),
          });
          if (stage === "discovery" || stage === "synthesis") {
            await settlePlanTool({
              ledger,
              run: identity.run,
              call,
              status: "succeeded",
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: [
                "WORK_PLAN_DRAFT_ACCEPTED_FOR_AUDIT.",
                "This draft is structurally valid but is not approval authority.",
                "Audit every reported symptom against the retained evidence and submit one corrected final plan.",
              ].join(" "),
            });
            stage = "audit_discovery";
            auditActionCount = 0;
            auditDeadlineAt = Math.min(
              deadlineAt,
              Date.now() + PLAN_AUDIT_DISCOVERY_DEADLINE_MS,
            );
            input.logStoreEvent("runtime_v2_plan_evidence_audit_started", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stepCount: draft.steps.length,
              validationCount: draft.validations.length,
              auditActionBudget: PLAN_AUDIT_ACTION_BUDGET,
            });
            continue;
          }
          sealedPlan = reviewedPlan;
          await settlePlanTool({
            ledger,
            run: identity.run,
            call,
            status: "succeeded",
            evidence: [{
              id: `work-plan:${sealedPlan.id}:${sealedPlan.revision}`,
              kind: "tool",
              target: WORK_PLAN_V1_SCHEMA_VERSION,
              version: sealedPlan.digest,
            }],
          });
          break;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await settlePlanTool({ ledger, run: identity.run, call, status: "failed" });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `WORK_PLAN_REJECTED: ${detail}`.slice(0, 4_000),
          });
          input.logStoreEvent("runtime_v2_plan_submission_rejected", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            detail,
            evidenceIds: evidence.map((entry) => entry.id),
            submissionChars: JSON.stringify(candidate).length,
          });
          const canContinue = await ledger.recordRecovery({
            run: identity.run,
            scope: "diagnostic",
            fingerprint: "plan:invalid-work-plan-submission",
            reason: "模型连续提交无效 WorkPlan，已耗尽限定修正预算。",
          });
          if (!canContinue) {
            terminalFailure = {
              resultKind: evidence.length > 0 ? "partial" : "error",
              reason: "模型连续提交无法验证的计划结构；已保留证据并明确结束本轮。",
              detailCode: "runtime_v2_plan_invalid_submission_exhausted",
            };
            break;
          }
          continue;
        }
      }
      for (const call of response.toolCalls) {
        const canContinue = await executeReadOnlyPlanTool({
          context: input.context,
          ledger,
          run: identity.run,
          call,
          messages,
          evidence,
          evidenceContents,
          logStoreEvent: input.logStoreEvent,
        });
        if (!canContinue) {
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "计划调查中的同一工具动作连续失败；已保留证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_read_recovery_exhausted",
          };
          break planRounds;
        }
      }
    }
    if (!sealedPlan) {
      if (!terminalFailure) throw new Error("RUNTIME_V2_PLAN_TERMINAL_DECISION_MISSING");
      input.logStoreEvent("runtime_v2_plan_review_not_produced", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        evidenceCount: evidence.length,
        terminal: true,
        detailCode: terminalFailure.detailCode,
      });
      return finishPlanTerminal({
        runner: input,
        ledger,
        run: identity.run,
        ...terminalFailure,
      });
    }

    const requestId = [
      "runtime-v2-plan-review",
      identity.run.runId,
      sealedPlan.id,
      sealedPlan.revision,
      sealedPlan.projectionHash.slice(-16),
    ].join(":");
    const commit = createRuntimeV2PlanReviewCommit({
      plan: sealedPlan,
      turn: identity.turn,
      run: identity.run,
      requestId,
      createdAt: Date.now(),
    });
    await writeReviewArtifact({
      context: input.context,
      ledger,
      run: identity.run,
      plan: sealedPlan,
    });
    await ledger.append({
      type: "work_plan.sealed",
      run: identity.run,
      workPlan: planReference(sealedPlan),
      sealedPlan,
      reviewCommit: commit,
    });
    await publishReviewMilestone({
      ledger,
      commit,
    });
    // Expose the approval control only after every ReviewCommit projection is
    // durably appended, so a fast click cannot race the milestone checkpoint.
    applyReviewProjection(input, commit);
    input.logStoreEvent("runtime_v2_plan_review_committed", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      requestId: commit.review.requestId,
      workPlanId: commit.authority.id,
      revision: commit.authority.revision,
      digest: commit.authority.digest,
      projectionHash: commit.authority.projectionHash,
    });
    return settlement(input.context);
  } catch (error) {
    const aggregate = ledger.snapshot();
    if (!aggregate?.run || aggregate.phase === "acting") throw error;
    if (aggregate.terminalOutcome) {
      return settlement(
        input.context,
        terminalAgentOutcome(
          aggregate.terminalOutcome.resultKind,
          aggregate.terminalOutcome.reason,
        ),
      );
    }
    const recoveredReview = resolveRuntimeV2PlanReviewFromAggregate(aggregate);
    if (recoveredReview?.pending) {
      applyReviewProjection(input, recoveredReview.commit);
      return settlement(input.context);
    }
    if (input.context.abortCtrl.signal.aborted) {
      return finishPlanTerminal({
        runner: input,
        ledger,
        run: identity.run,
        resultKind: "canceled",
        reason: "用户已停止计划生成；已保留此前收集的证据并结束本轮。",
        detailCode: "runtime_v2_plan_aborted",
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    await ledger.recordRecovery({
      run: identity.run,
      scope: "action",
      fingerprint: `plan:unhandled:${detail.split(":")[0]?.slice(0, 160) || "unknown"}`,
      reason: "Plan Run 遇到无法继续恢复的运行时错误。",
    });
    input.logStoreEvent("runtime_v2_plan_unhandled_failure", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      error: detail,
    });
    return finishPlanTerminal({
      runner: input,
      ledger,
      run: identity.run,
      resultKind: aggregate.evidence.length > 0 ? "partial" : "error",
      reason: "计划生成遇到运行时错误；已保留现有证据并明确结束本轮，没有留下悬空任务。",
      detailCode: "runtime_v2_plan_unhandled_failure",
    });
  } finally {
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
