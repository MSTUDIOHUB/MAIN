export interface RuntimeV2ProviderRecoveryPressure {
  readonly schemaVersion: "runtime-v2-provider-recovery.v1";
  readonly reason:
    | "repeated_action_rejected"
    | "empty_response"
    | "provider_request_failed"
    | "non_novel_evidence";
  readonly occurrence: number;
  readonly stage: "reconsider" | "reframe" | "alternative";
}

export interface RuntimeV2ProviderRecoveryWindow {
  readonly pressure: RuntimeV2ProviderRecoveryPressure;
  /** Time of the first uninterrupted non-actionable provider decision. */
  readonly startedAt: number;
}

