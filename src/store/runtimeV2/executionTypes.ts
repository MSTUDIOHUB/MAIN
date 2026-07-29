import type { AgentMessage } from "../../lib/agentMessages";
import type { ToolDefinition } from "../../lib/toolSchemas";
import type {
  ToolCapabilityRegistry,
  ToolPermissionPolicy,
} from "../../lib/toolCapabilities";
import type { ToolCatalog } from "../../lib/toolCatalog";
import {
  type ProviderLaneProfileV1,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
  type RuntimeV2SubagentReportV1,
  type RuntimeV2SubagentValidationReceiptV1,
  type RuntimeV2EvidenceReference,
} from "../../lib/runtime-v2";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export type StoreGet = () => any;

export interface RuntimeV2ModelContextEntry {
  readonly id: string;
  readonly source: "workspace" | "tool" | "subagent" | "provider" | "plan";
  readonly label: string;
  readonly target: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly content: string;
}

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
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly validationReceipts:
    readonly RuntimeV2SubagentValidationReceiptV1[];
}

export interface RuntimeV2LiveExecutionState {
  readonly messages: AgentMessage[];
  readonly modelContext: RuntimeV2ModelContextEntry[];
  readonly childRuns: Map<string, Promise<RuntimeV2ChildResult>>;
  readonly childAbortControllers: Map<string, AbortController>;
  readonly childTelemetry: Map<string, { firstTokenAt: number | null; closedAt: number | null }>;
  readonly coveredReadToolResults: Map<string, string | null>;
  /** Exact semantic actions rejected at the current mutation boundary.
   * The tool remains available; only the same tool+arguments tuple is
   * ineligible until a successful workspace mutation opens a new boundary. */
  readonly rejectedProviderActions: Map<string, string>;
  workspaceOverview: string;
  evidenceCounter: number;
  latestProviderResult: RuntimeV2NormalizedProviderResult | null;
  latestVisibleText: string;
  providerLaneProfile: ProviderLaneProfileV1 | null;
  authorization: RuntimeV2ExecutionAuthorization | null;
}

export interface RuntimeV2ExecutionPortsInput {
  readonly get: StoreGet;
  readonly context: RuntimeV2SubmissionContext;
  readonly live: RuntimeV2LiveExecutionState;
  readonly nextId: (scope: string) => string;
  readonly now: () => number;
  /** Absolute Turn deadline shared by provider and effect adapters. */
  readonly lifecycleDeadlineAt?: number;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

export function createRuntimeV2LiveExecutionState(): RuntimeV2LiveExecutionState {
  return {
    messages: [],
    modelContext: [],
    childRuns: new Map(),
    childAbortControllers: new Map(),
    childTelemetry: new Map(),
    coveredReadToolResults: new Map(),
    rejectedProviderActions: new Map(),
    workspaceOverview: "",
    evidenceCounter: 0,
    latestProviderResult: null,
    latestVisibleText: "",
    providerLaneProfile: null,
    authorization: null,
  };
}
