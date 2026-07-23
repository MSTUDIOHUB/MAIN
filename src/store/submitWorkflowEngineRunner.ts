import {
  WorkflowEngine,
  type WorkflowContext,
  type WorkflowEngineStoreHelpers,
  type WorkflowRunSettlement,
} from "../lib/orchestrator/workflowEngine";
import { saveProjectSession } from "../lib/ipc";

type SubmitWorkflowStoreGet = () => any;
type SubmitWorkflowStoreSet = any;

type SubmitWorkflowEngineHelperInputs = Omit<WorkflowEngineStoreHelpers, "persistSessionRecord">;

export interface RunSubmitWorkflowEngineInput extends SubmitWorkflowEngineHelperInputs {
  get: SubmitWorkflowStoreGet;
  set: SubmitWorkflowStoreSet;
  context: WorkflowContext;
}

export function createSubmitWorkflowEngineHelpers(
  input: SubmitWorkflowEngineHelperInputs,
): WorkflowEngineStoreHelpers {
  return {
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    sanitizeAgentMessagesForPersist: input.sanitizeAgentMessagesForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    normalizeProviderCompatibilityByRuntimeKey: input.normalizeProviderCompatibilityByRuntimeKey,
    compactCompletedTurnAgentMessages: input.compactCompletedTurnAgentMessages,
    normalizeQueuedUserMessage: input.normalizeQueuedUserMessage,
    getSessionRevisionToken: input.getSessionRevisionToken,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    startApprovedPlanExecutionInCurrentTurn: input.startApprovedPlanExecutionInCurrentTurn,
    persistSessionRecord: saveProjectSession,
    logStoreEvent: input.logStoreEvent,
  };
}

export function runSubmitWorkflowEngine(
  input: RunSubmitWorkflowEngineInput,
): Promise<WorkflowRunSettlement> {
  const engine = new WorkflowEngine(
    input.get,
    input.set,
    createSubmitWorkflowEngineHelpers(input),
  );
  return engine.run(input.context);
}
