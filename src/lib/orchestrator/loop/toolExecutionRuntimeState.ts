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
  browserValidationCache: Map<string, ToolExecutionResult>;
  readOnlyDuplicateSkipCounts: Map<string, number>;
  fileReadStates: Map<string, FileReadState>;
}

export function createAgentLoopToolExecutionRuntimeState(
  sessionKey: string,
): AgentLoopToolExecutionRuntimeState {
  return {
    readOnlyResultCache: new Map(),
    browserValidationCache: new Map(),
    readOnlyDuplicateSkipCounts: new Map(),
    fileReadStates: getSessionFileReadStates(sessionKey),
  };
}
