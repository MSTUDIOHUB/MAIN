import type { ToolDefinition } from "../../toolSchemas";
import {
  UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES,
  extractMcpCallFailureCategory,
  shouldRepromptBeforeUnityConsoleFallback,
  shouldTriggerUnityMcpFirstIterationFallback,
  shouldTriggerUnityMcpStrictRetry,
} from "../../orchestrator/unityDiagnostics";
import {
  logAgentEvent,
} from "../../orchestrator";
import type { OrchestratorCallbacks, ToolExecutionResult } from "../types";
import { hasCompletedToolExecution } from "../../toolResultEffect";

export const UNITY_MCP_STRICT_RETRY_FORCED_TOOLS = ["read_console", "set_active_instance"] as const;

export type UnityMcpRuntimeState = {
  firstPhaseActive: boolean;
  fallbackReason: string | null;
  firstIterationPending: boolean;
  forceConsoleFirstPending: boolean;
  strictRetryPending: boolean;
  strictRetryIssued: boolean;
  consoleMissingFirstToolRepromptIssued: boolean;
  consoleFinalVerificationRequired: boolean;
  consoleRefreshObservedAfterWrite: boolean;
};

export function createUnityMcpRuntimeState(input: {
  unityMcpFirstEligible: boolean;
  unityMcpToolCount: number;
  unityConsoleDiagnosticsRequested: boolean;
}): UnityMcpRuntimeState {
  const firstPhaseActive = input.unityMcpFirstEligible && input.unityMcpToolCount > 0;
  return {
    firstPhaseActive,
    fallbackReason: null,
    firstIterationPending: firstPhaseActive,
    forceConsoleFirstPending: firstPhaseActive && input.unityConsoleDiagnosticsRequested,
    strictRetryPending: false,
    strictRetryIssued: false,
    consoleMissingFirstToolRepromptIssued: false,
    consoleFinalVerificationRequired: false,
    consoleRefreshObservedAfterWrite: false,
  };
}

export function activateUnityMcpFallbackState(
  state: UnityMcpRuntimeState,
  reason: string,
): {
  state: UnityMcpRuntimeState;
  didActivate: boolean;
} {
  if (!state.firstPhaseActive) {
    return { state, didActivate: false };
  }

  return {
    state: {
      ...state,
      firstPhaseActive: false,
      forceConsoleFirstPending: false,
      strictRetryPending: false,
      fallbackReason: reason,
    },
    didActivate: true,
  };
}

export function resolveUnityMcpFirstPhaseTools(input: {
  tools: ToolDefinition[];
  unityMcpFirstPhaseActive: boolean;
  unityMcpForceConsoleFirstPending: boolean;
  unityMcpStrictRetryPending: boolean;
  effectiveUnityMcpToolNameSet: Set<string>;
}): {
  tools: ToolDefinition[];
  fallbackReason: string | null;
} {
  const {
    tools,
    unityMcpFirstPhaseActive,
    unityMcpForceConsoleFirstPending,
    unityMcpStrictRetryPending,
    effectiveUnityMcpToolNameSet,
  } = input;

  if (!unityMcpFirstPhaseActive) {
    return { tools, fallbackReason: null };
  }

  const shouldForceConsoleTools = unityMcpForceConsoleFirstPending || unityMcpStrictRetryPending;
  const forcedOrder = shouldForceConsoleTools
    ? UNITY_MCP_STRICT_RETRY_FORCED_TOOLS
    : [];
  const forcedTools = forcedOrder
    .map((name) => tools.find((tool) => tool.function.name === name))
    .filter((tool): tool is ToolDefinition => !!tool);

  if (shouldForceConsoleTools && !forcedTools.some((tool) => tool.function.name === "read_console")) {
    return { tools, fallbackReason: "missing_required_console_tool" };
  }

  if (unityMcpStrictRetryPending) {
    return { tools: forcedTools, fallbackReason: null };
  }

  const forcedSet = new Set(forcedTools.map((tool) => tool.function.name));
  const prioritizedUnityMcpTools = tools.filter(
    (tool) => effectiveUnityMcpToolNameSet.has(tool.function.name) && !forcedSet.has(tool.function.name),
  );

  if (forcedTools.length === 0 && prioritizedUnityMcpTools.length === 0) {
    return { tools, fallbackReason: "mcp_tools_not_exposed_for_runtime" };
  }

  return {
    tools: [
      ...forcedTools,
      ...prioritizedUnityMcpTools,
      ...tools.filter(
        (tool) =>
          !forcedSet.has(tool.function.name) &&
          !effectiveUnityMcpToolNameSet.has(tool.function.name),
      ),
    ],
    fallbackReason: null,
  };
}

export function resolveUnityMcpForcedConsoleResult(input: {
  results: ToolExecutionResult[];
  unityMcpForceConsoleFirstPending: boolean;
  unityConsoleMissingFirstToolRepromptIssued: boolean;
  forceXmlTools: boolean;
  language: "zh" | "en";
}): {
  unityMcpForceConsoleFirstPending: boolean;
  unityConsoleMissingFirstToolRepromptIssued: boolean;
  fallbackReason: string | null;
  prompt: string | null;
} {
  const {
    results,
    unityMcpForceConsoleFirstPending,
    unityConsoleMissingFirstToolRepromptIssued,
    forceXmlTools,
    language,
  } = input;

  if (!unityMcpForceConsoleFirstPending) {
    return {
      unityMcpForceConsoleFirstPending,
      unityConsoleMissingFirstToolRepromptIssued,
      fallbackReason: null,
      prompt: null,
    };
  }

  const readConsoleResult = results.find((result) => result.name === "read_console");
  if (!readConsoleResult) {
    const hasSuccessfulReadOnlyActivity = results.some(
      (result) =>
        hasCompletedToolExecution(result) &&
        (
          result.name === "set_active_instance" ||
          UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES.has(result.name)
        ),
    );
    if (shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity,
      repromptAlreadyIssued: unityConsoleMissingFirstToolRepromptIssued,
    })) {
      return {
        unityMcpForceConsoleFirstPending: true,
        unityConsoleMissingFirstToolRepromptIssued: true,
        fallbackReason: null,
        prompt: forceXmlTools
          ? language === "zh"
            ? "你已经调用了可用工具，但这轮是 Unity console 诊断路径，仍缺少必需的 `read_console`。下一条请只输出一个标准 XML `<tool_use>` 调用 `read_console`（必要时先 `set_active_instance`），不要输出 `<tool_code>` 或过程说明。"
            : "You already called an available tool, but this Unity console diagnostics path still requires `read_console`. In the next reply, output exactly one standard XML `<tool_use>` call for `read_console` (use `set_active_instance` first only if required), with no `<tool_code>` wrapper and no process narration."
          : language === "zh"
            ? "你已经调用了可用工具，但这轮是 Unity console 诊断路径，仍缺少必需的 `read_console`。下一条请从当前 native schema 发起一个正式工具调用：必要时先调用 `set_active_instance`，否则直接调用 `read_console`。不要输出文本工具占位符或过程说明。"
            : "You already called an available tool, but this Unity console diagnostics path still requires `read_console`. Make one formal tool call from the active native schemas next: use `set_active_instance` only if required; otherwise call `read_console` directly. Do not emit a text tool placeholder or process narration.",
      };
    }
    return {
      unityMcpForceConsoleFirstPending: false,
      unityConsoleMissingFirstToolRepromptIssued,
      fallbackReason: "forced_console_tool_not_called",
      prompt: language === "zh"
        ? "Unity MCP 未按预期执行 read_console，本轮自动回退到本地诊断路径。请立即使用本地只读工具读取最相关日志并给出结论。"
        : "Unity MCP did not execute read_console as expected. This turn has been auto-fallbacked to local diagnostics. Use local read-only tools now and report findings.",
    };
  }

  if (readConsoleResult.isError) {
    const failureCategory = extractMcpCallFailureCategory(readConsoleResult.content || "");
    if (failureCategory && ["unreachable", "route_mismatch", "session"].includes(failureCategory)) {
      return {
        unityMcpForceConsoleFirstPending: false,
        unityConsoleMissingFirstToolRepromptIssued,
        fallbackReason: `forced_console_call_failed:${failureCategory}`,
        prompt: language === "zh"
          ? "Unity MCP 首轮 read_console 调用失败，已自动回退到本地诊断路径。请直接读取本地日志并给出报错定位。"
          : "Unity MCP read_console failed on the first pass, so the turn has auto-fallbacked to local diagnostics. Read local logs directly and provide error localization.",
      };
    }
    return {
      unityMcpForceConsoleFirstPending: false,
      unityConsoleMissingFirstToolRepromptIssued,
      fallbackReason: null,
      prompt: null,
    };
  }

  return {
    unityMcpForceConsoleFirstPending: false,
    unityConsoleMissingFirstToolRepromptIssued,
    fallbackReason: null,
    prompt: null,
  };
}

export function resolveUnityMcpNoToolRecovery(input: {
  toolCallCount: number;
  replyOptionCount: number;
  unityMcpFirstPhaseActive: boolean;
  unityMcpFirstIterationPending: boolean;
  unityMcpStrictRetryPending: boolean;
  unityMcpStrictRetryIssued: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  forceXmlTools: boolean;
  language: "zh" | "en";
}): {
  status: "none" | "continue";
  reason: "none" | "strict_retry_no_tool_call" | "first_iteration_no_tool_call";
  fallbackReason: string | null;
  prompt: string | null;
  unityMcpFirstIterationPending: boolean;
  unityMcpStrictRetryPending: boolean;
  unityMcpStrictRetryIssued: boolean;
  logStrictRetry: boolean;
} {
  const {
    toolCallCount,
    replyOptionCount,
    unityMcpFirstPhaseActive,
    unityConsoleDiagnosticsRequested,
    forceXmlTools,
    language,
  } = input;

  if (
    input.unityMcpStrictRetryPending &&
    toolCallCount === 0 &&
    replyOptionCount === 0
  ) {
    return {
      status: "continue",
      reason: "strict_retry_no_tool_call",
      fallbackReason: "strict_retry_no_tool_call",
      prompt: language === "zh"
        ? "Unity MCP strict retry 仍没有产生 read_console 工具调用，本轮自动回退到本地诊断路径。请立即使用本地只读工具读取最相关日志并给出报错定位。"
        : "Unity MCP strict retry still did not produce a read_console tool call, so this turn has auto-fallbacked to local diagnostics. Use local read-only tools now and localize the console error.",
      unityMcpFirstIterationPending: input.unityMcpFirstIterationPending,
      unityMcpStrictRetryPending: false,
      unityMcpStrictRetryIssued: input.unityMcpStrictRetryIssued,
      logStrictRetry: false,
    };
  }

  if (forceXmlTools && shouldTriggerUnityMcpStrictRetry({
    toolCallCount,
    replyOptionCount,
    unityMcpFirstPhaseActive,
    unityMcpFirstIterationPending: input.unityMcpFirstIterationPending,
    unityConsoleDiagnosticsRequested,
    strictRetryAlreadyIssued: input.unityMcpStrictRetryIssued,
  })) {
    return {
      status: "continue",
      reason: "first_iteration_no_tool_call",
      fallbackReason: null,
      prompt: language === "zh"
        ? [
            "Unity MCP 首轮没有触发工具调用。下一条只能输出一个标准 XML `<tool_use>`，不要解释、不要总结、不要使用本地日志或 run_command。",
            "首选调用：",
            "<tool_use>",
            "<tool>read_console</tool>",
            "</tool_use>",
            "如果必须先选择 Unity 实例，先调用 `set_active_instance`；随后必须调用 `read_console`。",
          ].join("\n")
        : [
            "Unity MCP did not produce a tool call in the first iteration. In the next reply, output exactly one standard XML `<tool_use>` block with no explanation, no summary, and no local log/run_command fallback.",
            "Preferred call:",
            "<tool_use>",
            "<tool>read_console</tool>",
            "</tool_use>",
            "If an active Unity instance must be selected first, call `set_active_instance`; then you must call `read_console`.",
          ].join("\n"),
      unityMcpFirstIterationPending: false,
      unityMcpStrictRetryPending: true,
      unityMcpStrictRetryIssued: true,
      logStrictRetry: true,
    };
  }

  if (shouldTriggerUnityMcpFirstIterationFallback({
    toolCallCount,
    replyOptionCount,
    unityMcpFirstPhaseActive,
    unityMcpFirstIterationPending: input.unityMcpFirstIterationPending,
    unityConsoleDiagnosticsRequested: unityConsoleDiagnosticsRequested && forceXmlTools,
  })) {
    return {
      status: "continue",
      reason: "first_iteration_no_tool_call",
      fallbackReason: "first_iteration_no_tool_call",
      prompt: language === "zh"
        ? "Unity MCP 首轮没有触发工具调用。请立即改用当前可用的本地只读工具继续诊断，不要再声称将要读取。先读取最相关的日志/文件并给出发现。"
        : "Unity MCP did not produce a tool call in the first iteration. Immediately continue with currently available local read-only tools, read the most relevant logs/files now, and report findings.",
      unityMcpFirstIterationPending: false,
      unityMcpStrictRetryPending: input.unityMcpStrictRetryPending,
      unityMcpStrictRetryIssued: input.unityMcpStrictRetryIssued,
      logStrictRetry: false,
    };
  }

  return {
    status: "none",
    reason: "none",
    fallbackReason: null,
    prompt: null,
    unityMcpFirstIterationPending: input.unityMcpFirstIterationPending,
    unityMcpStrictRetryPending: input.unityMcpStrictRetryPending,
    unityMcpStrictRetryIssued: input.unityMcpStrictRetryIssued,
    logStrictRetry: false,
  };
}

type UnityMcpNoToolRecoveryResult = ReturnType<typeof resolveUnityMcpNoToolRecovery>;

export function applyUnityMcpNoToolRecoveryState(
  state: UnityMcpRuntimeState,
  recovery: UnityMcpNoToolRecoveryResult,
): UnityMcpRuntimeState {
  return {
    ...state,
    firstIterationPending: recovery.unityMcpFirstIterationPending,
    strictRetryPending: recovery.unityMcpStrictRetryPending,
    strictRetryIssued: recovery.unityMcpStrictRetryIssued,
  };
}

export function handleUnityMcpNoToolRecovery(input: {
  callbacks: OrchestratorCallbacks;
  state: UnityMcpRuntimeState;
  iteration: number;
  toolCallCount: number;
  replyOptionCount: number;
  unityConsoleDiagnosticsRequested: boolean;
  forceXmlTools: boolean;
  activateUnityMcpFallback: (reason: string) => void;
}): {
  status: "none" | "continue";
  state: UnityMcpRuntimeState;
} {
  const {
    callbacks,
    state,
    iteration,
    toolCallCount,
    replyOptionCount,
    unityConsoleDiagnosticsRequested,
    forceXmlTools,
    activateUnityMcpFallback,
  } = input;
  const recovery = resolveUnityMcpNoToolRecovery({
    toolCallCount,
    replyOptionCount,
    unityMcpFirstPhaseActive: state.firstPhaseActive,
    unityMcpFirstIterationPending: state.firstIterationPending,
    unityMcpStrictRetryPending: state.strictRetryPending,
    unityMcpStrictRetryIssued: state.strictRetryIssued,
    unityConsoleDiagnosticsRequested,
    forceXmlTools,
    language: callbacks.getPreferredLanguage(),
  });

  if (recovery.status !== "continue") {
    return { status: "none", state };
  }

  const nextState = applyUnityMcpNoToolRecoveryState(state, recovery);
  if (recovery.fallbackReason) {
    activateUnityMcpFallback(recovery.fallbackReason);
  }
  if (recovery.logStrictRetry) {
    logAgentEvent("unity_mcp_strict_retry", {
      iteration,
      reason: "first_iteration_no_tool_call",
      forceXmlTools,
      forcedTools: [...UNITY_MCP_STRICT_RETRY_FORCED_TOOLS],
    });
  }
  callbacks.onStatusChange("running");
  callbacks.appendMessage({
    role: "user",
    content: recovery.prompt || "",
  });
  return { status: "continue", state: nextState };
}

export function markUnityMcpToolCallsDetected(
  state: UnityMcpRuntimeState,
): UnityMcpRuntimeState {
  return {
    ...state,
    firstIterationPending: false,
    strictRetryPending: false,
  };
}

export function applyUnityMcpToolResultState(
  state: UnityMcpRuntimeState,
  update: {
    unityConsoleFinalVerificationRequired: boolean;
    unityConsoleRefreshObservedAfterWrite: boolean;
    unityMcpForceConsoleFirstPending: boolean;
    unityConsoleMissingFirstToolRepromptIssued: boolean;
  },
): UnityMcpRuntimeState {
  return {
    ...state,
    consoleFinalVerificationRequired: update.unityConsoleFinalVerificationRequired,
    consoleRefreshObservedAfterWrite: update.unityConsoleRefreshObservedAfterWrite,
    forceConsoleFirstPending: update.unityMcpForceConsoleFirstPending,
    consoleMissingFirstToolRepromptIssued:
      update.unityConsoleMissingFirstToolRepromptIssued,
  };
}
