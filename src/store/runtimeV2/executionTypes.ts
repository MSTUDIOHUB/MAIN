import type { AgentMessage } from "../../lib/agentMessages";
import type { ToolDefinition } from "../../lib/toolSchemas";
import type {
  ToolCapabilityRegistry,
  ToolPermissionPolicy,
} from "../../lib/toolCapabilities";
import type { ToolCatalog } from "../../lib/toolCatalog";
import {
  type ProviderLaneProfileV1,
  type RuntimeV2TransportVariant,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
  type RuntimeV2SubagentReportV1,
  type RuntimeV2EvidenceReference,
} from "../../lib/runtime-v2";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export type StoreGet = () => any;
export type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2ExecutionAuthorization {
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly toolCatalog: ToolCatalog;
  readonly capabilityRegistry: ToolCapabilityRegistry;
  readonly policy: ToolPermissionPolicy;
}

export interface RuntimeV2ChildResult {
  readonly job: RuntimeV2SubagentJob;
  readonly status: "completed" | "degraded" | "failed" | "canceled";
  readonly summary: string;
  readonly report: RuntimeV2SubagentReportV1 | null;
  /** Versioned parent evidence delivered to a review child. This remains
   * provenance-only and is never counted as evidence produced by the child. */
  readonly inheritedEvidence: readonly RuntimeV2EvidenceReference[];
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  /** Process-local child-authored mutation transaction. It has no workspace
   * effect until the parent scheduler joins the child, revalidates its base
   * versions, and commits it through the parent Turn authority. */
  readonly stagedMutations?: readonly RuntimeV2StagedChildMutation[];
}

export interface RuntimeV2StagedChildMutation {
  readonly schemaVersion: "runtime-v2-staged-child-mutation.v1";
  readonly id: string;
  readonly evidenceId: string;
  readonly toolName:
    | "replace_in_file"
    | "write_file"
    | "apply_patch"
    | "delete_workspace_path";
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly targets: readonly string[];
  readonly baseVersions: Readonly<Record<string, string | null>>;
}

export interface RuntimeV2MaterializedSourceWindow {
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface RuntimeV2MaterializedSourceCoverage {
  readonly target: string;
  readonly version: string;
  readonly totalLines: number;
  readonly windows: readonly RuntimeV2MaterializedSourceWindow[];
  readonly complete: boolean;
}

export type RuntimeV2ProviderActionWindow =
  | "corrective_source"
  | "corrective_mutation"
  | "validation_handoff"
  | "closed_recovery";

export interface RuntimeV2LiveExecutionState {
  readonly messages: AgentMessage[];
  readonly childRuns: Map<string, Promise<RuntimeV2ChildResult>>;
  readonly childAbortControllers: Map<string, AbortController>;
  readonly childTelemetry: Map<string, { firstTokenAt: number | null; closedAt: number | null }>;
  /** Exclusive path ownership held by active implement children. The child
   * stages against these paths; parent and sibling writes are rejected until
   * join commits or discards the transaction. */
  readonly childWriteScopes: Map<string, readonly string[]>;
  readonly coveredReadToolResults: Map<string, string | null>;
  readonly parallelReadCountByToolCallId: Map<string, number>;
  /** Exact source that survived final request bounding for the most recent
   * provider attempt. It is process-local and is never checkpoint authority. */
  latestProviderRequestSourceCoverage:
    readonly RuntimeV2MaterializedSourceCoverage[];
  /** Process-local decoding pressure for the next provider request. This
   * narrows only the advertised next-action catalog after a causally closed
   * no-effect loop; durable authorization and the full post-mutation surface
   * remain unchanged. */
  latestProviderActionWindow: RuntimeV2ProviderActionWindow | null;
  /** A finite validator recovered from the model's latest rejected shell
   * wrapper. The next native run_command schema advertises this exact command
   * so a smaller local model can correct its arguments instead of replaying
   * cd/pipeline/echo decorations forever. It is cleared by the next committed
   * mutation or executed validation. */
  correctiveValidationCommand: string | null;
  /** Request-scoped source authority copied only onto mutation calls returned
   * by that exact provider request. */
  readonly mutationSourceCoverageByToolCallId: Map<
    string,
    readonly RuntimeV2MaterializedSourceCoverage[]
  >;
  evidenceCounter: number;
  latestProviderResult: RuntimeV2NormalizedProviderResult | null;
  latestVisibleText: string;
  /** Provider-private reasoning continuity for one native tool turn. This is
   * process-local, never projected, logged, or checkpointed. */
  latestProviderAssistantReasoning: {
    readonly content: string;
    readonly field: "reasoning_content" | "reasoning";
  } | null;
  /** Process-local truth used only if persisting the mutation completion
   * itself fails. The normal completion event remains the durable authority. */
  hasExecutedMutationEffect: boolean;
  providerLaneProfile: ProviderLaneProfileV1 | null;
  /** Run-local observations of transports that actually returned at least
   * one structured call. A later no-call response is semantic drift, not a
   * reason to renegotiate an already proven wire format. */
  readonly provenStructuredToolTransports: Set<RuntimeV2TransportVariant>;
  authorization: RuntimeV2ExecutionAuthorization | null;
  /** A user-denied exact permission request is a lifecycle boundary, not a
   * provider/tool error. The owning runner consumes this fact into one
   * canonical blocked terminal without exposing transport diagnostics. */
  permissionRejection: {
    readonly reason: string;
    readonly finalMarkdown: string;
  } | null;
}

export interface RuntimeV2ExecutionPortsInput {
  readonly get: StoreGet;
  readonly set?: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  readonly live: RuntimeV2LiveExecutionState;
  readonly nextId: (scope: string) => string;
  readonly now: () => number;
  /** Optional caller-owned hard boundary. Ordinary Execute leaves it unset. */
  readonly lifecycleDeadlineAt?: number;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

export function createRuntimeV2LiveExecutionState(): RuntimeV2LiveExecutionState {
  return {
    messages: [],
    childRuns: new Map(),
    childAbortControllers: new Map(),
    childTelemetry: new Map(),
    childWriteScopes: new Map(),
    coveredReadToolResults: new Map(),
    parallelReadCountByToolCallId: new Map(),
    latestProviderRequestSourceCoverage: [],
    latestProviderActionWindow: null,
    correctiveValidationCommand: null,
    mutationSourceCoverageByToolCallId: new Map(),
    evidenceCounter: 0,
    latestProviderResult: null,
    latestVisibleText: "",
    latestProviderAssistantReasoning: null,
    hasExecutedMutationEffect: false,
    providerLaneProfile: null,
    provenStructuredToolTransports: new Set(),
    authorization: null,
    permissionRejection: null,
  };
}
