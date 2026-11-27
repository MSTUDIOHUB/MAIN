import { runUnityEditorOperation } from "../../lib/ipc";
import { isProviderImageContentCompatibilityErrorMessage, type CompatibilityMessage } from "../../lib/providerCompatibility";
import { runtimeV2WorkspaceChangeReceipts, type RuntimeV2Command, type TurnAggregateV1 } from "../../lib/runtime-v2";
import { UNITY_GAME_VIEW_TOOL } from "../../lib/runtime-v2/workspaceReadPolicy";
import type { ToolDefinition } from "../../lib/toolSchemas";
import { resolveTurnVisualPayloadBinding, resolveVisualContextDeliveryStateFromReceipt, type VisualTransportReceipt } from "../../lib/visualContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export const UNITY_GAME_VIEW_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: UNITY_GAME_VIEW_TOOL,
    description: "Capture the connected Unity project's current Game View and send the frame to your next model request. Use this for visual checks of game layout, scale, and HUD. It takes no arguments and does not enter Play Mode or test input.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

export interface RuntimeV2UnityGameViewCapture {
  readonly command: Pick<RuntimeV2Command, "run" | "idempotencyKey">;
  readonly imageDataUrl: string;
  sent?: true;
}

export async function captureRuntimeV2UnityGameView(
  ports: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) {
  const workspace = ports.context.runWorkspace;
  if (!workspace || Object.keys(args).length) {
    throw new Error("Game View capture takes no arguments and requires a Unity workspace.");
  }
  ports.live.unityGameViewCapture = undefined;
  const result = await runUnityEditorOperation(UNITY_GAME_VIEW_TOOL, { workspace }, signal,
    Math.min(ports.now() + 15_000, ports.lifecycleDeadlineAt ?? Infinity)) as {
      status?: string; imageDataUrl?: string; width?: number; height?: number; message?: string;
    } | null;
  signal.throwIfAborted();
  const { imageDataUrl, width, height } = result ?? {};
  if (result?.status !== "captured" || typeof imageDataUrl !== "string" ||
      !imageDataUrl.startsWith("data:image/png;base64,") || imageDataUrl.length > 7_000_000 ||
      typeof width !== "number" || typeof height !== "number" ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return { status: "unavailable", message: result?.message || "The Unity Editor did not return a usable Game View frame." };
  }
  // The text receipt is durable. Pixels stay in the current Run's memory and
  // never enter the canonical transcript, checkpoint or tool presentation.
  ports.live.unityGameViewCapture = { command, imageDataUrl };
  return {
    status: "captured", width, height,
    message: "A Game View frame was captured. Inspect the image attached to the model request when available. A file path or this receipt alone does not show the pixels. Re-capture if the image is unavailable after resuming.",
  };
}

export function runtimeV2UnityGameViewMessage(
  aggregate: TurnAggregateV1 | null | undefined,
  run: RuntimeV2Command["run"],
  capture: RuntimeV2UnityGameViewCapture | undefined,
): CompatibilityMessage | undefined {
  if (!aggregate || !capture || run.runId !== capture.command.run.runId ||
      run.turnId !== capture.command.run.turnId || run.sessionKey !== capture.command.run.sessionKey ||
      run.sessionEpoch !== capture.command.run.sessionEpoch || run.attemptId !== capture.command.run.attemptId) return;
  const receipt = aggregate.events.find(event => event.type === "tool.completed" &&
    event.run.runId === run.runId && event.idempotencyKey === capture.command.idempotencyKey &&
    event.status === "succeeded" && event.effectKind === "observation");
  if (!receipt || runtimeV2WorkspaceChangeReceipts(aggregate).some(change => change.sequence > receipt.sequence)) return;
  // Resuming after a user action or running another Editor-affecting action
  // can change the Game View even when nothing was written to disk.
  const laterEvents = aggregate.events.filter(event => event.sequence > receipt.sequence);
  if (laterEvents.some(event => event.type === "run.resumed")) return;
  if (capture.sent) {
    const shellCommands = new Set(laterEvents.flatMap(event => event.type === "command.scheduled" &&
      event.command.payload.toolName === "run_command" ? [event.command.idempotencyKey] : []));
    if (laterEvents.some(event => event.type === "validation.completed" || (event.type === "tool.completed" &&
        (event.effectKind === "external_operation" || shellCommands.has(event.idempotencyKey))))) return;
  }
  return {
    role: "user",
    runtimeTurnId: run.turnId,
    content: [
      { type: "text", text: "Unity Game View frame captured by MAIN for the current task. Compare visible layout, scale, or HUD with the request and report what the pixels show. If the frame is blank, say so. A still frame cannot establish keyboard input or gameplay behavior." },
      { type: "image_url", image_url: { url: capture.imageDataUrl } },
    ],
  };
}

function logGameViewTransport(ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command,
  capture: RuntimeV2UnityGameViewCapture | undefined, serializedImageParts: number, omissionReason?: string) {
  ports.logStoreEvent("runtime_v2_unity_game_view_transport", {
    turnId: command.run.turnId, runId: command.run.runId, commandKey: command.idempotencyKey,
    captureCommandKey: capture?.command.idempotencyKey, serializedImageParts, omissionReason: omissionReason ?? null,
  });
}

export async function withRuntimeV2GameViewFallback<T>(
  ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command, signal: AbortSignal, request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (signal.aborted || ports.live.unityGameViewImageRejected || !isProviderImageContentCompatibilityErrorMessage(String(error)) ||
        !runtimeV2UnityGameViewMessage(aggregateForCurrentTurn(ports), command.run, ports.live.unityGameViewCapture)) throw error;
    ports.live.unityGameViewImageRejected = true;
    logGameViewTransport(ports, command, ports.live.unityGameViewCapture, 0, "provider_unsupported");
    return request();
  }
}

export function runtimeV2GameViewRequestContext(ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command, aggregate: TurnAggregateV1 | null) {
  const capture = ports.live.unityGameViewCapture;
  const rejected = ports.live.unityGameViewImageRejected;
  const message = rejected ? undefined : runtimeV2UnityGameViewMessage(aggregate, command.run, capture);
  const messages = message ? [message] : [];
  const binding = resolveTurnVisualPayloadBinding(messages, { owner: command.run, expectedImageParts: 1 });
  return {
    messages,
    options: binding ? { visualTransportBinding: binding } : {},
    instruction: (enabled: boolean) => rejected
      ? "The selected model endpoint rejected the Game View image. Visual inspection is still pending. Report this explicitly and continue with any independent checks."
      : enabled ? "For visible changes in the Unity game, use capture_unity_game_view to inspect the Game View pixels. Use a separate runtime check for input and gameplay behavior." : "",
    record(transport: VisualTransportReceipt | undefined) {
      if (!capture || !message) return;
      const delivery = resolveVisualContextDeliveryStateFromReceipt({ expectedImageParts: 1, expectedBinding: binding, receipt: transport });
      if (delivery.status === "delivered") capture.sent = true;
      logGameViewTransport(ports, command, capture, delivery.deliveredImageParts, transport?.omissionReason);
    },
  };
}
