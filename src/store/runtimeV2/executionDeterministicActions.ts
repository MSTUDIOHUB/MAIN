import type {
  RuntimeV2Command,
  RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";

interface RuntimeV2SourceWindow {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export function selectRuntimeOwnedRequiredSourceAction(input: {
  command: RuntimeV2Command;
  allowedToolNames: readonly string[];
  target: string | null;
}): RuntimeV2NormalizedProviderResult | null {
  const target = String(input.target || "").trim();
  if (!target || !input.allowedToolNames.includes("read_file")) {
    return null;
  }
  return {
    visibleText: "",
    toolCalls: [{
      id: `runtime-required-source:${input.command.idempotencyKey}`.slice(
        0,
        256,
      ),
      name: "read_file",
      arguments: { path: target },
    }],
    diagnostics: [{
      code: "runtime_owned_required_source",
      message: "Runtime selected the exact missing versioned source target.",
      retryable: false,
    }],
  };
}

export function selectRuntimeOwnedSourceRefreshAction(input: {
  command: RuntimeV2Command;
  allowedToolNames: readonly string[];
  sourceWindow: RuntimeV2SourceWindow | null;
}): RuntimeV2NormalizedProviderResult | null {
  const window = input.sourceWindow;
  if (
    input.command.payload.executePolicy !== "source_refresh_required" ||
    !input.allowedToolNames.includes("read_file") ||
    !window
  ) {
    return null;
  }
  return {
    visibleText: "",
    toolCalls: [{
      id: `runtime-source-refresh:${input.command.idempotencyKey}`.slice(
        0,
        256,
      ),
      name: "read_file",
      arguments: {
        path: window.path,
        start_line: window.startLine,
        end_line: window.endLine,
        max_lines: window.endLine - window.startLine + 1,
      },
    }],
    diagnostics: [{
      code: "runtime_owned_source_refresh",
      message: "Runtime selected the exact failed source window.",
      retryable: false,
    }],
  };
}
