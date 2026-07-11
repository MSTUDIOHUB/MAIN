import { StreamingThinkingInterceptor } from "../lib/chat/StreamingThinkingInterceptor";
import { StreamingCadenceBuffer } from "../lib/chat/streamBuffer";
import { resolveStreamingAssistantDisplay } from "../lib/streamDisplayPolicy";
import type { TaskBlock } from "../lib/taskTypes";
import {
  makeTurnRuntimePhase,
  normalizeTurnRuntimePhase,
  type TurnRuntimePhase,
} from "../lib/turnPhase";
import {
  appendThoughtDelta,
  compactThoughtContent,
  compactThoughtContentForPersist,
} from "../lib/thoughtCompaction";
import type { WorkflowContext } from "../lib/orchestrator/workflowEngine";

type SubmitSessionGet = () => any;
type SubmitSessionSet = (patch: any) => void;

export interface SubmitStreamingUiContextSignals {
  mentionedFilePaths: string[];
  attachedFilePaths: string[];
}

export interface StartSubmitStreamingUiInput {
  context: WorkflowContext;
  sessionGet: SubmitSessionGet;
  sessionSet: SubmitSessionSet;
  nextTaskId: () => number;
  currentImageCount: number;
  contextSignals: SubmitStreamingUiContextSignals;
  effectiveIntentSummary: string;
  isHidden: boolean;
  createVisibleTurnForHiddenMessage: boolean;
}

export interface SubmitStreamingUiLease {
  thinkingInterceptor: StreamingThinkingInterceptor;
  streamBuffer: StreamingCadenceBuffer;
}

export function startSubmitStreamingUi(
  input: StartSubmitStreamingUiInput,
): SubmitStreamingUiLease {
  const {
    context,
    sessionGet,
    sessionSet,
    nextTaskId,
  } = input;
  const turnId = context.turnId;
  const phaseLanguage = context.phaseLanguage;
  const effectiveRunIntent = context.effectiveRunIntent;
  const thinkingInterceptor = new StreamingThinkingInterceptor();
  context.thinkingInterceptor = thinkingInterceptor;

  const attachRuntimePhase = <T extends TaskBlock>(block: T, phase?: TurnRuntimePhase): T => {
    const normalized = normalizeTurnRuntimePhase(block.turnPhase || phase || makeTurnRuntimePhase("scope", phaseLanguage), phaseLanguage);
    return normalized ? { ...block, turnPhase: normalized } : block;
  };

  const streamBuffer = new StreamingCadenceBuffer({
    interceptor: thinkingInterceptor,
    flushIntervalMs: 90,
    onFlush: ({ agentDelta, thinkingDelta, thoughtStarted, thoughtEnded }) => {
      const latestStateForDedupe = sessionGet();
      const shouldDisplayReasoningBlocks = latestStateForDedupe.config.reasoningDisplay !== "hidden";
      const nextInterceptorThought = thinkingDelta
        ? appendThoughtDelta(latestStateForDedupe.currentTurnState.interceptorThought, thinkingDelta)
        : latestStateForDedupe.currentTurnState.interceptorThought;
      const currentInterceptorThoughtContent = thinkingInterceptor.getThinkingContent() || thinkingDelta;
      let thoughtIdToCreate: number | null = null;
      let thoughtIdToUpdate = context.currentThoughtBlockId;
      const thoughtDuration = context.thoughtStartTime ? Math.round((Date.now() - context.thoughtStartTime) / 1000) : undefined;

      if (thoughtStarted && shouldDisplayReasoningBlocks) {
        context.thoughtStartTime = Date.now();
        const existingThoughtBlock = sessionGet().taskFlow
          .filter((b: TaskBlock) => b.turnId === turnId)
          .reverse()
          .find((b: TaskBlock) => b.type === "thought");
        if (existingThoughtBlock && !existingThoughtBlock.isStreaming) {
          thoughtIdToCreate = null;
          context.currentThoughtBlockId = existingThoughtBlock.id;
          thoughtIdToUpdate = existingThoughtBlock.id;
        } else if (existingThoughtBlock && existingThoughtBlock.isStreaming) {
          thoughtIdToCreate = null;
          context.currentThoughtBlockId = existingThoughtBlock.id;
          thoughtIdToUpdate = existingThoughtBlock.id;
        } else {
          thoughtIdToCreate = nextTaskId();
          context.currentThoughtBlockId = thoughtIdToCreate;
          thoughtIdToUpdate = thoughtIdToCreate;
        }
      }

      let thoughtEndedId: number | null = null;
      if (thoughtEnded && context.currentThoughtBlockId !== null && shouldDisplayReasoningBlocks) {
        thoughtEndedId = context.currentThoughtBlockId;
        context.currentThoughtBlockId = null;
        context.thoughtStartTime = null;
      } else if (thoughtEnded && !shouldDisplayReasoningBlocks) {
        context.currentThoughtBlockId = null;
        context.thoughtStartTime = null;
      }

      let agentContent = agentDelta;
      let agentBlockIdToCreate: number | null = null;
      let agentBlockIdToAppend: number | null = null;

      if (agentContent) {
        if (nextInterceptorThought && context.currentStreamingBlockId === null) {
          const normThought = nextInterceptorThought.trim().toLowerCase().replace(/\s+/g, " ");
          const normAgent = agentContent.trim().toLowerCase().replace(/\s+/g, " ");

          if (normAgent.startsWith(normThought) || normThought.includes(normAgent)) {
            const overlapLen = nextInterceptorThought.trim().length;
            const possibleClean = agentContent.trim().slice(overlapLen).trim();
            if (!possibleClean) {
              agentContent = "";
            } else {
              agentContent = possibleClean;
            }
          }
        }

        if (agentContent) {
          const displayCandidate = context.streamingAssistantDisplayBuffer + agentContent;
          const displayDecision = resolveStreamingAssistantDisplay({
            text: displayCandidate,
            language: phaseLanguage,
            workflowMode: sessionGet().config.workflowMode,
            runIntent: effectiveRunIntent,
            hasVisibleAgentBlock: context.currentStreamingBlockId !== null,
          });
          if (displayDecision.action === "show") {
            agentContent = displayDecision.text;
            context.streamingAssistantDisplayBuffer = "";
          } else if (displayDecision.action === "buffer") {
            context.streamingAssistantDisplayBuffer = displayDecision.bufferText || displayCandidate;
            agentContent = "";
          } else {
            context.streamingAssistantDisplayBuffer = "";
            agentContent = "";
          }
        }

        if (agentContent) {
          if (context.currentStreamingBlockId === null) {
            agentBlockIdToCreate = nextTaskId();
            context.currentStreamingBlockId = agentBlockIdToCreate;
            context.agentBlockIdsCreatedThisRun.add(agentBlockIdToCreate);
          } else {
            agentBlockIdToAppend = context.currentStreamingBlockId;
          }
        }
      }

      if (!thinkingDelta && !thoughtStarted && !thoughtEndedId && !agentContent) return;

      sessionSet((s: any) => {
        let taskFlow = s.taskFlow;
        let conversationTurns = s.conversationTurns;

        const appendBlock = (block: TaskBlock) => {
          const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: block.turnId ?? turnId } as TaskBlock);
          taskFlow = [...taskFlow, blockWithTurn];
          conversationTurns = conversationTurns.map((turn: any) =>
            turn.id === turnId && !turn.blockIds.includes(blockWithTurn.id)
              ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
              : turn
          );
        };

        if (shouldDisplayReasoningBlocks && thoughtIdToCreate !== null) {
          appendBlock({
            id: thoughtIdToCreate,
            turnId,
            type: "thought",
            content: compactThoughtContent(currentInterceptorThoughtContent),
            isStreaming: true,
          });
        } else if (shouldDisplayReasoningBlocks && thoughtIdToUpdate !== null && thinkingDelta) {
          const tid = thoughtIdToUpdate;
          taskFlow = taskFlow.map((t: TaskBlock) =>
            t.id === tid && t.type === "thought"
              ? { ...t, content: compactThoughtContent(currentInterceptorThoughtContent), isStreaming: true }
              : t
          );
        }

        if (shouldDisplayReasoningBlocks && thoughtEndedId !== null) {
          const tid = thoughtEndedId;
          taskFlow = taskFlow.map((t: TaskBlock) =>
            t.id === tid && t.type === "thought"
              ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false, duration: thoughtDuration }
              : t
          );
        }

        if (agentBlockIdToCreate !== null && agentContent) {
          appendBlock({ id: agentBlockIdToCreate, turnId, type: "agent", content: agentContent, streaming: true });
        }

        if (agentBlockIdToAppend !== null && agentContent) {
          const blockId = agentBlockIdToAppend;
          taskFlow = taskFlow.map((t: TaskBlock) =>
            t.id === blockId && t.type === "agent"
              ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + agentContent, isEscalating: false }
              : t
          );
        }

        return {
          taskFlow,
          conversationTurns,
          currentTurnState: {
            ...s.currentTurnState,
            interceptorHandled: s.currentTurnState.interceptorHandled || thoughtStarted,
            interceptorThought: nextInterceptorThought,
          },
        };
      });
    },
  });

  context.streamBuffer = streamBuffer;

  return {
    thinkingInterceptor,
    streamBuffer,
  };
}
