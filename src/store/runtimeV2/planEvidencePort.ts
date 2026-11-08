import type { AgentMessage } from "../../lib/agentMessages";
import { getFileMetadata } from "../../lib/ipc";
import { beginCapsuleToolActivity } from "../../lib/capsuleLiveActivity";
import { runtimeV2BuiltinCapabilityRestriction } from "./executionCapabilityRestrictions";
import { normalizeTurnApprovalCapabilities, normalizeTurnCapabilityRestrictions } from "../../lib/turnCapabilities";
import { normalizeNetworkRead } from "../../lib/networkRead";
import { boundKnowledgeToolResult, normalizeKnowledgeReferences } from "../../lib/knowledgeReferences";
import { buildToolCatalog } from "../../lib/toolCatalog";
import { readOnlyEvidenceVersion, webEvidenceVersions } from "../../lib/runtime-v2/readOnlyProgress";
import { RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { getToolTarget } from "../../lib/toolTarget";
import { executeTool } from "../../lib/toolExecutor";
import { isAbsoluteWorkspacePath, workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import { extractReadFileWindowMetadata, replayReadFileWindowFromResult } from "../../lib/readFileWindow";
import {
  type RuntimeV2EvidenceReference,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { PlanLedger } from "./planLedger";
import {
  PLAN_CONTEXT_RESULT_CHARS,
  PLAN_READ_ONLY_TOOL_NAMES,
  planModelToolCandidates,
} from "./planModelProtocol";
import {
  boundedRuntimeV2ToolContent,
  runtimeV2ContextBoundToolArguments,
  runtimeV2SourceToolContent,
} from "./executionText";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { resolveRuntimeV2SourceEvidenceVersion } from "./sourceEvidenceVersion";
import { collectPlanDraftWorkspaceEvidence, type PlanDraftWorkspaceRead } from "./planDraftSource";
import { runtimeV2ProviderToolCallIdentity } from "./providerReadReceipts";
import { appendPlanToolResult } from "./planHistory";
import { observePlanSkillRead, planSkillReceipt } from "./planSkillGuidance";

export type RuntimeV2PlanLog = (
  event: string,
  data?: Record<string, unknown>,
) => void;

/** Reuse an interrupted canonical command; never create two receipts for one
 * admitted provider invocation during safe document-loop recovery. */
export async function schedulePlanTool(ledger: PlanLedger, run: RuntimeV2RunIdentity, call: RuntimeV2NormalizedProviderResult["toolCalls"][number]) {
  return ledger.snapshot()?.scheduledCommands?.find(command => command.kind === "execute_tool" &&
    command.payload.toolCallId === call.id && command.payload.toolName === call.name) || ledger.schedule(run, "execute_tool", {
    toolCallId: call.id, toolName: call.name, arguments: call.arguments,
    ...(call.name === "submit_runtime_v2_work_plan" ? { runtimeControlPlane: true } : {}),
  });
}

export async function settlePlanTool(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly status: "succeeded" | "failed" | "blocked";
  readonly evidence?: readonly RuntimeV2EvidenceReference[];
  readonly failureKind?: "protocol_invalid";
  readonly failureReasonCode?: string;
  readonly modelContent?: string;
  readonly receiptOrigin?: "executed" | "replayed";
  readonly presentation?: {
    readonly toolName: string;
    readonly target: string;
    readonly message?: string;
  };
}): Promise<void> {
  const command = await schedulePlanTool(input.ledger, input.run, input.call);
  await input.ledger.settleCommand({
    type: "tool.completed",
    run: input.run,
    idempotencyKey: command.idempotencyKey,
    status: input.status,
    evidence: input.evidence || [],
    ...(input.modelContent !== undefined ? { modelContent: input.modelContent } : {}),
    ...(input.receiptOrigin ? { receiptOrigin: input.receiptOrigin } : {}),
    ...(input.failureKind ? { failureKind: input.failureKind } : {}),
    ...(input.failureReasonCode
      ? { failureReasonCode: input.failureReasonCode }
      : {}),
    ...(input.presentation ? { presentation: input.presentation } : {}),
  });
}

/** Use an already-observed window while repairing validation. The metadata
 * probe is only a reuse hint; the original hash still binds approval freshness. */
async function replayRetainedPlanFile(input: {
  readonly aggregate: NonNullable<ReturnType<PlanLedger["snapshot"]>>;
  readonly workspace: string;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly historicalReads: readonly PlanDraftWorkspaceRead[];
}): Promise<{ id: string; version: string; content: string } | null> {
  const { call, workspace } = input;
  const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const path = normalizePath(String(call.arguments.path || ""));
  if (call.name !== "read_file" || !path || call.arguments.__raw === true) return null;
  const absolutePath = (value: string) => isAbsoluteWorkspacePath(value) ? normalizePath(value) : `${normalizePath(workspace)}/${normalizePath(value)}`;
  const target = absolutePath(path);
  const reads = [
    ...input.historicalReads.map(read => ({ read, id: `draft-${read.evidence.id}` })),
    ...collectPlanDraftWorkspaceEvidence({ source: input.aggregate, beforeSequence: input.aggregate.nextSequence })
      .map(read => ({ read, id: read.evidence.id })),
  ].filter(({ read }) => read.toolName === "read_file" && absolutePath(read.evidence.target) === target).reverse();
  const latest = reads[0]?.read;
  if (!latest?.evidence.version) return null;
  const version = latest.evidence.version;
  const identity = runtimeV2ProviderToolCallIdentity({ name: call.name, arguments: { ...call.arguments, path: target } });
  for (const { read, id } of reads) {
    if (read.evidence.version !== version) break;
    const header = `[${read.evidence.id}] ${read.evidence.target}\n`;
    const prior = read.modelContent.startsWith(header) ? read.modelContent.slice(header.length) : read.modelContent;
    const sameRequest = runtimeV2ProviderToolCallIdentity({
      name: read.toolName, arguments: { ...read.arguments, path: target },
    }) === identity;
    const window = extractReadFileWindowMetadata(prior);
    const content = sameRequest ? prior : call.arguments.start_char === undefined && window && window.returnedStartChar === undefined
      ? replayReadFileWindowFromResult(prior, { ...call.arguments, path: window.path })
      : null;
    if (!content) continue;
    const metadata = await getFileMetadata(path, workspace).catch(() => null);
    return metadata && normalizePath(metadata.path) === target &&
      Number.isFinite(metadata.modifiedMs) && metadata.modifiedMs <= latest.observedAt
      ? { id, version, content: `[${id}] ${read.evidence.target}\n${content}` } : null;
  }
  return null;
}

export async function executeReadOnlyPlanTool(input: {
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly messages: AgentMessage[];
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly parallelReadCount: number;
  readonly logStoreEvent: RuntimeV2PlanLog;
  readonly reuseRetainedRead?: { readonly historicalReads: readonly PlanDraftWorkspaceRead[] };
}): Promise<void> {
  const args = input.call.arguments;
  const networkTool = RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(input.call.name);
  const knowledgeTool = input.call.name === "knowledge_search" || input.call.name === "knowledge_get_excerpt";
  const knowledgeReferences = normalizeKnowledgeReferences(input.ledger.snapshot()?.knowledgeContext?.references);
  const networkRead = normalizeNetworkRead(input.ledger.snapshot()?.networkRead);
  const restriction = runtimeV2BuiltinCapabilityRestriction(
    normalizeTurnCapabilityRestrictions(input.ledger.snapshot()?.objective.capabilityRestrictions), input.call.name,
  );
  const review = runtimeV2BuiltinCapabilityRestriction(
    normalizeTurnApprovalCapabilities(input.ledger.snapshot()?.objective.approvalRequiredCapabilities), input.call.name,
  );
  if (restriction || review || (knowledgeTool && (!knowledgeReferences?.length || ["stale", "error"].includes(input.ledger.snapshot()?.knowledgeContext?.state || ""))) ||
    (!PLAN_READ_ONLY_TOOL_NAMES.has(input.call.name) && !(networkTool && networkRead.enabled))) {
    const content = restriction ? `TURN_CAPABILITY_RESTRICTED: ${restriction}` : review
      ? `TURN_TOOL_REVIEW_REQUIRED: ${review}. This Plan read adapter cannot approve an invocation; use Execute for individually reviewed tools.`
      : "PLAN_TOOL_BLOCKED: use a read-only tool or submit_runtime_v2_work_plan.";
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "blocked",
    });
    appendPlanToolResult(input.messages, input.call.id, content);
    await input.ledger.recordSoftSignal(
      input.run,
      "protocol_drift",
    );
    return;
  }
  const target = getToolTarget(input.call.name, args) || input.call.name;
  const aggregate = input.ledger.snapshot();
  if (input.reuseRetainedRead && aggregate && input.context.runWorkspace && input.call.name === "read_file") {
    const replay = await replayRetainedPlanFile({ aggregate, workspace: input.context.runWorkspace, call: input.call,
      historicalReads: input.reuseRetainedRead.historicalReads });
    if (input.context.abortCtrl?.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
    if (replay) {
      await settlePlanTool({ ledger: input.ledger, run: input.run, call: input.call, status: "succeeded",
        modelContent: replay.content, receiptOrigin: "replayed" });
      appendPlanToolResult(input.messages, input.call.id, replay.content);
      input.logStoreEvent("runtime_v2_plan_read_replayed", { turnId: input.run.turnId, runId: input.run.runId,
        toolName: input.call.name, target, evidenceId: replay.id, sourceVersion: replay.version });
      return;
    }
  }
  const runTool = async (toolName: string, task: () => ReturnType<typeof executeTool>) => {
    const signal = input.context.abortCtrl?.signal;
    if (!signal) return task();
    const finish = beginCapsuleToolActivity({
      run: input.run,
      // Plan admits this invocation before its canonical result command is
      // registered. Its scoped tool call is the transient operation identity.
      commandKey: input.call.id,
      signal,
      toolName,
      target,
    });
    try {
      return await task();
    } finally {
      finish();
    }
  };
  try {
    const output = await runTool(input.call.name, () => executeTool(
      input.call.name,
      runtimeV2ContextBoundToolArguments(
        input.call.name,
        args,
        input.context.runtimeContextBudget,
        { parallelReadCount: input.parallelReadCount, skillDefaultWindowChars: PLAN_CONTEXT_RESULT_CHARS },
      ),
      input.context.runWorkspace || "",
      input.context.runSessionKey,
      {
        skillCatalog: input.context.skillCatalog,
        ...(knowledgeTool ? { knowledgeReferences: knowledgeReferences || [] } : {}),
        ...(networkTool ? { networkRead } : {}),
        ...(input.call.name === "tool_search" ? { toolCatalog: buildToolCatalog({
          builtInDefinitions: planModelToolCandidates({ ...input.context, networkRead, knowledgeContext: input.ledger.snapshot()?.knowledgeContext }).filter((tool) =>
            !runtimeV2BuiltinCapabilityRestriction(normalizeTurnCapabilityRestrictions(
              input.ledger.snapshot()?.objective.capabilityRestrictions,
            ), tool.function.name)
          ),
        }) } : {}),
      },
    ));
    input.context.abortCtrl?.signal.throwIfAborted();
    const content = knowledgeTool ? boundKnowledgeToolResult(output, knowledgeReferences || [], Math.floor((input.context.runtimeContextBudget?.readWindowChars || 16_000) / Math.max(1, input.parallelReadCount)))
      : networkTool ? runtimeV2SourceToolContent(output) : boundedRuntimeV2ToolContent(
      input.call.name,
      output,
      input.context.runtimeContextBudget,
    );
    // A successful HTTP reader response can still lack a usable source. Keep
    // its exact diagnostic receipt, without manufacturing Plan/source evidence.
    const knowledgeResult = knowledgeTool ? JSON.parse(content) : null;
    if ((networkTool && !webEvidenceVersions(input.call.name, output)?.length) || (knowledgeTool && (!knowledgeResult || (Array.isArray(knowledgeResult.hits) && !knowledgeResult.hits.length)))) {
      await settlePlanTool({ ledger: input.ledger, run: input.run, call: input.call,
        status: "succeeded", evidence: [], modelContent: content, receiptOrigin: "executed" });
      appendPlanToolResult(input.messages, input.call.id, content);
      return;
    }
    const skillRead = planSkillReceipt(input.call, content);
    if (skillRead && !skillRead.content.length) {
      await settlePlanTool({ ledger: input.ledger, run: input.run, call: input.call,
        status: "succeeded", modelContent: content, receiptOrigin: "executed" });
      appendPlanToolResult(input.messages, input.call.id, content);
      return;
    }
    const skillObservation = skillRead ? observePlanSkillRead(input.messages, skillRead) : null;
    const evidenceTarget = skillRead ? getToolTarget(input.call.name, { ...skillRead.readTarget }) : target;
    const partialSkill = input.call.name === "load_skill" && (() => {
      try { return JSON.parse(String(output)).complete === false; }
      catch { return false; }
    })();
    const version = networkTool
      ? readOnlyEvidenceVersion(input.call.name, output)!
      : input.call.name === "load_skill"
      ? (() => {
          try {
            return String(JSON.parse(String(output || "")).version || "");
          } catch {
            return "";
          }
        })()
      : await resolveRuntimeV2SourceEvidenceVersion({
          toolName: input.call.name,
          args,
          output,
          readExactFile: () => runTool("read_file", () => executeTool(
            "read_file",
            { ...args, __raw: true },
            input.context.runWorkspace || "",
            input.context.runSessionKey,
          )),
        });
    if (input.reuseRetainedRead && input.call.name === "read_file") {
      for (let index = input.evidence.length - 1; index >= 0; index--) {
        const previous = input.evidence[index]!;
        if (previous.id.startsWith("draft-E") && workspacePathsReferToSameFile(previous.target, target)) {
          input.evidence.splice(index, 1);
          input.evidenceContents.delete(previous.id);
        }
      }
    }
    const existingEvidence = input.evidence.find((entry) =>
      workspacePathsReferToSameFile(entry.target, evidenceTarget) &&
      entry.version === version
    );
    const evidenceEntry = existingEvidence || {
      id: `E${1 + input.evidence.reduce((max, entry) => Math.max(max, /^E\d+$/.test(entry.id) ? Number(entry.id.slice(1)) : 0), 0)}`,
      target: evidenceTarget,
      version,
      statement: input.call.name === "load_skill"
        ? args.operation === "list"
          ? `已查看 Skill 目录 ${target} 的元数据；未加载正文，不构成项目源码证据。`
          : args.resource !== undefined
          ? `已读取 Skill ${target} 的${partialSkill ? "部分" : ""}参考说明；不代表完整 Skill 已加载，不构成项目源码证据。`
          : partialSkill
          ? `已读取 Skill ${target} 的目录或部分说明；完整内容仍可继续读取，不构成项目源码证据。`
          : `已加载 Skill ${target} 的冻结工作流说明；它不构成项目源码证据。`
        : knowledgeTool ? "已读取本条消息选用的知识参考；它不构成工作区源码租约、执行授权或验收证据。"
        : `${input.call.name} 已确认 ${target} 的当前内容。`,
    };
    const previousContent = existingEvidence
      ? input.evidenceContents.get(existingEvidence.id) || ""
      : "";
    const repeatedObservation = skillObservation ? skillObservation.newChars === 0 : !!existingEvidence && (
      previousContent === content ||
      previousContent.includes(content)
    );
    if (!existingEvidence && !repeatedObservation) {
      input.evidence.push(evidenceEntry);
    }
    if (!skillRead && !existingEvidence) {
      input.evidenceContents.set(evidenceEntry.id, content);
    } else if (!skillRead && !repeatedObservation) {
      input.evidenceContents.set(
        evidenceEntry.id,
          [
            previousContent,
            `[Additional read window for ${target}]`,
            content,
          ].filter(Boolean).join("\n\n"),
      );
    }
    // Keep the trusted Skill receipt intact in the ledger. An outbound replay
    // pointer is valid only while its covering receipt survived context trim.
    const modelContent = !existingEvidence && repeatedObservation ? content
      : existingEvidence && repeatedObservation && !skillRead
        ? `[${evidenceEntry.id}] ${evidenceTarget}\nRuntime v2 reused this unchanged source and observation.`
        : `[${evidenceEntry.id}] ${evidenceTarget}\n${content}`;
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "succeeded",
      modelContent,
      receiptOrigin: "executed",
      evidence: repeatedObservation ? [] : [{
        id: evidenceEntry.id,
        kind: input.call.name === "load_skill" || input.call.name === "tool_search" || networkTool || knowledgeTool ? "tool" : "source",
        target: evidenceTarget,
        version,
      }],
    });
    appendPlanToolResult(input.messages, input.call.id, modelContent);
    input.logStoreEvent(repeatedObservation
      ? "runtime_v2_plan_read_reused"
      : existingEvidence
        ? "runtime_v2_plan_read_extended"
        : "runtime_v2_plan_read_completed", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      toolName: input.call.name,
      target: evidenceTarget,
      evidenceId: !existingEvidence && repeatedObservation ? null : evidenceEntry.id,
      sourceVersion: version,
      observationVersion: await resolveRuntimeV2SourceEvidenceVersion({
        toolName: input.call.name,
        args: { ...args, __raw: true },
        output,
      }),
      retainedChars: skillObservation?.retainedChars ?? (input.evidenceContents.get(evidenceEntry.id)?.length || 0),
      ...(skillRead && skillObservation ? {
        skillVersion: skillRead.version,
        returnedRange: skillRead.returnedRange,
        newSkillChars: skillObservation.newChars,
        reusedSkillChars: skillRead.content.length - skillObservation.newChars,
      } : {}),
    });
    return;
  } catch (error) {
    input.context.abortCtrl?.signal.throwIfAborted();
    const content = `PLAN_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "failed",
    });
    appendPlanToolResult(input.messages, input.call.id, content);
    await input.ledger.recordSoftSignal(
      input.run,
      "repeated_action",
    );
  }
}
