import { StreamingThinkingInterceptor } from "../lib/chat/StreamingThinkingInterceptor";
import { StreamingCadenceBuffer } from "../lib/chat/streamBuffer";
import { normalizeProgressNarration } from "../lib/progressNarration";
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
    currentImageCount,
    contextSignals,
    effectiveIntentSummary,
    isHidden,
    createVisibleTurnForHiddenMessage,
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

  const appendTurnBlock = (block: TaskBlock) => {
    const targetTurnId = block.turnId && block.turnId !== turnId ? block.turnId : context.uiDisplayTurnId;
    const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: targetTurnId } as TaskBlock);
    if (blockWithTurn.type === "agent") {
      context.agentBlockIdsCreatedThisRun.add(blockWithTurn.id);
    }
    sessionSet((s: any) => ({
      taskFlow: [...s.taskFlow, blockWithTurn],
      conversationTurns: s.conversationTurns.map((turn: any) =>
        turn.id === targetTurnId && !turn.blockIds.includes(blockWithTurn.id)
          ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
          : turn
      ),
    }));
  };

  const emitProgressRuntimeEvent = (progress: any, meta: { dedupeKey?: string } = {}) => {
    const eventId = "event-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    sessionSet((s: any) => ({
      runtimeEvents: [
        ...s.runtimeEvents,
        {
          id: eventId,
          turnId,
          sessionKey: context.runSessionKey,
          workspace: context.runWorkspace || null,
          timestamp: Date.now(),
          type: "progress",
          dedupeKey: meta.dedupeKey || null,
          payload: progress,
        },
      ],
    }));
  };

  const buildUnderstandingProgress = (status: "running" | "done" = "running") => {
    const hasImages = currentImageCount > 0;
    const hasContextItems = contextSignals.mentionedFilePaths.length > 0 || contextSignals.attachedFilePaths.length > 0;
    const contextText = hasImages
      ? phaseLanguage === "zh"
        ? "用户提供了 " + currentImageCount + " 张图片；先理解截图、约束和预期行为。"
        : "The user provided " + currentImageCount + " image(s); first understand the screenshots, constraints, and expected behavior."
      : hasContextItems
      ? phaseLanguage === "zh"
        ? "用户提供了上下文文件或引用；先确认这些材料与目标的关系。"
        : "The user provided contextual files or references; first map them to the request."
      : phaseLanguage === "zh"
      ? "先确认用户目标、约束和安全边界。"
      : "First confirm the user goal, constraints, and safety boundary.";
    const next = effectiveRunIntent === "plan"
      ? phaseLanguage === "zh"
        ? "随后只做定向读取与证据收束，批准前只写计划文件。"
        : "Next, use targeted reads and evidence synthesis; before approval only plan artifacts may be written."
      : effectiveRunIntent === "execute" || effectiveRunIntent === "studio_workflow"
      ? phaseLanguage === "zh"
        ? "随后读取最小必要上下文，再执行真实操作或明确说明阻塞。"
        : "Next, read the minimum necessary context, then act or state a concrete blocker."
      : effectiveRunIntent === "respond" || effectiveRunIntent === "discuss"
      ? phaseLanguage === "zh"
        ? "随后基于上下文给出直接答复。"
        : "Next, answer directly from the available context."
      : "";
    return normalizeProgressNarration({
      phase: "understanding",
      title: phaseLanguage === "zh" ? "理解需求" : "Understanding request",
      why: effectiveIntentSummary || contextText,
      action: contextText,
      evidence: hasImages || hasContextItems ? contextText : "",
      next,
      targets: [],
      status,
      source: "runtime",
      hypothesisStatus: status === "done" ? "confirmed" : "unverified",
    });
  };

  const appendUnderstandingProgress = () => {
    if (isHidden && !createVisibleTurnForHiddenMessage) return;
    const progress = buildUnderstandingProgress("running");
    const blockId = nextTaskId();
    context.understandingProgressBlockId = blockId;
    appendTurnBlock({
      id: blockId,
      turnId,
      turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "running" }),
      type: "progress",
      ...progress,
    });
    emitProgressRuntimeEvent(progress, {
      dedupeKey: "understanding:" + turnId,
    });
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
  appendUnderstandingProgress();

  return {
    thinkingInterceptor,
    streamBuffer,
  };
}
