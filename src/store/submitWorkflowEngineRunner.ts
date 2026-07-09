import {
  WorkflowEngine,
  type WorkflowContext,
  type WorkflowEngineStoreHelpers,
} from "../lib/orchestrator/workflowEngine";

type SubmitWorkflowStoreGet = () => any;
type SubmitWorkflowStoreSet = any;

export interface RunSubmitWorkflowEngineInput extends WorkflowEngineStoreHelpers {
  get: SubmitWorkflowStoreGet;
  set: SubmitWorkflowStoreSet;
  context: WorkflowContext;
}

export function createSubmitWorkflowEngineHelpers(
  input: WorkflowEngineStoreHelpers,
): WorkflowEngineStoreHelpers {
  return {
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    sanitizeAgentMessagesForPersist: input.sanitizeAgentMessagesForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    normalizeProviderCompatibilityByRuntimeKey: input.normalizeProviderCompatibilityByRuntimeKey,
    compactCompletedTurnAgentMessages: input.compactCompletedTurnAgentMessages,
    normalizeQueuedUserMessage: input.normalizeQueuedUserMessage,
    startApprovedPlanExecutionTurnFromHandoff: input.startApprovedPlanExecutionTurnFromHandoff,
    logStoreEvent: input.logStoreEvent,
  };
}

export function runSubmitWorkflowEngine(
  input: RunSubmitWorkflowEngineInput,
): Promise<boolean> {
  const engine = new WorkflowEngine(
    input.get,
    input.set,
    createSubmitWorkflowEngineHelpers(input),
  );
  return engine.run(input.context);
}
