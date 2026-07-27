import type { AgentMessage } from "../../lib/agentMessages";
import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import { TOOL_DEFINITIONS } from "../../lib/toolSchemas";
import { executeTool } from "../../lib/toolExecutor";
import { getToolTarget } from "../../lib/toolTarget";
import {
  deriveRuntimeV2SubagentConcurrency,
  scheduleReadOnlySubagents,
  type RuntimeV2EventDraft,
  type RuntimeV2SubagentJob,
  type SchedulerPort,
} from "../../lib/runtime-v2";
import {
  authorizationFor,
  boundedToolContent,
  childScopeAllows,
  nextEvidenceId,
  recordModelContext,
  type RuntimeV2ChildResult,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { aggregateForCurrentTurn } from "./executionAggregate";

const READ_ONLY_CHILD_TOOL_NAMES = new Set([
  "list_directory",
  "read_file",
  "grep_search",
  "get_file_outline",
  "code_ast_query",
  "find_symbol_references",
]);
const CHILD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((definition) =>
  READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name),
);
const RUNTIME_V2_CHILD_DEADLINE_MS = 90_000;

function boundedArgument(
  value: unknown,
  max: number,
): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function commaSeparatedPaths(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) =>
      entry.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
    )
    .filter((entry) =>
      !!entry &&
      !entry.startsWith("/") &&
      !/^[A-Za-z]:\//.test(entry) &&
      !entry.split("/").includes("..")
    )
    .slice(0, 6);
}

function modelSelectedCandidate(
  command: Parameters<
    NonNullable<SchedulerPort["prepareSchedule"]>
  >[0]["command"],
) {
  const args =
    command.payload.arguments &&
      typeof command.payload.arguments === "object" &&
      !Array.isArray(command.payload.arguments)
      ? command.payload.arguments as Record<string, unknown>
      : {};
  const taskKey = boundedArgument(args.task_key, 256);
  const name = boundedArgument(args.name, 128);
  const role = boundedArgument(args.role, 128);
  const objective = boundedArgument(args.objective, 2_000);
  const successCriteria = boundedArgument(args.success_criteria, 1_000);
  const accessMode = boundedArgument(args.access_mode, 32) || "read";
  const taskKind = boundedArgument(args.task_kind, 32) || "explore";
  if (
    !taskKey ||
    !name ||
    !role ||
    !objective ||
    !successCriteria
  ) {
    throw new Error(
      "spawn_subagent requires model-selected task_key, name, role, objective, and success_criteria.",
    );
  }
  if (accessMode !== "read" || taskKind === "implement") {
    throw new Error(
      "Runtime v2 collaboration currently accepts read-only explore, review, or validation investigations only.",
    );
  }
  const allowedPaths = commaSeparatedPaths(args.allowed_paths);
  return {
    sourceToolCallId: boundedArgument(command.payload.toolCallId, 256),
    scopeKey: taskKey,
    name,
    role,
    objective,
    successCriteria,
    expectedOutput: boundedArgument(args.expected_output, 1_000),
    allowedPaths: allowedPaths.length > 0 ? allowedPaths : ["."],
  };
}

async function runReadOnlyChild(input: {
  job: RuntimeV2SubagentJob;
  ports: RuntimeV2ExecutionPortsInput;
  signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const telemetry = input.ports.live.childTelemetry.get(input.job.id);
  const language = input.ports.context.phaseLanguage === "en" ? "English" : "简体中文";
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: [
        "You are a read-only child investigator in MAIN Runtime v2.",
        `Name: ${input.job.name || input.job.scopeKey}`,
        `Role: ${input.job.role || "read-only investigator"}`,
        `Scope key: ${input.job.scopeKey}`,
        `Allowed paths: ${input.job.allowedPaths.join(", ")}`,
        input.job.successCriteria
          ? `Success criteria: ${input.job.successCriteria}`
          : "",
        input.job.expectedOutput
          ? `Expected output: ${input.job.expectedOutput}`
          : "",
        "Use only provided read/search tools. Never write files, run shell commands, ask for approval, or address the end user.",
        `Return a concise evidence report in ${language}, with exact paths and uncertainty.`,
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: input.job.objective },
  ];
  try {
    let finalText = "";
    const observedTargets: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const result = await streamChatCompletion(
        messages,
        deriveStreamSettings(input.ports.get().config),
        {
          onToken: () => {
            if (telemetry && telemetry.firstTokenAt === null) telemetry.firstTokenAt = input.ports.now();
          },
          onDone: () => undefined,
          onError: () => undefined,
        },
        input.signal,
        CHILD_TOOL_DEFINITIONS,
        undefined,
        { toolChoice: "auto" },
      );
      finalText = sanitizeAssistantDisplayContent(result.content || "").trim();
      messages.push({
        role: "assistant",
        content: result.content || "",
        ...(result.toolCalls.length > 0
          ? {
              tool_calls: result.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
      if (result.toolCalls.length === 0) break;
      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        } catch {
          // The structured tool result below instructs the child to repair its
          // own argument shape without widening its scope.
        }
        const allowed = READ_ONLY_CHILD_TOOL_NAMES.has(call.name) && childScopeAllows(input.job, args);
        if (!allowed) {
          messages.push({ role: "tool", tool_call_id: call.id, content: "CHILD_SCOPE_BLOCKED: use an allowed read-only path." });
          continue;
        }
        try {
          const target = getToolTarget(call.name, args);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: boundedToolContent(await executeTool(
              call.name,
              args,
              input.ports.context.runWorkspace || "",
              input.ports.context.runSessionKey,
              { toolCatalog: authorizationFor(input.ports).toolCatalog },
            ), 8_000),
          });
          if (target) observedTargets.push(target);
        } catch (error) {
          messages.push({ role: "tool", tool_call_id: call.id, content: `CHILD_TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      // A tool-containing final round is not a report. Give the child one
      // bounded, tool-free chance to synthesize the evidence it just read.
      if (round === 3) {
        finalText = "子智能体达到只读调查轮次上限；已提交读取结果，未生成可确认摘要。";
      }
    }
    if (telemetry) telemetry.closedAt = input.ports.now();
    if (input.signal.aborted) {
      return {
        job: input.job,
        status: "canceled",
        summary: "子智能体已因父任务停止或超时而结束。",
        evidenceTarget: observedTargets[0] || null,
      };
    }
    return {
      job: input.job,
      status: "completed",
      summary: finalText.slice(0, 4_000) || "子智能体未返回可展示摘要，但已结束只读调查。",
      evidenceTarget: observedTargets[0] || null,
    };
  } catch (error) {
    if (telemetry) telemetry.closedAt = input.ports.now();
    return {
      job: input.job,
      status: input.signal.aborted ? "canceled" : "failed",
      summary: input.signal.aborted
        ? "子智能体已因父任务停止或超时而结束。"
        : `只读调查失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
      evidenceTarget: null,
    };
  }
}

function startReadOnlyChild(
  input: RuntimeV2ExecutionPortsInput,
  job: RuntimeV2SubagentJob,
  parentSignal: AbortSignal,
): Promise<RuntimeV2ChildResult> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  input.live.childAbortControllers.set(job.id, controller);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<RuntimeV2ChildResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(new Error("Runtime v2 child deadline exceeded."));
      const telemetry = input.live.childTelemetry.get(job.id);
      if (telemetry && telemetry.closedAt === null) telemetry.closedAt = input.now();
      resolve({
        job,
        status: "failed",
        summary: "子智能体超过 90 秒只读调查时限，已停止并保留此前可用结果。",
        evidenceTarget: null,
      });
    }, RUNTIME_V2_CHILD_DEADLINE_MS);
  });
  const run = runReadOnlyChild({ job, ports: input, signal: controller.signal });
  return Promise.race([run, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener("abort", abortFromParent);
    input.live.childAbortControllers.delete(job.id);
  });
}

export function createRuntimeV2SchedulerPort(
  input: RuntimeV2ExecutionPortsInput,
): SchedulerPort {
  return {
    async prepareSchedule({ command }) {
      if (command.kind !== "schedule_subagents") return null;
      const existingJobs =
        aggregateForCurrentTurn(input)?.subagents || [];
      const decision = scheduleReadOnlySubagents({
        parentRun: command.run,
        candidates: [modelSelectedCandidate(command)],
        existingJobs,
        requestedAt: input.now(),
        nextId: input.nextId,
      });
      if (decision.jobs.length !== 1) {
        throw new Error(
          `The model-selected child task could not be scheduled within the read-only capacity and path-isolation contract: ${decision.rejectedScopeKeys.join(", ") || "invalid scope"}.`,
        );
      }
      return {
        type: "subagents.scheduled",
        run: command.run,
        jobs: decision.jobs,
      };
    },
    async execute({ command, signal, scheduledSubagents }) {
      if (command.kind === "schedule_subagents") {
        const sourceToolCallId = boundedArgument(
          command.payload.toolCallId,
          256,
        );
        const jobs = (scheduledSubagents || []).filter((job) =>
          (job.status === "queued" || job.status === "running") &&
          (!sourceToolCallId || job.sourceToolCallId === sourceToolCallId)
        );
        if (jobs.length === 0) {
          throw new Error(
            "Runtime v2 scheduler could not resolve the child job committed for this spawn_subagent call.",
          );
        }
        const events: RuntimeV2EventDraft[] = [];
        input.logStoreEvent("runtime_v2_subagent_batch_starting", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          jobCount: jobs.length,
          scopes: jobs.map((job) => job.scopeKey),
          concurrent: (scheduledSubagents || []).filter((job) =>
            job.status === "queued" || job.status === "running"
          ).length > 1,
          resumed: jobs.some((job) => job.status === "running"),
        });
        for (const job of jobs) {
          if (!input.live.childRuns.has(job.id)) {
            input.live.childTelemetry.set(job.id, {
              firstTokenAt: job.firstTokenAt,
              closedAt: job.closedAt,
            });
            input.live.childRuns.set(job.id, startReadOnlyChild(input, job, signal));
          }
          if (job.status === "queued") {
            input.logStoreEvent("runtime_v2_subagent_request_opened", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobId: job.id,
              scopeKey: job.scopeKey,
              allowedPaths: job.allowedPaths,
            });
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: { jobId: job.id, phase: "request_opened", at: input.now() },
            });
          } else {
            input.logStoreEvent("runtime_v2_subagent_request_resumed", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobId: job.id,
              scopeKey: job.scopeKey,
            });
          }
        }
        return events;
      }
      if (command.kind === "join_subagents") {
        const jobIds = Array.isArray(command.payload.jobIds)
          ? command.payload.jobIds.map((value) => String(value || "")).filter(Boolean)
          : [];
        const requestedJobIds = Array.isArray(command.payload.requestedJobIds)
          ? command.payload.requestedJobIds
              .map((value) => String(value || "").trim())
              .filter(Boolean)
          : [];
        if (requestedJobIds.length > 0 && jobIds.length === 0) {
          throw new Error(
            `wait_subagents did not match an active child id: ${requestedJobIds.join(", ")}`,
          );
        }
        const results = await Promise.all(jobIds.map(async (jobId) => {
          const promise = input.live.childRuns.get(jobId);
          if (promise) return await promise;
          const job = (scheduledSubagents || []).find((candidate) => candidate.id === jobId);
          return job
            ? {
                job,
                status: "failed" as const,
                summary: "子智能体请求在进程重启后无法继续；已结束该只读子任务并保留父任务证据。",
                evidenceTarget: null,
              }
            : null;
        }));
        const events: RuntimeV2EventDraft[] = [];
        const observedJobs: RuntimeV2SubagentJob[] = [];
        for (const result of results) {
          if (!result) continue;
          const committedJob = (scheduledSubagents || []).find((job) => job.id === result.job.id);
          const telemetry = input.live.childTelemetry.get(result.job.id);
          if (committedJob?.status === "queued") {
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: { jobId: result.job.id, phase: "request_opened", at: input.now() },
            });
          }
          if (telemetry && telemetry.firstTokenAt !== null) {
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: { jobId: result.job.id, phase: "first_token", at: telemetry.firstTokenAt },
            });
          }
          events.push({
            type: "subagent.telemetry",
            run: command.run,
            telemetry: { jobId: result.job.id, phase: "closed", at: telemetry?.closedAt || input.now() },
          });
          events.push({
            type: "subagent.completed",
            run: command.run,
            jobId: result.job.id,
            status: result.status,
            summary: result.summary,
            evidence: result.status === "completed" && result.evidenceTarget
              ? [{ id: nextEvidenceId(input.live), kind: "subagent", target: result.evidenceTarget, version: null }]
              : [],
          });
          observedJobs.push({
            ...result.job,
            status: result.status,
            firstTokenAt: telemetry?.firstTokenAt || null,
            closedAt: telemetry?.closedAt || input.now(),
            summary: result.summary,
          });
          // This enters the parent model's evidence context and the structured
          // Subagents panel. Child prose never becomes Runtime-authored
          // ChatArea narration.
          recordModelContext(input.live, {
            id: `child:${result.job.id}`,
            source: "subagent",
            label: result.job.scopeKey,
            target: result.evidenceTarget || result.job.allowedPaths.join(", "),
            status: result.status === "completed" ? "succeeded" : "failed",
            content: [
              `Scope: ${result.job.scopeKey} (${result.job.allowedPaths.join(", ")})`,
              `Status: ${result.status}`,
              `Report: ${result.summary.slice(0, 4_000)}`,
            ].join("\n"),
          });
          input.logStoreEvent("runtime_v2_subagent_joined", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            jobId: result.job.id,
            status: result.status,
            firstTokenAt: telemetry?.firstTokenAt || null,
            closedAt: telemetry?.closedAt || null,
            evidenceTarget: result.evidenceTarget,
          });
        }
        const concurrency = deriveRuntimeV2SubagentConcurrency(observedJobs);
        input.logStoreEvent("runtime_v2_subagent_batch_joined", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          jobCount: observedJobs.length,
          peakInFlight: concurrency.peakInFlight,
          hasRequestOverlap: concurrency.hasRequestOverlap,
        });
        return events;
      }
      throw new Error(`Unsupported Runtime v2 scheduler command: ${command.kind}`);
    },
  };
}
