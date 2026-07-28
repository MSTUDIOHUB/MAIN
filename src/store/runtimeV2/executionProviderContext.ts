import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import {
  DEFAULT_PROVIDER_LANE_PROFILE_V1,
  deriveRuntimeV2PlanSourceFreshness,
  type ProviderLaneProfileV1,
} from "../../lib/runtime-v2";
import { RUNTIME_V2_PLAN_ARTIFACT_PATH } from "../../lib/runtime-v2/workPlan";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { boundedToolContent } from "./executionText";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2LiveExecutionState,
  RuntimeV2ModelContextEntry,
} from "./executionTypes";

const MAX_CONTEXT_ENTRIES = 16;
const MAX_CONTEXT_ENTRY_CHARS = 5_000;
const MAX_PLAN_CONTEXT_CHARS = 12_000;
const FAILURE_WINDOW_BEFORE_LINES = 64;
const FAILURE_WINDOW_AFTER_LINES = 40;

export function containsProviderTextEnvelopePrompt(
  language: "zh" | "en",
  toolRequired: boolean,
): string {
  if (language === "en") {
    return toolRequired
      ? "Native tools are unavailable for this request. A structured tool call is required now. Output exactly `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` with valid JSON and no prose."
      : "Native tools are unavailable for this request. If a tool is needed, output exactly `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` with valid JSON and no prose.";
  }
  return toolRequired
    ? "本次请求不使用原生工具，但当前阶段必须提交一个结构化工具调用。只输出完整的 `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` JSON 信封，不要混入说明文字。"
    : "本次请求不使用原生工具。若需要工具，只输出一个完整的 `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` JSON 信封，不要混入说明文字。";
}

export function baseProviderProfile(state: any): ProviderLaneProfileV1 {
  const settings = deriveStreamSettings(state.config);
  const nativeTools = String(settings.toolProtocol || "auto").toLowerCase() !==
    "xml";
  return {
    ...DEFAULT_PROVIDER_LANE_PROFILE_V1,
    nativeTools,
    requiredToolChoice: false,
    textToolEnvelope: true,
  };
}

/**
 * Once a required structured tool call has succeeded, keep that transport
 * first for the Turn. Native remains the primary lane, but one already
 * supported text-envelope attempt stays available inside the same bounded
 * request when a local server ignores required tool choice. A proven text
 * envelope is exclusive because it already establishes that native tools are
 * unnecessary. Optional prose responses never establish either preference.
 */
export function providerProfileForProvenToolTransport(
  profile: ProviderLaneProfileV1,
  provenTransport: "native" | "text_envelope" | null,
  requiresTool: boolean,
): ProviderLaneProfileV1 {
  if (!requiresTool || !provenTransport) return profile;
  return provenTransport === "native"
    ? profile
    : { ...profile, nativeTools: false };
}

export function recordApprovedPlanContext(
  input: RuntimeV2ExecutionPortsInput,
): void {
  const aggregate = aggregateForCurrentTurn(input);
  const approved = approvedPlanForCurrentTurn(input);
  if (!aggregate || !approved) return;
  const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
  recordModelContext(input.live, {
    id: `approved-plan:${approved.plan.id}:${approved.plan.revision}:${approved.plan.digest}`,
    source: "plan",
    label: "approved_work_plan",
    target: RUNTIME_V2_PLAN_ARTIFACT_PATH,
    status: "succeeded",
    content: [
      "This sealed WorkPlan is the mutation and validation authority for the current Run.",
      JSON.stringify({
        authority: approved.commit.authority,
        objective: approved.plan.draft.objective,
        summary: approved.plan.draft.summary,
        findings: approved.plan.draft.findings,
        steps: approved.plan.draft.steps,
        validations: approved.plan.draft.validations,
        risks: approved.plan.draft.risks,
        assumptions: approved.plan.draft.assumptions,
        sourceFreshness: freshness
          ? {
              allFresh: freshness.allFresh,
              missingTargets: freshness.missingTargets,
              staleTargets: freshness.staleTargets,
              unversionedTargets: freshness.unversionedTargets,
            }
          : null,
      }, null, 2),
      freshness && !freshness.allFresh
        ? `Before the first mutation, call read_file for every missing exact target: ${freshness.missingTargets.join(", ") || "none"}. A stale target invalidates this approval.`
        : "",
    ].join("\n\n"),
  });
}

export function recordModelContext(
  live: RuntimeV2LiveExecutionState,
  entry: RuntimeV2ModelContextEntry,
): void {
  const normalized: RuntimeV2ModelContextEntry = {
    ...entry,
    label: entry.label.trim().slice(0, 240),
    target: entry.target.trim().slice(0, 2_000),
    content: boundedToolContent(
      entry.content,
      entry.source === "plan"
        ? MAX_PLAN_CONTEXT_CHARS
        : MAX_CONTEXT_ENTRY_CHARS,
    ),
  };
  const duplicate = live.modelContext.findIndex((candidate) =>
    candidate.source === normalized.source &&
    candidate.label === normalized.label &&
    candidate.target === normalized.target
  );
  if (duplicate >= 0) live.modelContext.splice(duplicate, 1);
  live.modelContext.push(normalized);
  if (live.modelContext.length > MAX_CONTEXT_ENTRIES) {
    const retained = selectContextEntries(
      live.modelContext,
      MAX_CONTEXT_ENTRIES,
    );
    live.modelContext.splice(0, live.modelContext.length, ...retained);
  }
}

/** A phase-level hint, never an execution decision. Approved plans win; for
 * direct Execute turns the workspace skeleton supplies a provider-neutral
 * project-family default so weaker models do not waste validation rounds on
 * cat/grep-style observations. The command still passes the ordinary tool,
 * permission, and finite-validation contracts before it can run. */
export function preferredFiniteValidationCommand(
  input: RuntimeV2ExecutionPortsInput,
): string {
  const approved = approvedPlanForCurrentTurn(input);
  const approvedValidation = approved?.plan.draft.validations.find(
    (validation) =>
      validation.kind === "finite_command" &&
      String(validation.command || "").trim(),
  );
  const approvedCommand = String(approvedValidation?.command || "").trim();
  if (approvedCommand) return approvedCommand;

  const overview = input.live.workspaceOverview.toLowerCase();
  // Prefer the root package family before nested manifests. Desktop and
  // monorepo workspaces commonly contain Cargo.toml, go.mod, or Gradle files
  // below a package.json-owned root; choosing the nested checker would only
  // validate one implementation layer rather than the product build.
  if (/(?:^|[/\s])(?:bun\.lockb?|bun\.lock)\b/.test(overview)) {
    return "bun run build";
  }
  if (/(?:^|[/\s])pnpm-lock\.yaml\b/.test(overview)) return "pnpm run build";
  if (/(?:^|[/\s])yarn\.lock\b/.test(overview)) return "yarn build";
  if (/(?:^|[/\s])package\.json\b/.test(overview)) return "npm run build";
  if (/(?:^|[/\s])cargo\.toml\b/.test(overview)) return "cargo check";
  if (/(?:^|[/\s])go\.mod\b/.test(overview)) return "go test ./...";
  if (/(?:^|[/\s])(?:pyproject\.toml|pytest\.ini|tox\.ini)\b/.test(overview)) {
    return "python -m pytest";
  }
  if (/(?:^|[/\s])(?:gradlew|build\.gradle(?:\.kts)?)\b/.test(overview)) {
    return "./gradlew check";
  }
  if (/(?:^|[/\s])(?:mvnw|pom\.xml)\b/.test(overview)) return "./mvnw test";
  return "";
}

function latestIndex(
  entries: readonly RuntimeV2ModelContextEntry[],
  predicate: (entry: RuntimeV2ModelContextEntry) => boolean,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index]!)) return index;
  }
  return -1;
}

function isFailedValidationContext(
  entry: RuntimeV2ModelContextEntry,
): boolean {
  return entry.status !== "succeeded" &&
    (
      entry.label === "run_command" ||
      entry.label === "execute_command" ||
      entry.label === "browser_evaluate"
    );
}

export function contextAnchorIndices(
  entries: readonly RuntimeV2ModelContextEntry[],
): number[] {
  const anchors: number[] = [];
  const add = (index: number) => {
    if (index >= 0 && !anchors.includes(index)) anchors.push(index);
  };
  add(latestIndex(entries, (entry) => entry.status !== "succeeded"));
  // An unsuccessful patch may be newer than the validator that identified
  // the actual acceptance gap. Keep both: the patch failure explains why the
  // action was rejected, while the validator remains repair authority.
  add(latestIndex(entries, isFailedValidationContext));
  add(latestIndex(entries, (entry) => entry.source === "plan"));
  const subagentLabels = new Set(
    entries
      .filter((entry) => entry.source === "subagent")
      .map((entry) => entry.label),
  );
  for (const label of subagentLabels) {
    add(latestIndex(
      entries,
      (entry) => entry.source === "subagent" && entry.label === label,
    ));
  }
  add(latestIndex(entries, (entry) => entry.source === "workspace"));
  return anchors;
}

/** Keep durable context anchors plus the newest operational evidence.
 * Repeated tool chatter may age out, but it cannot evict the workspace,
 * approved plan, joined child reports, or latest failure that explains the
 * current recovery step. */
export function selectContextEntries(
  entries: readonly RuntimeV2ModelContextEntry[],
  limit = MAX_CONTEXT_ENTRIES,
): RuntimeV2ModelContextEntry[] {
  if (entries.length <= limit) return [...entries];
  const selected = new Set<number>();
  for (const index of contextAnchorIndices(entries)) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  for (
    let index = entries.length - 1;
    index >= 0 && selected.size < limit;
    index -= 1
  ) {
    selected.add(index);
  }
  return entries.filter((_entry, index) => selected.has(index));
}

export function normalizeRuntimeV2WorkspacePath(
  value: string,
  workspace: string,
): string {
  let normalized = value.trim()
    .replace(/^file:\s+/i, "")
    .replace(/^file:\/\//i, "")
    .replace(/^file:(?=\/)/i, "")
    .replace(/\\/g, "/")
    .replace(/^(["'`])([\s\S]*)\1$/, "$2")
    .replace(/^\.\//, "");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep a literal percent sign usable when the diagnostic is not a URI.
  }
  const root = workspace.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return root && normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}

/** Turn a compiler/test `path:line[:column]` failure into one focused source
 * window when a provider asks to reread that path without specifying lines.
 * This is protocol normalization from structured failure evidence, not a
 * task- or model-specific repair rule. */
export function latestFailureReadWindow(
  live: RuntimeV2LiveExecutionState,
  requestedPath: string,
  workspace = "",
): {
  readonly startLine: number;
  readonly endLine: number;
  readonly failureLine: number;
  readonly evidenceId: string;
} | null {
  const requested = normalizeRuntimeV2WorkspacePath(
    requestedPath,
    workspace,
  );
  if (!requested || requested.startsWith("../")) return null;
  for (let index = live.modelContext.length - 1; index >= 0; index -= 1) {
    const entry = live.modelContext[index]!;
    if (entry.status === "succeeded") continue;
    for (const rawLine of entry.content.split(/\r?\n/)) {
      const match = rawLine.match(/^\s*(.+?):(\d+)(?::\d+)?(?:\s|$)/);
      if (!match) continue;
      const candidate = normalizeRuntimeV2WorkspacePath(match[1]!, workspace);
      if (
        !candidate ||
        !candidate.includes(".") ||
        (
          candidate !== requested &&
          !candidate.endsWith(`/${requested}`) &&
          !requested.endsWith(`/${candidate}`)
        )
      ) {
        continue;
      }
      const failureLine = Number(match[2]);
      if (!Number.isSafeInteger(failureLine) || failureLine <= 0) continue;
      return {
        startLine: Math.max(1, failureLine - FAILURE_WINDOW_BEFORE_LINES),
        endLine: failureLine + FAILURE_WINDOW_AFTER_LINES,
        failureLine,
        evidenceId: entry.id,
      };
    }
  }
  return null;
}

function sourceWindowFromEntries(
  entries: readonly RuntimeV2ModelContextEntry[],
  workspace: string,
): {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly failureLine: number;
  readonly evidenceId: string;
} | null {
  for (const entry of entries) {
    for (const rawLine of entry.content.split(/\r?\n/)) {
      const match = rawLine.match(/^\s*(.+?):(\d+)(?::\d+)?(?:\s|$)/);
      if (!match) continue;
      const path = normalizeRuntimeV2WorkspacePath(match[1]!, workspace);
      if (
        !path ||
        !path.includes(".") ||
        path.startsWith("/") ||
        path.startsWith("../")
      ) {
        continue;
      }
      const failureLine = Number(match[2]);
      if (!Number.isSafeInteger(failureLine) || failureLine <= 0) continue;
      return {
        path,
        startLine: Math.max(1, failureLine - FAILURE_WINDOW_BEFORE_LINES),
        endLine: failureLine + FAILURE_WINDOW_AFTER_LINES,
        failureLine,
        evidenceId: entry.id,
      };
    }
  }
  return null;
}

/** Select the first source diagnostic from the newest failed acceptance
 * validation. A later rejected patch cannot displace that repair authority. */
export function latestAcceptanceFailureSourceWindow(
  live: RuntimeV2LiveExecutionState,
  workspace = "",
): {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly failureLine: number;
  readonly evidenceId: string;
} | null {
  return sourceWindowFromEntries(
    [...live.modelContext].reverse().filter(isFailedValidationContext),
    workspace,
  );
}

/** Use acceptance diagnostics first, then structural failures when stale
 * source recovery is the only available authority. */
export function latestFailureSourceWindow(
  live: RuntimeV2LiveExecutionState,
  workspace = "",
): {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly failureLine: number;
  readonly evidenceId: string;
} | null {
  const newestFirst = [...live.modelContext].reverse();
  return latestAcceptanceFailureSourceWindow(live, workspace) ||
    sourceWindowFromEntries(
    newestFirst.filter((entry) => entry.status !== "succeeded"),
    workspace,
  );
}

/**
 * Keep the failed acceptance check as semantic authority while letting a
 * newer search/patch mismatch choose a more accurate reread window inside the
 * same file. A mismatch in another file cannot redirect the corrective lease.
 */
export function latestCorrectiveSourceRefreshWindow(
  live: RuntimeV2LiveExecutionState,
  workspace = "",
): {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly failureLine: number;
  readonly evidenceId: string;
} | null {
  const acceptance = latestAcceptanceFailureSourceWindow(live, workspace);
  const structural = sourceWindowFromEntries(
    [...live.modelContext]
      .reverse()
      .filter((entry) =>
        entry.status !== "succeeded" && !isFailedValidationContext(entry)
      ),
    workspace,
  );
  if (
    structural &&
    (
      !acceptance ||
      (
        normalizeRuntimeV2WorkspacePath(structural.path, workspace) ===
          normalizeRuntimeV2WorkspacePath(acceptance.path, workspace) &&
        structural.failureLine >= acceptance.startLine &&
        structural.failureLine <= acceptance.endLine
      )
    )
  ) {
    return structural;
  }
  return acceptance || structural;
}
