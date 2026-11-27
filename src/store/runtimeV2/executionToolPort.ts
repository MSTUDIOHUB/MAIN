import { compactDebugString } from "../../lib/debugLog";
import { classifyWorkspaceReadFailure, describeWorkspaceToolFailure } from "../../lib/workspaceToolFailure";
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
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  isRuntimeV2LifecycleDeadlineError,
  RESOLVE_RUNTIME_V2_REVIEW_FINDING_TOOL_NAME,
  type RuntimeV2ExecutionValidationAuthority,
  type ToolPort,
} from "../../lib/runtime-v2";
import { executeResolveReviewFindingReceiptJson } from "./executionPlanAuthorization";
import { ENABLE_UNITY_OFFICIAL_MCP_TOOL, RUNTIME_V2_SOURCE_READ_TOOL_NAMES, UNITY_CLI_CONSOLE_TOOL, UNITY_GAME_VIEW_TOOL, UNITY_MCP_CONSOLE_TOOL, UNITY_OFFICIAL_MCP_CONSOLE_TOOL } from "../../lib/runtime-v2/workspaceReadPolicy";
import { enableRuntimeV2UnityOfficialMcp, recoverRuntimeV2UnityConsole, runtimeV2WorkspaceMcpSnapshot } from "./executionUnityOfficialMcp";
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
import { MUTATION_SOURCE_CHANGED_REASON, runtimeV2MutationSourceRefreshInstruction } from "./executionMutationRejection";
import { WorkspaceMutationSourceMismatch } from "../../lib/workspaceMutationPreflight";
import { resolveRuntimeV2ToolAuthorization } from "./executionExternalLocalRead";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  parseRuntimeV2ExecutionContractArguments,
} from "./executionContract";
import { logRuntimeV2SkillLoad } from "./executionToolDefinitions";
import { boundUnityWorkspaceWriteVersions, observeRuntimeV2CreatedPathRemovals, recordRuntimeV2CommittedToolEffect } from "./executionEffectEvidence";
import { continuedPlanDriftReceipt, projectValidationManifestDriftReceipt, runtimeV2ToolPreExecutionReceipt, runtimeV2ToolAuthorizationRejectionReceipt, unityPlayModePreExecutionReceipt } from "./executionToolGateReceipt";
import { runtimeV2StructuredToolOutcome, unityValidationToolTimeoutMs } from "./executionToolOutcome";
import { runtimeV2BoundEditorObservation, runtimeV2CatalogToolSource, runtimeV2ToolVisibleToProvider } from "./executionAuthorizationContext";
import { parseResultRecord } from "./executionEvidence";
import { executeRuntimeV2UnityTool } from "./executionUnityRepair";
import { boundRuntimeV2UnityPlayMode, executeManagedUnityPlayMode, rejectedUnityPlayModeBinding, unityPlayModeConsoleFailure, unityPlayModePrerequisiteUnavailable } from "./executionUnityPlayMode";
import { isRuntimeV2EditorDiagnosticRepair, runtimeV2EditorConsoleDebugSummary, runtimeV2EditorConsoleEvidence, type RuntimeV2PipelineConsoleSample } from "../../lib/runtime-v2/editorConsoleEvidence";
import { UNITY_MCP_CONSOLE_ARGS, UNITY_MCP_REPAIR_CONSOLE_ARGS } from "../../lib/workspaceMcp";
import { runtimeV2CollaborationDiscoveryToolNames } from "./executionProviderTools";
import { captureRuntimeV2UnityGameView } from "./executionUnityGameView";

export function createRuntimeV2ToolPort(input: RuntimeV2ExecutionPortsInput): ToolPort {
  return withRuntimeV2ModelReceipt(input, {
    async execute({ command, signal }) {
      signal.throwIfAborted();
      const editorCheck = executeRuntimeV2UnityTool(input, command, signal);
      if (editorCheck) return editorCheck;
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
      // Attribute a target-less failed edit to its lease for recovery without changing the authorized arguments.
      const failureContextTarget = runtimeV2MutationFailureContextTarget({
        ports: input, toolCallId, toolName, requestedTarget: target,
      });
      const playMode = boundRuntimeV2UnityPlayMode(input, command);
      const blockedReceipt = runtimeV2ToolPreExecutionReceipt({ ports: input, command, toolName, args, target }) ??
        rejectedUnityPlayModeBinding(input, command, args, target, playMode);
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
        const discoverableCollaboration = toolName === "tool_search" ? runtimeV2CollaborationDiscoveryToolNames(input, command.run.runId) : undefined;
        const toolExecutionOptions: ToolExecutionOptions = {
          networkRead: readOnlyNetworkPolicy(input),
          toolCatalog: authorizationFor(input).toolCatalog,
          ...(toolName === "tool_search" ? { availableToolNames: new Set(
            Object.values(authorizationFor(input).capabilityRegistry.tools)
              .filter(tool => tool.enabled && runtimeV2ToolVisibleToProvider(input, tool.name) &&
                (tool.name !== "spawn_subagent" && tool.name !== "wait_subagents" || discoverableCollaboration?.has(tool.name)) &&
                (!isReadOnlyContext(input) || !["workspace_write", "external_write", "shell", "desktop_control", "browser_control", "destructive"].includes(tool.risk)))
              .map(tool => tool.name),
          ) } : {}),
          workspaceMcpSnapshot: runtimeV2WorkspaceMcpSnapshot(input),
          ...(toolName === UNITY_MCP_CONSOLE_TOOL && isRuntimeV2EditorDiagnosticRepair(aggregateForCurrentTurn(input)) ? { unityConsoleRepairScope: true } : {}),
          unityConsoleSignal: signal,
          isUnityOfficialMcpEnabled: () => input.get().config.unityOfficialMcpEnabled === true,
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
        const approval = command.payload.validationAuthority as RuntimeV2ExecutionValidationAuthority | undefined;
        const managedEditorTest = command.kind === "execute_validation" && approval?.useProjectEditor === true;
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
        let verifiedMcpWriteVersions: readonly { target: string; version: string; previousVersion: string }[] = [];
        let postPlayModeConsole: RuntimeV2PipelineConsoleSample | undefined;
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
            : toolName === RESOLVE_RUNTIME_V2_REVIEW_FINDING_TOOL_NAME
              ? executeResolveReviewFindingReceiptJson(aggregateForCurrentTurn(input), executionArgs)
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
                  if (toolName === UNITY_GAME_VIEW_TOOL && runtimeV2CatalogToolSource(authorizationFor(input), toolName) === "built_in")
                    return captureRuntimeV2UnityGameView(input, command, executionArgs, signal);
                  if (toolName === ENABLE_UNITY_OFFICIAL_MCP_TOOL)
                    return enableRuntimeV2UnityOfficialMcp(input, executionArgs, signal);
                  if (managedEditorTest) {
                    const checked = await executeManagedUnityPlayMode(input, command, executionArgs, authorization.shellPermissionApproval, signal, playMode);
                    postPlayModeConsole = checked.console;
                    return checked.result;
                  }
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
        const connectorTool = runtimeV2CatalogToolSource(authorizationFor(input), toolName) === "mcp" || !!editorObservation;
        const connectorResult = connectorTool ? parseResultRecord(rawOutput) : null;
        const unityConsoleSnapshot = toolName === UNITY_CLI_CONSOLE_TOOL || toolName === UNITY_OFFICIAL_MCP_CONSOLE_TOOL;
        const unverified = unityConsoleSnapshot ? connectorResult?.success !== true
          : connectorTool && (connectorResult?.success === false || !String(rawOutput || "").trim() || String(rawOutput).trim() === "{}");
        const toolOutcome = unverified
          ? { status: "failed" as const, failureKind: "execution_failed" as const,
              failureReasonCode: unityConsoleSnapshot ? "unity_console_result_unverified" : "mcp_result_unverified" }
          : runtimeV2StructuredToolOutcome(toolName, rawOutput, args, command.payload.validationAuthority);
        const consoleVerification = playMode && toolOutcome.status === "succeeded" ? unityPlayModeConsoleFailure(postPlayModeConsole) : undefined;
        const outcome = consoleVerification ? { status: "failed" as const, failureKind: consoleVerification.kind,
          failureReasonCode: consoleVerification.reason } : toolOutcome;
        const consoleFallback = unverified && unityConsoleSnapshot
          ? await recoverRuntimeV2UnityConsole(input, toolName, String(connectorResult?.message || ""), signal) : undefined;
        if (unverified && unityConsoleSnapshot) signal.throwIfAborted();
        const consoleReceipt = consoleFallback ? `${receiptOutput}\nThe Editor Console is available through ${consoleFallback}.` : receiptOutput;
        const content = runtimeV2ToolModelContent(input, toolName, consoleReceipt, { parallelReadCount });
        const output = consoleVerification?.message ?? (outcome.failureReasonCode === "unity_validation_verdict_unverified"
          ? `The project Editor did not return a verified compilation or test result.\n${content}` : content);
        let completion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          consoleVerification || outcome.failureReasonCode === "unity_validation_verdict_unverified" ? output : consoleReceipt,
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
        if (toolName === "run_command" && completion.type === "tool.completed" && completion.status === "succeeded") {
          const observedWorkspaceRemovals = await observeRuntimeV2CreatedPathRemovals(input);
          if (observedWorkspaceRemovals.length) completion = { ...completion, observedWorkspaceRemovals };
        }
        if (completion.type === "tool.completed" && completion.status === "succeeded" && editorObservation?.kind === "console") {
          const editorConsole = runtimeV2EditorConsoleEvidence({ workspace: input.context.runWorkspace || "",
            binding: editorObservation.binding, args: toolName === UNITY_MCP_CONSOLE_TOOL
              ? toolExecutionOptions.unityConsoleRepairScope ? UNITY_MCP_REPAIR_CONSOLE_ARGS : UNITY_MCP_CONSOLE_ARGS : args, result: connectorResult });
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
          if (postPlayModeConsole) completion = { ...completion, postPlayModeConsole };
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
          ...runtimeV2EditorConsoleDebugSummary(completion.type === "tool.completed" ? completion.editorConsole : undefined),
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
        signal.throwIfAborted();
        if (isRuntimeV2LifecycleDeadlineError(error)) throw error;
        const rawErr = error instanceof Error ? error.message : String(error);
        const consoleFallback = (toolName === UNITY_OFFICIAL_MCP_CONSOLE_TOOL || toolName === UNITY_CLI_CONSOLE_TOOL) && !Object.keys(args).length
          ? await recoverRuntimeV2UnityConsole(input, toolName, rawErr, signal) : undefined;
        signal.throwIfAborted();
        const sourceMismatch = error instanceof WorkspaceMutationSourceMismatch ? error : null;
        const isReadTool = RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(toolName) || /^(?:list_directory|glob_search|grep_search|get_file_outline|get_project_skeleton)$/.test(toolName);
        const classified = isReadTool ? classifyWorkspaceReadFailure(rawErr) : undefined;
        const described = classified ? describeWorkspaceToolFailure(classified.code, input.context.phaseLanguage) : undefined;
        const failureTarget = sourceMismatch?.target || failureContextTarget;
        const playModeUnavailable = playMode && unityPlayModePrerequisiteUnavailable(rawErr);
        const failureReasonCode = playModeUnavailable ? "unity_playmode_prerequisite_unavailable"
          : sourceMismatch ? MUTATION_SOURCE_CHANGED_REASON : classified?.code;
        const failureContent = sourceMismatch
          ? `MUTATION_SOURCE_CHANGED: ${rawErr} The edit was rejected before writing.\n${runtimeV2MutationSourceRefreshInstruction(sourceMismatch)}`
          : classified ? `TOOL_ERROR: [code=${classified.code}] ${rawErr}${described?.modelHint ? ` (${described.modelHint})` : ""}`
            : `TOOL_ERROR: ${rawErr}${consoleFallback ? `\nThe Editor Console is available through ${consoleFallback}.` : ""}`;
        recordToolResultHistory({ ports: input, command, toolName, target: failureTarget, status: "failed", content: failureContent });
        input.logStoreEvent("runtime_v2_tool_execution_failed", {
          turnId: command.run.turnId, runId: command.run.runId, commandKind: command.kind, toolName, commandKey: command.idempotencyKey,
          sessionKey: command.run.sessionKey, target: /^(?:run_command|knowledge_search|web_search|web_fetch)$/.test(toolName) ? null : target || null,
          errorType: error instanceof Error ? error.name : typeof error, errorMessage: compactDebugString(rawErr, 320), ...(failureReasonCode ? { failureReasonCode } : {}),
        });
        return toolCompletionFor(
          input, command, toolName, args, failureTarget, failureContent,
          "failed", playModeUnavailable ? "not_executed" : sourceMismatch ? "source_mismatch" : classified?.failureKind || "execution_failed", undefined, undefined, failureReasonCode,
        );
      }
    },
  });
}
