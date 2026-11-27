import { extractReadFileWindowMetadata } from "../readFileWindow";
import type { TurnAggregateV1 } from "./aggregate";
import { runtimeV2EvidenceVersion } from "./evidenceVersion";
import { runtimeV2UnityRepairObservations, runtimeV2UnityRepairObservationKey } from "./unityRepairLoop";

const EMPTY_SEARCH = runtimeV2EvidenceVersion([]);

/** A new receipt is useful only when it supplies a previously unseen fact. */
export function runtimeV2NovelExecutionObservationSequences(state: TurnAggregateV1): ReadonlySet<number> {
  const novelSequences = new Set<number>();
  const facts = new Set<string>();
  const editorObservations = runtimeV2UnityRepairObservations(state);
  let discoveryOpen = false;
  const remember = (key: string, sequence: number, discovery = false) => {
    if (facts.has(key)) return false;
    facts.add(key);
    if (discovery && discoveryOpen) return false;
    novelSequences.add(sequence);
    return true;
  };
  for (const event of state.events) {
    if ("run" in event && event.run.runId !== state.run?.identity.runId) continue;
    if (event.type === "tool.completed" && event.receiptOrigin === "replayed") continue;
    const observed = editorObservations.get(event.sequence) ?? runtimeV2UnityRepairObservationKey(state, event);
    if (observed !== undefined) {
      if (remember(observed, event.sequence)) discoveryOpen = false;
      continue;
    }
    const evidence = event.type === "tool.completed" && event.status === "succeeded" ? event.evidence
      : event.type === "observation.recorded" ? [event.evidence]
      : event.type === "subagent.completed" && event.status === "completed" ? event.evidence : [];
    const tool = event.type === "tool.completed" ? event.presentation?.toolName : undefined;
    const discovery = tool === "grep_search" || tool === "glob_search";
    const window = tool === "read_file" && event.type === "tool.completed" ? extractReadFileWindowMetadata(event.modelContent ?? "") : null;
    for (const item of evidence) {
      if (discovery && (!item.version || item.version === EMPTY_SEARCH)) continue;
      const key = window?.contentVersion === item.version && item.kind === "source"
        ? JSON.stringify(["source-window", item.target, item.version, window.returnedStartChar ?? window.returnedStartLine, window.returnedEndChar ?? window.returnedEndLine])
        : discovery
        ? JSON.stringify([tool, item.version])
        : JSON.stringify([item.kind, item.target, item.version, event.type === "tool.completed" ? event.modelContent : undefined]);
      if (!remember(key, event.sequence, discovery)) continue;
      if (discovery) discoveryOpen = true;
      else if (tool === "read_file" || item.kind === "mutation" || event.type === "subagent.completed") discoveryOpen = false;
    }
  }
  return novelSequences;
}
