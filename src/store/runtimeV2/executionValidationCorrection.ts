import type { TurnAggregateV1 } from "../../lib/runtime-v2";

export interface RuntimeV2ValidationCorrectionWindow {
  readonly active: boolean;
  readonly failureSequence: number | null;
  readonly repeatedFailedValidations: number;
  /** The sealed finite validator itself failed before yielding any exact
   * source diagnostic. Runtime must request a different bounded validator,
   * not invent a source-read loop. */
  readonly validationCommandUnavailable: boolean;
  readonly failedValidationCommand: string | null;
  readonly diagnosticSourceHints: readonly {
    readonly target: string;
    readonly line: number;
    readonly startLine: number;
    readonly endLine: number;
  }[];
}

function diagnosticSourceHints(
  message: string,
): RuntimeV2ValidationCorrectionWindow["diagnosticSourceHints"] {
  const hints: Array<{
    target: string;
    line: number;
    startLine: number;
    endLine: number;
  }> = [];
  const seen = new Set<string>();
  for (const rawLine of String(message || "").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(.+?):(\d+)(?::\d+)?(?:\s+-|\s|$)/);
    const target = String(match?.[1] || "")
      // Build tools commonly prefix a diagnostic path with a presentation
      // label (`file: /workspace/src/main.js:417:15`). The label is not part
      // of the file identity; retaining it makes the exact relative tool path
      // impossible to match even though the absolute path is in-workspace.
      .replace(/^\s*(?:file|path):\s*/i, "")
      .trim();
    const line = Number(match?.[2]);
    if (
      !target ||
      target.length > 500 ||
      !Number.isInteger(line) ||
      line <= 0 ||
      target.includes("://")
    ) {
      continue;
    }
    const identity = `${target}:${line}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    hints.push({
      target,
      line,
      startLine: Math.max(1, line - 24),
      endLine: line + 24,
    });
  }
  return hints;
}

function realFailedValidation(
  event: TurnAggregateV1["events"][number],
): event is Extract<
  TurnAggregateV1["events"][number],
  { type: "validation.completed" }
> {
  return event.type === "validation.completed" &&
    !event.passed &&
    (
      event.failureKind === "assertion_failed" ||
      event.failureKind === "execution_failed"
    );
}

/**
 * A real failed acceptance check reopens implementation against the newest
 * mutation boundary. Diagnostic paths and lines are guidance, not a second
 * overlapping read-state machine: ordinary source visibility, mutation
 * preflight, and consecutive no-effect recovery remain the only hard guards.
 */
export function deriveRuntimeV2ValidationCorrectionWindow(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2ValidationCorrectionWindow {
  const inactive: RuntimeV2ValidationCorrectionWindow = {
    active: false,
    failureSequence: null,
    repeatedFailedValidations: 0,
    validationCommandUnavailable: false,
    failedValidationCommand: null,
    diagnosticSourceHints: [],
  };
  if (!aggregate) return inactive;
  const latestMutationSequence = aggregate.events.reduce((latest, event) =>
    event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
      ? Math.max(latest, event.sequence)
      : latest, 0);
  if (latestMutationSequence <= 0) return inactive;
  const validations = aggregate.events.filter(
    (event): event is Extract<
      TurnAggregateV1["events"][number],
      { type: "validation.completed" }
    > =>
      event.type === "validation.completed" &&
      event.sequence > latestMutationSequence,
  );
  if (validations.some((event) => event.passed)) return inactive;
  const failures = validations.filter(realFailedValidation);
  const failure = failures[0];
  if (!failure) return inactive;

  const commands = new Map(aggregate.events.flatMap((event) =>
    event.type === "command.scheduled"
      ? [[event.command.idempotencyKey, event.command] as const]
      : []
  ));
  const failureCommand = commands.get(failure.idempotencyKey);
  const failedValidationCommand = String(
    failureCommand?.payload.arguments &&
        typeof failureCommand.payload.arguments === "object" &&
        !Array.isArray(failureCommand.payload.arguments)
      ? (failureCommand.payload.arguments as Record<string, unknown>).command ||
        (failureCommand.payload.arguments as Record<string, unknown>).cmd || ""
      : "",
  ).trim() || null;
  const hints = diagnosticSourceHints(
    String(failure.presentation?.message || ""),
  );
  const repeatedFailedValidations = Math.max(0, failures.length - 1);
  return {
    active: true,
    failureSequence: failure.sequence,
    repeatedFailedValidations,
    validationCommandUnavailable:
      failure.failureKind === "execution_failed" &&
      hints.length === 0 &&
      !!failedValidationCommand,
    failedValidationCommand,
    diagnosticSourceHints: hints,
  };
}
