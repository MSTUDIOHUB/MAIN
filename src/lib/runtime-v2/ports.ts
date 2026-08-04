import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2NormalizedProviderResult,
  RuntimeV2Projection,
  RuntimeV2ProjectionAudience,
  RuntimeV2RunIdentity,
  RuntimeV2TurnIdentity,
} from "./contracts";
import type { RuntimeV2CheckpointV3 } from "./checkpoint";
import type {
  RuntimeV2EmergencyTerminalEnvelopeV1,
} from "./emergencyTerminal";
import type { RuntimeV2Event, RuntimeV2EventDraft } from "./events";

export interface CheckpointPort {
  load(input: { readonly owner: RuntimeV2TurnIdentity }): Promise<RuntimeV2CheckpointV3 | null>;
  append(input: {
    readonly owner: RuntimeV2TurnIdentity;
    readonly expectedRevision: number;
    readonly event: RuntimeV2Event;
  }): Promise<{ readonly disposition: "committed" | "idempotent" | "conflict"; readonly checkpoint: RuntimeV2CheckpointV3 | null }>;
  commitEmergencyTerminal(input: {
    readonly owner: RuntimeV2TurnIdentity;
    readonly run: RuntimeV2RunIdentity;
    readonly expectedRevision: number;
    readonly envelope: RuntimeV2EmergencyTerminalEnvelopeV1;
  }): Promise<{
    readonly disposition: "committed" | "idempotent" | "conflict";
    readonly envelope: RuntimeV2EmergencyTerminalEnvelopeV1 | null;
  }>;
}

export interface ProviderPort {
  request(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly command: RuntimeV2Command;
    readonly signal: AbortSignal;
  }): Promise<RuntimeV2NormalizedProviderResult>;
}

export interface ToolPort {
  execute(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly command: RuntimeV2Command;
    readonly signal: AbortSignal;
  }): Promise<RuntimeV2EventDraft>;
}

export interface SchedulerPort {
  /** Resolve and persist child identities before any child request starts. */
  prepareSchedule?(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly command: RuntimeV2Command;
    readonly signal: AbortSignal;
  }): Promise<RuntimeV2EventDraft | null>;
  execute(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly command: RuntimeV2Command;
    readonly signal: AbortSignal;
    /** Jobs already committed through `subagents.scheduled`, including a
     * checkpoint-recovery replay. */
    readonly scheduledSubagents?: readonly import("./contracts").RuntimeV2SubagentJob[];
  }): Promise<RuntimeV2EventDraft | readonly RuntimeV2EventDraft[]>;
}

export interface ProjectionPort {
  publish(input: {
    readonly aggregate: TurnAggregateV1;
    readonly audience: RuntimeV2ProjectionAudience;
    readonly projection: RuntimeV2Projection;
    readonly event: RuntimeV2Event;
  }): Promise<void>;
}

export interface ClockIdPort {
  now(): number;
  nextId(scope: string): string;
  nextIdempotencyKey(input: { readonly run: RuntimeV2RunIdentity; readonly kind: RuntimeV2Command["kind"] }): string;
}

export interface RuntimeV2Ports {
  readonly checkpoint: CheckpointPort;
  readonly provider: ProviderPort;
  readonly tool: ToolPort;
  readonly scheduler: SchedulerPort;
  readonly projection: ProjectionPort;
  readonly clockId: ClockIdPort;
}
