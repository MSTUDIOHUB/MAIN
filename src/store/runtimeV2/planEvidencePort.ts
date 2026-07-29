import type { AgentMessage } from "../../lib/agentMessages";
import { getToolTarget } from "../../lib/toolTarget";
import { executeTool } from "../../lib/toolExecutor";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
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
  boundedPlanContent,
  compactRetainedPlanObservation,
} from "./planModelProtocol";
import { runtimeV2ContextBoundToolArguments } from "./executionText";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { resolveRuntimeV2SourceEvidenceVersion } from "./sourceEvidenceVersion";

export type RuntimeV2PlanLog = (
  event: string,
  data?: Record<string, unknown>,
) => void;

export async function settlePlanTool(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly status: "succeeded" | "failed" | "blocked";
  readonly evidence?: readonly RuntimeV2EvidenceReference[];
}): Promise<void> {
  const command = await input.ledger.schedule(input.run, "execute_tool", {
    toolCallId: input.call.id,
    toolName: input.call.name,
    arguments: input.call.arguments,
    ...(input.call.name === "submit_runtime_v2_work_plan"
      ? { runtimeControlPlane: true }
      : {}),
  });
  await input.ledger.settleCommand({
    type: "tool.completed",
    run: input.run,
    idempotencyKey: command.idempotencyKey,
    status: input.status,
    evidence: input.evidence || [],
  });
}

export async function executeReadOnlyPlanTool(input: {
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: RuntimeV2NormalizedProviderResult["toolCalls"][number];
  readonly messages: AgentMessage[];
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly logStoreEvent: RuntimeV2PlanLog;
}): Promise<void> {
  const args = input.call.arguments;
  if (!PLAN_READ_ONLY_TOOL_NAMES.has(input.call.name)) {
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "blocked",
    });
    input.messages.push({
      role: "tool",
      tool_call_id: input.call.id,
      content: "PLAN_TOOL_BLOCKED: use a read-only tool or submit_runtime_v2_work_plan.",
    });
    await input.ledger.recordSoftSignal(
      input.run,
      "protocol_drift",
    );
    return;
  }
  try {
    const output = await executeTool(
      input.call.name,
      runtimeV2ContextBoundToolArguments(
        input.call.name,
        args,
        input.context.runtimeContextBudget,
      ),
      input.context.runWorkspace || "",
      input.context.runSessionKey,
    );
    const target = getToolTarget(input.call.name, args) || input.call.name;
    const content = boundedPlanContent(output);
    const version = await resolveRuntimeV2SourceEvidenceVersion({
      toolName: input.call.name,
      args,
      output,
      readExactFile: () => executeTool(
        "read_file",
        { ...args, __raw: true },
        input.context.runWorkspace || "",
        input.context.runSessionKey,
      ),
    });
    const existingEvidence = input.evidence.find((entry) =>
      workspacePathsReferToSameFile(entry.target, target) &&
      entry.version === version
    );
    const evidenceEntry = existingEvidence || {
      id: `E${input.evidence.length + 1}`,
      target,
      version,
      statement: `${input.call.name} 已确认 ${target} 的当前内容。`,
    };
    const previousContent = existingEvidence
      ? input.evidenceContents.get(existingEvidence.id) || ""
      : "";
    const repeatedObservation = !!existingEvidence && (
      previousContent === content ||
      previousContent.includes(content)
    );
    if (!existingEvidence) {
      input.evidence.push(evidenceEntry);
      input.evidenceContents.set(evidenceEntry.id, content);
    } else if (!repeatedObservation) {
      input.evidenceContents.set(
        evidenceEntry.id,
        compactRetainedPlanObservation(
          [
            previousContent,
            `[Additional read window for ${target}]`,
            content,
          ].filter(Boolean).join("\n\n"),
          PLAN_CONTEXT_RESULT_CHARS * 2,
        ),
      );
    }
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "succeeded",
      evidence: [{
        id: evidenceEntry.id,
        kind: "source",
        target,
        version,
      }],
    });
    input.messages.push({
      role: "tool",
      tool_call_id: input.call.id,
      content: existingEvidence && repeatedObservation
        ? `[${evidenceEntry.id}] ${target}\nRuntime v2 reused this unchanged source and observation.`
        : `[${evidenceEntry.id}] ${target}\n${content}`,
    });
    input.logStoreEvent(!existingEvidence
      ? "runtime_v2_plan_read_completed"
      : repeatedObservation
      ? "runtime_v2_plan_read_reused"
      : "runtime_v2_plan_read_extended", {
      turnId: input.run.turnId,
      runId: input.run.runId,
      toolName: input.call.name,
      target,
      evidenceId: evidenceEntry.id,
      sourceVersion: version,
      observationVersion: await resolveRuntimeV2SourceEvidenceVersion({
        toolName: input.call.name,
        args: { ...args, __raw: true },
        output,
      }),
      retainedChars: input.evidenceContents.get(evidenceEntry.id)?.length || 0,
    });
    return;
  } catch (error) {
    await settlePlanTool({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      status: "failed",
    });
    input.messages.push({
      role: "tool",
      tool_call_id: input.call.id,
      content: `PLAN_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    });
    await input.ledger.recordSoftSignal(
      input.run,
      "repeated_action",
    );
  }
}
