import type {
  RuntimeV2Command,
  RuntimeV2NormalizedProviderResult,
} from "../../lib/runtime-v2";
import { finiteValidationCommandRejection } from "./executionAuthorization";

interface RuntimeV2SourceWindow {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export function selectRuntimeOwnedValidationAction(input: {
  command: RuntimeV2Command;
  allowedToolNames: readonly string[];
  preferredCommand: string;
}): RuntimeV2NormalizedProviderResult | null {
  const preferredCommand = input.preferredCommand.trim();
  if (
    String(input.command.payload.mode || "") !== "validate" ||
    !input.allowedToolNames.includes("run_command") ||
    !preferredCommand ||
    finiteValidationCommandRejection(preferredCommand)
  ) {
    return null;
  }
  return {
    visibleText: "",
    toolCalls: [{
      id: `runtime-validation:${input.command.idempotencyKey}`.slice(0, 256),
      name: "run_command",
      arguments: { command: preferredCommand },
    }],
    diagnostics: [{
      code: "runtime_owned_validation",
      message: "Runtime selected the approved finite workspace validator.",
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
