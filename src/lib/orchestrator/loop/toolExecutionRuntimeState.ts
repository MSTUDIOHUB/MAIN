import {
  getSessionFileReadStates,
  type FileReadState,
} from "../../orchestrator/fileReadCache";
import type {
  CachedReadOnlyToolResult,
  ToolExecutionResult,
} from "../types";

export interface AgentLoopToolExecutionRuntimeState {
  readOnlyResultCache: Map<string, CachedReadOnlyToolResult>;
  approvedPlanBrowserValidationCache: Map<string, ToolExecutionResult>;
  readOnlyDuplicateSkipCounts: Map<string, number>;
  fileReadStates: Map<string, FileReadState>;
}

export function createAgentLoopToolExecutionRuntimeState(
  sessionKey: string,
): AgentLoopToolExecutionRuntimeState {
  return {
    readOnlyResultCache: new Map(),
    approvedPlanBrowserValidationCache: new Map(),
    readOnlyDuplicateSkipCounts: new Map(),
    fileReadStates: getSessionFileReadStates(sessionKey),
  };
}
