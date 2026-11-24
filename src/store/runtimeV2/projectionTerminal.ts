import {
  buildRuntimeV2FinalProjection,
  type RuntimeV2Projection,
  type RuntimeV2ProjectionAudience,
  type RuntimeV2RunIdentity,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import {
  getHarnessActionRunId,
  persistHarnessRunMarkerIfOwned,
  readHarnessRunMarker,
  type HarnessRunMarker,
} from "../../lib/harnessCrashTelemetry";

/** Mirror only an accepted canonical final to its exact outer crash marker. */
export function syncRuntimeV2TerminalHarnessMarker(input: {
  readonly accepted: boolean;
  readonly audience: RuntimeV2ProjectionAudience;
  readonly run: RuntimeV2RunIdentity;
  readonly owner: HarnessRunMarker | null;
  readonly marker: HarnessRunMarker | null;
}): void {
  const { accepted, audience, run, owner, marker } = input;
  if (
    accepted && audience === "final" && marker?.status === "completed" &&
    owner?.runId === run.runId && owner.sessionKey === run.sessionKey &&
    owner.turnId === run.turnId && typeof owner.instanceId === "string" &&
    Number.isFinite(owner.startedAt)
  ) {
    const currentMarker = readHarnessRunMarker();
    if (
      getHarnessActionRunId(currentMarker) === getHarnessActionRunId(owner) &&
      currentMarker?.activeParentRunId === owner.activeParentRunId
    ) {
      // Its existing CAS fences foreign owner generations.
      persistHarnessRunMarkerIfOwned(marker, {
        runId: owner.runId,
        sessionKey: owner.sessionKey,
        turnId: run.turnId,
        instanceId: owner.instanceId,
        startedAt: owner.startedAt,
      });
    }
  }
}

/** Keep raw provider diagnostics out of the user-facing final projection. */
export function localizedRuntimeV2FinalProjection(
  aggregate: TurnAggregateV1,
  projection: RuntimeV2Projection,
  language: "zh" | "en",
): RuntimeV2Projection {
  if (
    aggregate.terminalOutcome?.reason ===
      "provider_transports_unavailable" ||
    aggregate.terminalOutcome?.reason === "provider_transport_exhausted"
  ) {
    const markdown = language === "en"
      ? [
          "### Execution failed",
          "",
          "The task did not finish because the configured model provider had no compatible request path available. No model response was accepted, and all committed evidence was preserved.",
        ].join("\n")
      : [
          "### 执行失败",
          "",
          "当前模型服务没有可用的兼容请求通道，本轮没有接受任何模型回复；已经保留全部已提交证据。",
        ].join("\n");
    return { ...projection, markdown };
  }
  const outcome = aggregate.terminalOutcome;
  const finalize = [...aggregate.events]
    .reverse()
    .find(
      (event) =>
        event.type === "command.scheduled" &&
        event.command.kind === "finalize_turn",
    );
  const finalizedMarkdown =
    finalize?.type === "command.scheduled"
      ? String(finalize.command.payload.finalMarkdown || "").trim()
      : "";
  if (
    language === "en" &&
    outcome &&
    !finalizedMarkdown &&
    /^### (?:已完成|已部分完成|需要继续处理|执行遇到错误|已取消)\b/.test(
      projection.markdown.trim(),
    )
  ) {
    return buildRuntimeV2FinalProjection(
      aggregate,
      projection.id,
      outcome.resultKind,
      outcome.reason,
      undefined,
      "en",
    );
  }
  return projection;
}
