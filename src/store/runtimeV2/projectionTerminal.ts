import type {
  RuntimeV2Projection,
  TurnAggregateV1,
} from "../../lib/runtime-v2";

/** Keep raw provider diagnostics out of the user-facing final projection. */
export function localizedRuntimeV2FinalProjection(
  aggregate: TurnAggregateV1,
  projection: RuntimeV2Projection,
  language: "zh" | "en",
): RuntimeV2Projection {
  if (
    aggregate.terminalOutcome?.reason !==
      "provider_transports_unavailable" &&
    aggregate.terminalOutcome?.reason !== "provider_transport_exhausted"
  ) {
    return projection;
  }
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
