import {
  getDefaultStudioAgentForEngine,
  type ParsedSetupEngineArgs,
  type StudioAgentKey,
  type StudioConfig,
  type StudioEngineKey,
} from "../../lib/gameStudio/catalog";
import { sha256Hex } from "../../lib/sha256";
import type { TurnAggregateV1 } from "../../lib/runtime-v2/aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2EvidenceReference,
  RuntimeV2RunIdentity,
} from "../../lib/runtime-v2/contracts";
import type { RuntimeV2EventDraft } from "../../lib/runtime-v2/events";
import {
  admitRuntimeV2StudioAction,
  parseRuntimeV2StudioAction,
  runtimeV2StudioActionDigest,
  runtimeV2StudioActionMayWrite,
  runtimeV2StudioReceiptKey,
  type RuntimeV2StudioAction,
} from "../../lib/runtime-v2/studio";

export function buildRuntimeV2StudioSetupActionPlan(
  setup: ParsedSetupEngineArgs | null | undefined,
): readonly RuntimeV2StudioAction[] {
  if (!setup) return [];
  const launch: RuntimeV2StudioAction = {
    schemaVersion: "runtime-v2-studio-action.v1",
    kind: "launch",
  };
  const observe: RuntimeV2StudioAction = {
    schemaVersion: "runtime-v2-studio-action.v1",
    kind: "observe",
  };
  if (setup.mode !== "configure" || !setup.engine) {
    return [launch, observe];
  }
  return [
    launch,
    observe,
    {
      schemaVersion: "runtime-v2-studio-action.v1",
      kind: "interact",
      engine: setup.engine,
      ...(String(setup.version || "").trim()
        ? { engineVersion: String(setup.version).trim() }
        : {}),
    },
    observe,
  ];
}

export const RUNTIME_V2_STUDIO_RECEIPT_SCHEMA_VERSION =
  "runtime-v2-studio-receipt.v1" as const;

export type RuntimeV2StudioReceiptStatus =
  | "prepared"
  | "succeeded"
  | "failed"
  | "indeterminate";

export interface RuntimeV2StudioReceiptV1 {
  readonly schemaVersion: typeof RUNTIME_V2_STUDIO_RECEIPT_SCHEMA_VERSION;
  readonly revision: number;
  readonly receiptKey: string;
  readonly run: RuntimeV2RunIdentity;
  readonly action: RuntimeV2StudioAction;
  readonly actionDigest: string;
  readonly status: RuntimeV2StudioReceiptStatus;
  readonly preparedAt: number;
  readonly settledAt: number | null;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
}

export function normalizeRuntimeV2StudioReceipt(
  value: unknown,
): RuntimeV2StudioReceiptV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RuntimeV2StudioReceiptV1>;
  const action = parseRuntimeV2StudioAction(candidate.action);
  const run = candidate.run;
  const status = candidate.status;
  if (
    candidate.schemaVersion !== RUNTIME_V2_STUDIO_RECEIPT_SCHEMA_VERSION ||
    !Number.isInteger(candidate.revision) ||
    Number(candidate.revision) < 1 ||
    !String(candidate.receiptKey || "").trim() ||
    !run ||
    !String(run.sessionKey || "").trim() ||
    !String(run.sessionEpoch || "").trim() ||
    !String(run.turnId || "").trim() ||
    !String(run.runId || "").trim() ||
    !String(run.attemptId || "").trim() ||
    !action ||
    candidate.actionDigest !== runtimeV2StudioActionDigest(action) ||
    (
      status !== "prepared" &&
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "indeterminate"
    ) ||
    !Number.isFinite(Number(candidate.preparedAt)) ||
    (
      candidate.settledAt !== null &&
      !Number.isFinite(Number(candidate.settledAt))
    ) ||
    !Array.isArray(candidate.evidence)
  ) return null;
  return candidate as RuntimeV2StudioReceiptV1;
}

export interface RuntimeV2StudioReceiptPort {
  load(input: {
    readonly receiptKey: string;
  }): Promise<RuntimeV2StudioReceiptV1 | null>;
  /** Atomically persists the pre-execution fence. */
  claim(input: {
    readonly receipt: RuntimeV2StudioReceiptV1;
  }): Promise<{
    readonly disposition: "claimed" | "existing";
    readonly receipt: RuntimeV2StudioReceiptV1;
  }>;
  settle(input: {
    readonly receiptKey: string;
    readonly expectedRevision: number;
    readonly receipt: RuntimeV2StudioReceiptV1;
  }): Promise<{
    readonly disposition: "committed" | "idempotent" | "conflict";
    readonly receipt: RuntimeV2StudioReceiptV1 | null;
  }>;
}

export interface RuntimeV2StudioConfigSnapshot {
  readonly engine: string;
  readonly engineLanguage: string;
  readonly engineVersion: string | null;
  readonly reviewMode: string;
  readonly activeStudioAgent: string;
  readonly packVersion: string;
}

export interface RuntimeV2StudioExternalPort {
  launch(input: {
    readonly action: Extract<RuntimeV2StudioAction, { kind: "launch" }>;
    readonly signal: AbortSignal;
  }): Promise<RuntimeV2StudioConfigSnapshot>;
  observe(input: {
    readonly action: Extract<RuntimeV2StudioAction, { kind: "observe" }>;
    readonly signal: AbortSignal;
  }): Promise<RuntimeV2StudioConfigSnapshot | null>;
  interact(input: {
    readonly action: Extract<RuntimeV2StudioAction, { kind: "interact" }>;
    readonly signal: AbortSignal;
  }): Promise<RuntimeV2StudioConfigSnapshot>;
}

/** The same narrow service surface already used by Game Studio preparation. */
export interface RuntimeV2GameStudioServicePort {
  ensureInitialized(activeStudioAgent?: StudioAgentKey): Promise<StudioConfig>;
  configureEngine(params: {
    engine: StudioEngineKey;
    version?: string;
    activeStudioAgent?: StudioAgentKey;
  }): Promise<StudioConfig>;
  loadConfig(): Promise<StudioConfig | null>;
}

export type RuntimeV2StudioExecutionMode = "fresh" | "cold_resume";

function bounded(value: unknown, limit = 256): string {
  return String(value || "").trim().slice(0, limit);
}

function studioConfigSnapshot(config: StudioConfig): RuntimeV2StudioConfigSnapshot {
  const snapshot = {
    engine: bounded(config.engine, 64),
    engineLanguage: bounded(config.engineLanguage, 128),
    engineVersion: bounded(config.engineVersion, 128) || null,
    reviewMode: bounded(config.reviewMode, 64),
    activeStudioAgent: bounded(config.activeStudioAgent, 128),
    packVersion: bounded(config.packVersion, 128),
  };
  if (
    !snapshot.engine ||
    !snapshot.engineLanguage ||
    !snapshot.reviewMode ||
    !snapshot.activeStudioAgent ||
    !snapshot.packVersion
  ) throw new Error("STUDIO_CONFIG_INVALID");
  return snapshot;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Runtime v2 Studio action canceled before external execution.");
  error.name = "AbortError";
  throw error;
}

/**
 * GameStudioRuntimeService remains an external mechanism. It returns
 * structured config snapshots; it never publishes Turn state or conclusions.
 */
export function createGameStudioRuntimeV2ExternalPort(
  service: RuntimeV2GameStudioServicePort,
): RuntimeV2StudioExternalPort {
  return {
    async launch({ signal }) {
      throwIfAborted(signal);
      return studioConfigSnapshot(await service.ensureInitialized("studio_auto"));
    },
    async observe({ signal }) {
      throwIfAborted(signal);
      const config = await service.loadConfig();
      return config ? studioConfigSnapshot(config) : null;
    },
    async interact({ action, signal }) {
      throwIfAborted(signal);
      return studioConfigSnapshot(await service.configureEngine({
        engine: action.engine,
        ...(action.engineVersion ? { version: action.engineVersion } : {}),
        activeStudioAgent: getDefaultStudioAgentForEngine(action.engine),
      }));
    },
  };
}

function sameRun(
  left: RuntimeV2RunIdentity,
  right: RuntimeV2RunIdentity,
): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

function receiptMatches(input: {
  readonly receipt: RuntimeV2StudioReceiptV1;
  readonly receiptKey: string;
  readonly run: RuntimeV2RunIdentity;
  readonly action: RuntimeV2StudioAction;
}): boolean {
  const storedAction = parseRuntimeV2StudioAction(input.receipt.action);
  if (!storedAction) return false;
  return input.receipt.schemaVersion === RUNTIME_V2_STUDIO_RECEIPT_SCHEMA_VERSION &&
    input.receipt.receiptKey === input.receiptKey &&
    sameRun(input.receipt.run, input.run) &&
    input.receipt.actionDigest === runtimeV2StudioActionDigest(input.action) &&
    runtimeV2StudioActionDigest(storedAction) === input.receipt.actionDigest &&
    Number.isSafeInteger(input.receipt.revision) &&
    input.receipt.revision >= 1 &&
    Number.isFinite(input.receipt.preparedAt) &&
    input.receipt.preparedAt >= 0 &&
    (
      input.receipt.status === "prepared"
        ? input.receipt.revision === 1 && input.receipt.settledAt === null
        : input.receipt.revision >= 2 &&
          Number.isFinite(input.receipt.settledAt) &&
          Number(input.receipt.settledAt) >= input.receipt.preparedAt
    );
}

function auditEvidence(input: {
  readonly command: RuntimeV2Command;
  readonly action?: RuntimeV2StudioAction;
  readonly code: string;
  readonly receiptKey?: string;
}): RuntimeV2EvidenceReference {
  const digest = sha256Hex([
    input.command.run.runId,
    input.command.idempotencyKey,
    input.action?.kind || "invalid",
    input.code,
    input.receiptKey || "",
  ].join("\u0000"));
  return {
    id: `studio-audit-${digest.slice(0, 24)}`,
    kind: "tool",
    target: "game-studio:workspace:audit",
    version: `studio-audit:${input.code}:${digest}`,
  };
}

function configEvidence(input: {
  readonly command: RuntimeV2Command;
  readonly action: RuntimeV2StudioAction;
  readonly config: RuntimeV2StudioConfigSnapshot;
}): RuntimeV2EvidenceReference {
  const version = `studio-config-sha256-${sha256Hex(JSON.stringify(input.config))}`;
  return {
    id: `studio-result-${sha256Hex([
      input.command.run.runId,
      input.action.kind,
      version,
    ].join("\u0000")).slice(0, 24)}`,
    kind: "tool",
    target: `game-studio:workspace:${input.action.kind}`,
    version,
  };
}

function toolEvent(
  command: RuntimeV2Command,
  status: "succeeded" | "failed" | "blocked",
  evidence: readonly RuntimeV2EvidenceReference[],
): RuntimeV2EventDraft {
  return {
    type: "tool.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status,
    evidence,
  };
}

function receiptEvent(
  command: RuntimeV2Command,
  action: RuntimeV2StudioAction,
  receiptKey: string,
  receipt: RuntimeV2StudioReceiptV1,
): RuntimeV2EventDraft {
  if (receipt.status === "succeeded" && receipt.evidence.length > 0) {
    return toolEvent(command, "succeeded", receipt.evidence);
  }
  return toolEvent(
    command,
    receipt.status === "failed" ? "failed" : "blocked",
    [
      ...receipt.evidence,
      auditEvidence({
        command,
        action,
        code: `receipt_${receipt.status}`,
        receiptKey,
      }),
    ],
  );
}

function preparedReceipt(input: {
  readonly receiptKey: string;
  readonly run: RuntimeV2RunIdentity;
  readonly action: RuntimeV2StudioAction;
  readonly now: number;
}): RuntimeV2StudioReceiptV1 {
  return {
    schemaVersion: RUNTIME_V2_STUDIO_RECEIPT_SCHEMA_VERSION,
    revision: 1,
    receiptKey: input.receiptKey,
    run: input.run,
    action: input.action,
    actionDigest: runtimeV2StudioActionDigest(input.action),
    status: "prepared",
    preparedAt: input.now,
    settledAt: null,
    evidence: [],
    diagnosticCode: null,
    diagnosticDetail: null,
  };
}

function settledReceipt(input: {
  readonly prepared: RuntimeV2StudioReceiptV1;
  readonly status: Exclude<RuntimeV2StudioReceiptStatus, "prepared">;
  readonly now: number;
  readonly evidence?: readonly RuntimeV2EvidenceReference[];
  readonly diagnosticCode?: string;
  readonly diagnosticDetail?: string;
}): RuntimeV2StudioReceiptV1 {
  return {
    ...input.prepared,
    revision: input.prepared.revision + 1,
    status: input.status,
    settledAt: input.now,
    evidence: input.evidence || [],
    diagnosticCode: input.diagnosticCode || null,
    diagnosticDetail: bounded(input.diagnosticDetail, 512) || null,
  };
}

async function invokeExternal(
  port: RuntimeV2StudioExternalPort,
  action: RuntimeV2StudioAction,
  signal: AbortSignal,
): Promise<RuntimeV2StudioConfigSnapshot | null> {
  if (action.kind === "launch") return port.launch({ action, signal });
  if (action.kind === "observe") return port.observe({ action, signal });
  return port.interact({ action, signal });
}

function configMatchesInteraction(
  config: RuntimeV2StudioConfigSnapshot,
  action: Extract<RuntimeV2StudioAction, { kind: "interact" }>,
): boolean {
  return config.engine === action.engine &&
    (!action.engineVersion || config.engineVersion === action.engineVersion);
}

async function settleReceipt(
  port: RuntimeV2StudioReceiptPort,
  prepared: RuntimeV2StudioReceiptV1,
  receipt: RuntimeV2StudioReceiptV1,
): Promise<RuntimeV2StudioReceiptV1 | null> {
  const settlement = await port.settle({
    receiptKey: prepared.receiptKey,
    expectedRevision: prepared.revision,
    receipt,
  });
  if (
    settlement.disposition !== "conflict" &&
    settlement.receipt &&
    settlement.receipt.status === receipt.status &&
    receiptMatches({
      receipt: settlement.receipt,
      receiptKey: prepared.receiptKey,
      run: prepared.run,
      action: prepared.action,
    })
  ) return settlement.receipt;
  return null;
}

/**
 * Execute one already-scheduled Studio command. This adapter settles only the
 * local tool command; RuntimeV2Controller remains the Turn/final owner.
 */
export async function executeRuntimeV2StudioAction(input: {
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly mode: RuntimeV2StudioExecutionMode;
  readonly signal: AbortSignal;
  readonly external: RuntimeV2StudioExternalPort;
  readonly receipts: RuntimeV2StudioReceiptPort;
  readonly now: () => number;
}): Promise<RuntimeV2EventDraft> {
  const admission = admitRuntimeV2StudioAction({
    aggregate: input.aggregate,
    command: input.command,
  });
  if (!admission.ok) {
    return toolEvent(input.command, "blocked", [
      auditEvidence({ command: input.command, code: admission.reason }),
    ]);
  }

  const { action, lifecycle } = admission;
  const receiptKey = runtimeV2StudioReceiptKey({
    run: input.command.run,
    commandIdempotencyKey: input.command.idempotencyKey,
    action,
  });
  let existing: RuntimeV2StudioReceiptV1 | null;
  try {
    existing = await input.receipts.load({ receiptKey });
  } catch {
    return toolEvent(input.command, "blocked", [
      auditEvidence({ command: input.command, action, code: "receipt_load_failed", receiptKey }),
    ]);
  }
  if (existing) {
    if (!receiptMatches({ receipt: existing, receiptKey, run: input.command.run, action })) {
      return toolEvent(input.command, "blocked", [
        auditEvidence({ command: input.command, action, code: "receipt_identity_conflict", receiptKey }),
      ]);
    }
    return receiptEvent(input.command, action, receiptKey, existing);
  }

  if (input.mode === "cold_resume" && runtimeV2StudioActionMayWrite(action)) {
    return toolEvent(input.command, "blocked", [
      auditEvidence({ command: input.command, action, code: "cold_resume_missing_receipt", receiptKey }),
    ]);
  }

  const prepared = preparedReceipt({
    receiptKey,
    run: input.command.run,
    action,
    now: input.now(),
  });
  let claimed: RuntimeV2StudioReceiptV1;
  try {
    const claim = await input.receipts.claim({ receipt: prepared });
    claimed = claim.receipt;
    if (!receiptMatches({ receipt: claimed, receiptKey, run: input.command.run, action })) {
      return toolEvent(input.command, "blocked", [
        auditEvidence({ command: input.command, action, code: "receipt_identity_conflict", receiptKey }),
      ]);
    }
    if (claim.disposition === "existing" || claimed.status !== "prepared") {
      return receiptEvent(input.command, action, receiptKey, claimed);
    }
  } catch {
    return toolEvent(input.command, "blocked", [
      auditEvidence({ command: input.command, action, code: "receipt_claim_failed", receiptKey }),
    ]);
  }

  let config: RuntimeV2StudioConfigSnapshot | null;
  try {
    config = await invokeExternal(input.external, action, input.signal);
    if (!config) throw new Error("STUDIO_CONFIG_MISSING");
    const expectedInteraction = action.kind === "interact"
      ? action
      : action.kind === "observe" && lifecycle.phase === "interacted"
        ? lifecycle.successfulActions[lifecycle.successfulActions.length - 1]
        : null;
    if (
      expectedInteraction?.kind === "interact" &&
      !configMatchesInteraction(config, expectedInteraction)
    ) throw new Error("STUDIO_INTERACTION_NOT_OBSERVED");
  } catch (error) {
    const status = runtimeV2StudioActionMayWrite(action) ? "indeterminate" : "failed";
    const failed = settledReceipt({
      prepared: claimed,
      status,
      now: input.now(),
      diagnosticCode: error instanceof Error && error.name === "AbortError"
        ? "external_canceled"
        : "external_execution_failed",
      diagnosticDetail: error instanceof Error ? error.message : String(error),
    });
    try {
      const durable = await settleReceipt(input.receipts, claimed, failed);
      return durable
        ? receiptEvent(input.command, action, receiptKey, durable)
        : toolEvent(input.command, "blocked", [
            auditEvidence({ command: input.command, action, code: "failure_receipt_commit_unknown", receiptKey }),
          ]);
    } catch {
      return toolEvent(input.command, "blocked", [
        auditEvidence({ command: input.command, action, code: "failure_receipt_commit_unknown", receiptKey }),
      ]);
    }
  }

  const succeeded = settledReceipt({
    prepared: claimed,
    status: "succeeded",
    now: input.now(),
    evidence: [configEvidence({ command: input.command, action, config })],
  });
  try {
    const durable = await settleReceipt(input.receipts, claimed, succeeded);
    return durable
      ? receiptEvent(input.command, action, receiptKey, durable)
      : toolEvent(input.command, "blocked", [
          auditEvidence({ command: input.command, action, code: "success_receipt_commit_unknown", receiptKey }),
        ]);
  } catch {
    return toolEvent(input.command, "blocked", [
      auditEvidence({ command: input.command, action, code: "success_receipt_commit_unknown", receiptKey }),
    ]);
  }
}
