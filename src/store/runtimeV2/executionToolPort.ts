import { knowledgeSearchTraceFields } from "../../lib/knowledgeReferences";
import {
  runtimeV2ApprovalRequiredCapabilities, runtimeV2CapabilityRestrictions, runtimeV2KnowledgeMayFetch,
} from "./executionCapabilityRestrictions";
import { withRuntimeV2ModelReceipt, runtimeV2ToolModelContent } from "./readOnlyToolReceipt";
import { isReadOnlyContext, readOnlyNetworkPolicy } from "./readOnlyPolicy";
import { getToolTarget } from "../../lib/toolTarget";
import {
  ensureVersionedReadFileResultForModel,
  extractReadFileWindowMetadata,
} from "../../lib/readFileWindow";
import { executeTool, type ToolExecutionOptions } from "../../lib/toolExecutor";
import { runUnityEditorOperation } from "../../lib/ipc";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  isRuntimeV2LifecycleDeadlineError,
  type RuntimeV2ExecutionValidationAuthority,
  type ToolPort,
} from "../../lib/runtime-v2";
import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  RUNTIME_V2_VALIDATION_TOOL_NAMES,
  aggregateForCurrentTurn,
  authorizationFor,
  toolResultStatusForCompletion,
  nextEvidenceId,
  recordToolResultHistory,
  runtimeV2ContextBoundToolArguments,
  stringValue,
  toolCompletionFor,
  toolDefinitionExists,
  validateToolAgainstPhaseAndPlan,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { resolveRuntimeV2SourceEvidenceVersion } from "./sourceEvidenceVersion";
import {
  executeRuntimeV2ToolWithDeadline,
  logRuntimeV2ToolDeadline,
} from "./executionToolDeadline";
import { prepareRuntimeV2Mutation } from "./executionMutationPreflight";
import { collectRuntimeV2WorkspaceObservation } from "./executionObservation";
import {
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";
import { runtimeV2MutationFailureContextTarget } from "./correctiveMutationPolicy";
import { resolveRuntimeV2ToolAuthorization } from "./executionExternalLocalRead";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  parseRuntimeV2ExecutionContractArguments,
} from "./executionContract";
import { logRuntimeV2SkillLoad } from "./executionToolDefinitions";
import { boundUnityWorkspaceWriteVersions, recordRuntimeV2CommittedToolEffect } from "./executionEffectEvidence";
import { continuedPlanDriftReceipt, projectValidationManifestDriftReceipt, runtimeV2ToolPreExecutionReceipt, runtimeV2ToolAuthorizationRejectionReceipt, unityPlayModePreExecutionReceipt } from "./executionToolGateReceipt";
import { runtimeV2StructuredToolOutcome, unityValidationToolTimeoutMs } from "./executionToolOutcome";
import { runtimeV2BoundEditorObservation, runtimeV2CatalogToolSource, runtimeV2ToolCapabilityRestriction } from "./executionAuthorizationContext";
import { parseResultRecord } from "./executionEvidence";
import { executeUnityCompilation } from "./executionUnityCompilation";
import { UNITY_COMPILE_PROJECT_TOOL } from "../../lib/runtime-v2/unityCompilation";
import { isRuntimeV2EditorDiagnosticRepair, runtimeV2EditorConsoleEvidence } from "../../lib/runtime-v2/editorConsoleEvidence";
import { UNITY_MCP_CONSOLE_ARGS, UNITY_MCP_REPAIR_CONSOLE_ARGS } from "../../lib/workspaceMcp";

export function createRuntimeV2ToolPort(input: RuntimeV2ExecutionPortsInput): ToolPort {
  return withRuntimeV2ModelReceipt(input, {
    async execute({ command, signal }) {
      if (command.kind === "execute_tool" && command.payload.toolName === UNITY_COMPILE_PROJECT_TOOL &&
          command.payload.runtimeOwnedUnityCompile === true) {
        return executeUnityCompilation(input, command, signal);
      }
      const activity = (toolName: string, target: string) => ({
        run: command.run,
        commandKey: command.idempotencyKey,
        signal,
        toolName,
        target,
        validation: command.kind === "execute_validation",
      });
      if (command.kind === "collect_observation") {
        return collectRuntimeV2WorkspaceObservation(input, command, signal);
      }
      if (command.kind !== "execute_tool" && command.kind !== "execute_validation") {
        throw new Error(`Unsupported Runtime v2 tool command: ${command.kind}`);
      }
      const toolName = stringValue(command.payload.toolName, 256);
      const args = command.payload.arguments && typeof command.payload.arguments === "object" && !Array.isArray(command.payload.arguments)
        ? command.payload.arguments as Record<string, unknown>
        : {};
      const target = getToolTarget(toolName, args);
      const toolCallId = String(command.payload.toolCallId || "");
      const parallelReadCount = input.live.parallelReadCountByToolCallId.get(toolCallId) || 1;
      input.live.parallelReadCountByToolCallId.delete(toolCallId);
      // Keep authorization bound to the provider's actual arguments. For
      // recovery correlation only, attribute a target-less failed editor to
      // the active mutation lease. Otherwise an empty native tool payload is
      // recorded against the literal tool name and the same broken editor
      // remains eligible forever on the leased source version.
      const failureContextTarget =
        runtimeV2MutationFailureContextTarget({
          ports: input,
          toolCallId,
          toolName,
          requestedTarget: target,
        });
      const blockedReceipt = runtimeV2ToolPreExecutionReceipt({ ports: input, command, toolName, args, target });
      if (blockedReceipt) return blockedReceipt;
      const hasCoveredSourceReceipt =
        !!toolCallId &&
        input.live.coveredReadToolResults.has(toolCallId);
      const cachedSourceReceipt = hasCoveredSourceReceipt
        ? input.live.coveredReadToolResults.get(toolCallId) || null
        : null;
      if (hasCoveredSourceReceipt) {
        input.live.coveredReadToolResults.delete(toolCallId);
      }
      if (!toolDefinitionExists(input, toolName)) {
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: `UNKNOWN_TOOL: ${toolName}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: "unknown_tool",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          `UNKNOWN_TOOL: ${toolName}`,
          "failed",
          "protocol_invalid",
        );
      }
      if (command.kind === "execute_validation" && !RUNTIME_V2_VALIDATION_TOOL_NAMES.has(toolName)) {
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: `VALIDATION_TOOL_REJECTED: ${toolName}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: "validation_tool_required",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          `VALIDATION_TOOL_REJECTED: ${toolName}`,
          "failed",
          "protocol_invalid",
        );
      }
      const phaseAndPlanRejection = (rejection: ReturnType<typeof validateToolAgainstPhaseAndPlan>) =>
        runtimeV2ToolAuthorizationRejectionReceipt({ ports: input, command, toolName, args, target, failureContextTarget, rejection });
      const phaseAndPlan = validateToolAgainstPhaseAndPlan({ ports: input, command, toolName, args, target });
      if (!phaseAndPlan.allowed) return phaseAndPlanRejection(phaseAndPlan);
      const unityBlocked = unityPlayModePreExecutionReceipt({ ports: input, command, toolName, args, target });
      if (unityBlocked) return unityBlocked;
      const authorizationResolution =
        await resolveRuntimeV2ToolAuthorization({
          ports: input,
          command,
          toolName,
          args,
          target,
          failureContextTarget,
          signal,
        });
      if (!authorizationResolution.allowed) {
        return authorizationResolution.completion;
      }
      const authorization = authorizationResolution.authorization;
      if (cachedSourceReceipt) {
        const replayedActionIdentity =
          runtimeV2ProviderToolCallIdentity({
            name: toolName,
            arguments: args,
          });
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target,
          status: "succeeded",
          content: cachedSourceReceipt,
        });
        input.logStoreEvent("runtime_v2_source_receipt_replayed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          toolName,
          target: target || null,
          sourceVersion:
            extractReadFileWindowMetadata(cachedSourceReceipt)
              ?.contentVersion || null,
          actionIdentity: replayedActionIdentity,
        });
        const replayCompletion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          cachedSourceReceipt,
          "succeeded",
          undefined,
          extractReadFileWindowMetadata(cachedSourceReceipt)
            ?.contentVersion,
        );
        return replayCompletion.type === "tool.completed"
          ? {
              ...replayCompletion,
              evidence: [],
              receiptOrigin: "replayed",
            }
          : replayCompletion;
      }
      try {
        let diffPreview;
        const toolExecutionOptions: ToolExecutionOptions = {
          networkRead: readOnlyNetworkPolicy(input),
          toolCatalog: authorizationFor(input).toolCatalog,
          ...(toolName === "tool_search" ? { availableToolNames: new Set(
            Object.values(authorizationFor(input).capabilityRegistry.tools)
              .filter(tool => tool.enabled && !runtimeV2ToolCapabilityRestriction(input, tool.name) &&
                (!isReadOnlyContext(input) || !["workspace_write", "external_write", "shell", "desktop_control", "browser_control", "destructive"].includes(tool.risk)))
              .map(tool => tool.name),
          ) } : {}),
          workspaceMcpSnapshot: input.context.workspaceMcpSnapshot,
          ...(toolName === "unity_mcp_console" && isRuntimeV2EditorDiagnosticRepair(aggregateForCurrentTurn(input)) ? { unityConsoleRepairScope: true } : {}),
          skillCatalog: input.context.skillCatalog,
          knowledgeReferences: input.context.knowledgeContext?.references || [],
          ...(toolName === "knowledge_search" ? {
            knowledgeLookup: {
              allowOfficialDocuments: runtimeV2KnowledgeMayFetch(
                runtimeV2CapabilityRestrictions(input),
                runtimeV2ApprovalRequiredCapabilities(input),
              ),
              signal,
            },
          } : {}),
          allowExternalLocalRead: authorization.allowExternalLocalRead,
          ...(toolName === "unity_create_scene" ? { unitySceneAuthority: { signal, lifecycleDeadlineAt: input.lifecycleDeadlineAt } } : {}),
          ...(authorization.shellPermissionApproval
            ? { shellPermissionApproval: authorization.shellPermissionApproval }
            : {}),
        };
        if (isWorkspaceMutationToolName(toolName)) {
          const preparation = await prepareRuntimeV2Mutation({
            ports: input,
            command,
            toolName,
            args,
            target,
            failureContextTarget,
            toolExecutionOptions,
          });
          if (!preparation.allowed) return preparation.completion;
          if (preparation.writeFileTarget) {
            const actualOperationAuthorization = validateToolAgainstPhaseAndPlan({
              ports: input, command, toolName, args, target,
              writeFileTarget: preparation.writeFileTarget,
            });
            if (!actualOperationAuthorization.allowed) return phaseAndPlanRejection(actualOperationAuthorization);
            toolExecutionOptions.writeFileTarget = preparation.writeFileTarget;
          }
          diffPreview = preparation.diffPreview;
        }
        const drift = await continuedPlanDriftReceipt({ ports: input, command, toolName, args, target, signal });
        if (drift) return drift;
        if (command.payload.projectValidationManifestVersion) {
          const manifestDrift = await projectValidationManifestDriftReceipt({ ports: input, command, toolName, args, target, signal });
          if (manifestDrift) return manifestDrift;
        }
        const unityTimeout = unityValidationToolTimeoutMs(toolName, args);
        const managedEditorTest = command.kind === "execute_validation" &&
          (command.payload.validationAuthority as RuntimeV2ExecutionValidationAuthority | undefined)?.useProjectEditor === true;
        const executionArgs = runtimeV2ContextBoundToolArguments(
          toolName,
          unityTimeout ? { ...args, timeout_ms: unityTimeout } : args,
          input.context.runtimeContextBudget,
          { parallelReadCount },
        );
        const priorExecutionContract =
          toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
            ? deriveRuntimeV2ExecutionContract(
                aggregateForCurrentTurn(input),
              )
            : null;
        const ioStartedAt = input.now();
        let verifiedMcpWriteVersions: readonly { target: string; version: string }[] = [];
        const rawOutput =
          toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
            ? JSON.stringify({
                status: "execution_contract_recorded",
                revision: (priorExecutionContract?.revision || 0) + 1,
                ...parseRuntimeV2ExecutionContractArguments(executionArgs),
                effect: "no_workspace_change",
                next:
                  "Advance only a listed exact change or validation; revise explicitly if new evidence changes scope.",
              })
            : await executeRuntimeV2ToolWithDeadline({
                toolName,
                toolTimeoutMs: unityTimeout ? unityTimeout + 3_000 : undefined,
                activity: activity(toolName, target),
                lifecycleDeadlineAt: input.lifecycleDeadlineAt,
                now: input.now,
                onTimeout: (timeoutMs, boundary) =>
                  logRuntimeV2ToolDeadline({
                    ports: input,
                    command,
                    toolName,
                    target: target || null,
                    timeoutMs,
                    boundary,
                  }),
                task: async () => {
                  if (managedEditorTest) return runUnityEditorOperation("unity_test_project", {
                    workspace: input.context.runWorkspace || "",
                    approvedCommand: String(executionArgs.command || ""),
                    permissionApproval: authorization.shellPermissionApproval,
                  }, signal, Math.min(Date.now() + 300_000, input.lifecycleDeadlineAt ?? Infinity));
                  const verifyWrite = await boundUnityWorkspaceWriteVersions(input, toolName, executionArgs, target);
                  signal.throwIfAborted();
                  const result = await executeTool(toolName, executionArgs, input.context.runWorkspace || "", input.context.runSessionKey, toolExecutionOptions);
                  if (verifyWrite && parseResultRecord(result)?.success === true) verifiedMcpWriteVersions = await verifyWrite();
                  return result;
                },
              });
        if (toolName === "knowledge_search") {
          const trace = knowledgeSearchTraceFields(rawOutput);
          if (trace) input.logStoreEvent("runtime_v2_knowledge_retrieved", {
            sessionKey: command.run.sessionKey, turnId: command.run.turnId, runId: command.run.runId,
            commandKey: command.idempotencyKey, ...trace,
          });
        }
        const sourceVersion = RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(toolName)
          ? await resolveRuntimeV2SourceEvidenceVersion({
              toolName,
              args,
              output: rawOutput,
              readExactFile: () => executeRuntimeV2ToolWithDeadline({
                toolName: "read_file",
                activity: activity("read_file", target),
                lifecycleDeadlineAt: input.lifecycleDeadlineAt,
                now: input.now,
                onTimeout: (timeoutMs, boundary) =>
                  logRuntimeV2ToolDeadline({
                    ports: input,
                    command,
                    toolName: "read_file",
                    target: target || null,
                    timeoutMs,
                    boundary,
                  }),
                task: () => executeTool(
                  "read_file",
                  { ...args, __raw: true },
                  input.context.runWorkspace || "",
                  input.context.runSessionKey,
                  toolExecutionOptions,
                ),
              }),
            })
          : undefined;
        const receiptOutput = toolName === "read_file"
          ? ensureVersionedReadFileResultForModel(
              String(args.path || target || ""),
              rawOutput,
              sourceVersion || "",
            )
          : rawOutput;
        const editorObservation = runtimeV2BoundEditorObservation(input, toolName, args);
        const mcp = runtimeV2CatalogToolSource(authorizationFor(input), toolName) === "mcp" || !!editorObservation;
        const mcpResult = mcp ? parseResultRecord(rawOutput) : null;
        const outcome = mcp && (mcpResult?.success === false || !String(rawOutput || "").trim() || String(rawOutput).trim() === "{}")
          ? { status: "failed" as const, failureKind: "execution_failed" as const, failureReasonCode: "mcp_result_unverified" }
          : runtimeV2StructuredToolOutcome(toolName, rawOutput, args, command.payload.validationAuthority);
        const content = runtimeV2ToolModelContent(input, toolName, receiptOutput, { parallelReadCount });
        const output = outcome.failureReasonCode === "unity_validation_verdict_unverified"
          ? `The project Editor did not return a verified compilation or test result.\n${content}` : content;
        let completion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          outcome.failureReasonCode === "unity_validation_verdict_unverified" ? output : receiptOutput,
          outcome.status,
          outcome.failureKind,
          sourceVersion,
          diffPreview,
          outcome.failureReasonCode,
        );
        if (completion.type === "tool.completed" && completion.status === "succeeded" && verifiedMcpWriteVersions.length > 0) {
          completion = { ...completion, effectKind: "workspace_change", evidence: verifiedMcpWriteVersions.map(item => ({
            id: nextEvidenceId(input.live), kind: "mutation", ...item,
          })) };
        }
        if (completion.type === "tool.completed" && completion.status === "succeeded" && editorObservation?.kind === "console") {
          const editorConsole = runtimeV2EditorConsoleEvidence({ workspace: input.context.runWorkspace || "",
            binding: editorObservation.binding, args: toolName === "unity_mcp_console"
              ? toolExecutionOptions.unityConsoleRepairScope ? UNITY_MCP_REPAIR_CONSOLE_ARGS : UNITY_MCP_CONSOLE_ARGS : args, result: mcpResult });
          if (editorConsole) completion = { ...completion, editorConsole };
        }
        if (completion.type === "tool.completed" && completion.effectKind === "workspace_change" &&
            completion.status === "succeeded" && toolExecutionOptions.writeFileTarget) {
          completion = {
            ...completion,
            mutationRequests: [{
              target: toolExecutionOptions.writeFileTarget.path,
              operation: toolExecutionOptions.writeFileTarget.exists ? "modify" : "create",
            }],
          };
        }
        const semanticStatus = toolResultStatusForCompletion(completion);
        const effectKind = completion.type === "tool.completed" ? completion.effectKind : undefined;
        const effectCommitted = recordRuntimeV2CommittedToolEffect({
          ports: input,
          effectKind,
          status: semanticStatus,
        });
        if (completion.type === "validation.completed") {
          input.live.correctiveValidationCommand = null;
        }
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target,
          status: semanticStatus,
          content: output,
        });
        input.logStoreEvent("runtime_v2_tool_execution_completed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          commandKey: command.idempotencyKey,
          sessionKey: command.run.sessionKey,
          target: toolName === "knowledge_search" || toolName === "run_command" ? null : target || null,
          status: semanticStatus,
          ioElapsedMs: input.now() - ioStartedAt,
          effectKind: effectKind ?? null,
          editorDiagnosticCount: completion.type === "tool.completed" ? completion.editorConsole?.diagnostics.length ?? null : null,
          mutationCommitted: effectCommitted && effectKind === "workspace_change",
          effectCommitted,
          validationPassed: completion.type === "validation.completed" ? completion.passed : null,
          executionContractRevision:
            toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
              ? (priorExecutionContract?.revision || 0) + 1
              : null,
          evidenceVersions: completion.type === "tool.completed"
            ? completion.evidence.map((entry) => ({
                kind: entry.kind,
                target: entry.target,
                version: entry.version,
              }))
            : [],
        });
        logRuntimeV2SkillLoad({
          toolName,
          succeeded: semanticStatus === "succeeded",
          rawOutput,
          skillId: String(args.skill_id || ""),
          turnId: command.run.turnId,
          runId: command.run.runId,
          sessionKey: command.run.sessionKey, commandKey: command.idempotencyKey,
          logStoreEvent: input.logStoreEvent,
        });
        return completion;
      } catch (error) {
        if (isRuntimeV2LifecycleDeadlineError(error)) throw error;
        const failureContent =
          `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`;
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: failureContent,
        });
        input.logStoreEvent("runtime_v2_tool_execution_failed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          commandKey: command.idempotencyKey,
          sessionKey: command.run.sessionKey,
          target: /^(?:run_command|knowledge_search|web_search|web_fetch)$/.test(toolName) ? null : target || null,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          failureContent,
          "failed",
          "execution_failed",
        );
      }
    },
  });
}
