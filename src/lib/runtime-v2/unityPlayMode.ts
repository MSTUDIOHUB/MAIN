import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Command, RuntimeV2ExecutionValidationAuthority } from "./contracts";
import { deriveRuntimeV2ExecutionContract } from "./executionContract";
import { freshRuntimeV2PipelineConsoleSample, isRuntimeV2EditorDiagnosticRepair } from "./editorConsoleEvidence";
import { deriveUnityCompilation, verifiedUnityConsoleRepair } from "./unityCompilation";
import {
  latestRuntimeV2WorkspaceChange,
  resolveRuntimeV2DirectExecuteValidationAuthority,
  runtimeV2ValidationBoundaryMatchesCurrent,
} from "./validationReceipt";
import { projectEditorPlayModeFilter } from "../unityValidation";
import { canonicalJson } from "../canonicalJson";

type UnityPlayModeBinding = {
  readonly compilerSequence: number;
  readonly consoleBinding: { readonly editorPid: number; readonly editorVersion: string };
  readonly expectedVersions: Readonly<Record<string, string | null>>;
};

interface UnityPlayModePayload {
  readonly toolName: "run_command";
  readonly arguments: { readonly command: string; readonly cwd: "." };
  readonly validationAuthority: RuntimeV2ExecutionValidationAuthority;
  readonly unityPlayModeBinding: UnityPlayModeBinding;
}

function requiredPlayMode(state: TurnAggregateV1 | null) {
  if (!state?.run || state.strategy !== "execute" || state.workPlan ||
      deriveRuntimeV2ExecutionContract(state) || !isRuntimeV2EditorDiagnosticRepair(state)) return;
  const receipt = deriveUnityCompilation(state)?.receipt;
  const result = receipt?.result;
  if (!result?.playMode || !receipt || result.status !== "passed" || result.projectRoot !== "." ||
      result.editor !== "connected" || !result.editorPid || !result.editorVersion ||
      !verifiedUnityConsoleRepair(state)) return;
  const targets = result.targets ?? [];
  if (!targets.length || targets.some(target => target.version !== null && !/^sha256-[a-f0-9]{64}$/.test(target.version))) return;
  const binding: UnityPlayModeBinding = { compilerSequence: receipt.sequence,
    consoleBinding: { editorPid: result.editorPid, editorVersion: result.editorVersion },
    expectedVersions: Object.fromEntries(targets.map(target => [target.path, target.version])) };
  const suites = result.playMode.suites;
  if (result.playMode.status !== "discovered" || !Array.isArray(suites) || suites.length > 16 ||
      suites.some(suite => !suite || !projectEditorPlayModeFilter(`unity test . --mode PlayMode --filter ${suite.filter}`) ||
        !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > 256 || new Set(suite.cases).size !== suite.cases.length ||
        suite.cases.some((name: unknown) => typeof name !== "string" || !name.startsWith(`${suite.filter}.`) || name.length > 500))) {
    return { binding, requirements: [], unavailable: true as const };
  }
  if (!suites.length) return;
  const requirements = suites.flatMap(suite => {
    const validationAuthority = resolveRuntimeV2DirectExecuteValidationAuthority({ aggregate: state, turnId: state.turn.turnId,
      objective: state.objective, validationId: `unity-playmode:${binding.compilerSequence}:${suite.filter}` });
    return validationAuthority ? [{ toolName: "run_command", arguments: { command: `unity test . --mode PlayMode --filter ${suite.filter}`, cwd: "." },
      validationAuthority: { ...validationAuthority, useProjectEditor: true, expectedTestCases: suite.cases.length, expectedTestCaseNames: suite.cases },
      unityPlayModeBinding: binding } satisfies UnityPlayModePayload] : [];
  });
  return { binding, requirements, unavailable: requirements.length !== suites.length };
}

function admittedPlayModeCommands(state: TurnAggregateV1, requirement: UnityPlayModePayload) {
  return state.events.flatMap(event => event.type === "command.scheduled" && event.run.runId === state.run?.identity.runId &&
    event.command.kind === "execute_validation" && samePayload(event.command, requirement) ? [event.command.idempotencyKey] : []);
}

function samePayload(command: RuntimeV2Command, expected: UnityPlayModePayload) {
  return Object.entries(expected).every(([key, value]) => canonicalJson(command.payload[key]) === canonicalJson(value));
}

export function nextRuntimeV2UnityPlayModeValidation(state: TurnAggregateV1): UnityPlayModePayload | undefined {
  const current = requiredPlayMode(state);
  if (!current || current.unavailable || state.phase !== "validating" || state.pendingToolCalls.length) return;
  return current.requirements.find(requirement => !admittedPlayModeCommands(state, requirement).length);
}

export function runtimeV2UnityPlayModeBindingForCommand(state: TurnAggregateV1 | null, command: RuntimeV2Command) {
  if (command.kind !== "execute_validation" || !state || state.run?.status !== "running" ||
      state.run.identity.runId !== command.run.runId) return;
  const queued = state.scheduledCommands.find(item => item.idempotencyKey === command.idempotencyKey && item.kind === command.kind &&
    item.run.runId === command.run.runId);
  if (!queued) return;
  const requirement = requiredPlayMode(state)?.requirements.find(item => samePayload(queued, item) && samePayload(command, item));
  return requirement?.unityPlayModeBinding;
}

export function runtimeV2UnityPlayModeCovered(state: TurnAggregateV1): boolean {
  const current = requiredPlayMode(state);
  if (!current) return true;
  if (current.unavailable) return false;
  return current.requirements.every(requirement => {
    const commands = admittedPlayModeCommands(state, requirement);
    const attempt = [...state.events].reverse().find(event => event.type === "validation.completed" &&
      event.run.runId === state.run?.identity.runId && commands.includes(event.idempotencyKey));
    const console = attempt?.type === "validation.completed" ? freshRuntimeV2PipelineConsoleSample(attempt.postPlayModeConsole) : undefined;
    return attempt?.type === "validation.completed" && attempt.passed && !!attempt.authority &&
      console?.errors === 0 && !console.compilationFailed &&
      canonicalJson(attempt.authority) === canonicalJson(requirement.validationAuthority) &&
      attempt.evidence.some(evidence => evidence.kind === "validation") &&
      runtimeV2ValidationBoundaryMatchesCurrent({ aggregate: state, targetPaths: requirement.validationAuthority.targetPaths,
        mutationBoundarySequence: attempt.mutationBoundarySequence, validatedMutationVersions: attempt.validatedMutationVersions });
  });
}

export function runtimeV2UnityPlayModeUnavailable(state: TurnAggregateV1) {
  const current = requiredPlayMode(state);
  if (current?.unavailable) return { sequence: current.binding.compilerSequence, reason: "discovery" as const };
  const boundary = latestRuntimeV2WorkspaceChange(state)?.sequence;
  if (!current || boundary === undefined) return;
  const commands = current.requirements.flatMap(requirement => admittedPlayModeCommands(state, requirement));
  const attempt = [...state.events].reverse().find(event => event.type === "validation.completed" &&
    commands.includes(event.idempotencyKey) && event.sequence > boundary);
  if (attempt?.type === "validation.completed" && !attempt.passed && attempt.failureKind === "not_executed") {
    return { sequence: current.binding.compilerSequence, reason: "test" as const };
  }
}
