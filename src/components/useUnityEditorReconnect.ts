import { useEffect, useRef } from "react";
import { toUserChoiceResolutionIdentity } from "../lib/actionRequest";
import { runUnityEditorOperation } from "../lib/ipc";
import { normalizeRuntimeV2Checkpoint } from "../lib/runtime-v2/checkpoint";
import { readyUnityEditorRoute, retryableUnityEditorCheck } from "../lib/runtime-v2/unityCompilation";
import { logStoreEvent, useAppStore } from "../store/useAppStore";

export function useUnityEditorReconnect() {
  const request = useAppStore(state => state.activeActionRequest);
  const marker = useAppStore(state => state.harnessRunMarker);
  const workspace = useAppStore(state => state.currentWorkspace);
  const attempts = useRef<{ runId: string; routes: Set<string> } | null>(null);

  useEffect(() => {
    if (!workspace || request?.kind !== "user_choice" || !request.executionBlocker ||
        marker?.status !== "paused" || marker.runId !== request.runId || marker.sessionKey !== request.sessionKey) return;
    const checkpoint = normalizeRuntimeV2Checkpoint(useAppStore.getState().runtimeV2Checkpoints[request.turnId]);
    const aggregate = checkpoint?.aggregate;
    const blocker = aggregate?.run?.blocker;
    if (!aggregate || aggregate.turn.workspaceKey !== workspace || blocker?.requestId !== request.requestId ||
        blocker.reasonCode !== "unity_editor_verification_pending" || blocker.decision) return;
    const check = retryableUnityEditorCheck(aggregate);
    if (!check || check.sequence !== blocker.evidenceSequence) return;

    if (attempts.current?.runId !== request.runId) attempts.current = { runId: request.runId, routes: new Set() };
    const tried = attempts.current.routes;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const current = () => {
      const state = useAppStore.getState();
      return !abort.signal.aborted && state.currentWorkspace === workspace &&
        state.activeActionRequest === request && state.harnessRunMarker?.status === "paused" &&
        state.harnessRunMarker?.runId === request.runId && state.harnessRunMarker?.sessionKey === request.sessionKey;
    };
    const probe = async () => {
      if (!current()) return;
      if (document.visibilityState === "visible") {
        const observation = await runUnityEditorOperation("unity_probe_editor", { workspace }, abort.signal, Date.now() + 4_000)
          .catch(() => null);
        if (!current()) return;
        const ready = readyUnityEditorRoute(check.result, observation);
        const key = JSON.stringify([check.boundary, check.result.kind, ready]);
        if (ready && !tried.has(key)) {
          tried.add(key);
          logStoreEvent("runtime_v2_editor_reconnected", {
            sessionKey: request.sessionKey, turnId: request.turnId, runId: request.runId,
            requestId: request.requestId, mutationSequence: check.boundary, checkKind: check.result.kind,
          });
          useAppStore.getState().sendMessage("recheck", undefined, {
            editorVerificationReconnect: toUserChoiceResolutionIdentity(request),
          });
        }
      }
      timer = setTimeout(probe, 8_000);
    };
    timer = setTimeout(probe, 4_000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [request, marker?.runId, marker?.sessionKey, marker?.status, workspace]);
}
