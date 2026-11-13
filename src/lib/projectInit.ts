import type { ProjectBaselineContext, ProjectBaselineFact } from "./projectBaseline";
import type { PlanDocumentRef } from "./planDocuments";
import { sha256Hex } from "./sha256";

export const PROJECT_INIT_TARGET_PATH = "AGENTS.md";
export const PROJECT_INIT_BLOCK_START = "<!-- MAIN:PROJECT_INIT:START v1 -->";
export const PROJECT_INIT_BLOCK_END = "<!-- MAIN:PROJECT_INIT:END -->";
export const PROJECT_INIT_MAX_CONTENT_BYTES = 1024 * 1024;
export const PROJECT_INIT_MAX_EXISTING_BYTES = PROJECT_INIT_MAX_CONTENT_BYTES;

const PROJECT_INIT_START_TOKEN = "MAIN:PROJECT_INIT:START";
const PROJECT_INIT_END_TOKEN = "MAIN:PROJECT_INIT:END";
const PROJECT_INIT_RENDER_LIMITS = Object.freeze({ facts: 12, scripts: 24, directories: 24, anchors: 24 });

export type ProjectInitLocale = "zh" | "en";

export interface ProjectInitCommand {
  readonly kind: "project_init";
  readonly refresh: boolean;
  readonly request?: string;
}

export interface RulesDraftReview {
  readonly documentRef: PlanDocumentRef;
  readonly inspection: ProjectInitInspection;
  readonly markdown: string;
}

export interface ProjectInitInspection {
  readonly canonicalWorkspace: string;
  readonly workspaceIdentity: string;
  readonly targetPath: string;
  readonly exists: boolean;
  readonly content: string;
  readonly baseVersion: string | null;
}

export interface ProjectInitInspectInput {
  readonly workspace: string;
  readonly targetPath: typeof PROJECT_INIT_TARGET_PATH;
}

export interface ProjectInitBuildBaselineInput {
  readonly canonicalWorkspace: string;
  readonly workspaceIdentity: string;
}

export interface ProjectInitCasInput {
  readonly expectedCanonicalWorkspace: string;
  readonly expectedWorkspaceIdentity: string;
  readonly expectedTargetPath: string;
  readonly expectedBaseVersion: string | null;
  readonly proposedContent: string;
}

export type ProjectInitCasResult =
  | { readonly status: "committed"; readonly version: string }
  | { readonly status: "no_op"; readonly version?: string | null }
  | { readonly status: "stale"; readonly reason: "workspace_identity" | "target_path" | "base_version" };

export interface ProjectInitIo {
  inspect(input: ProjectInitInspectInput): Promise<ProjectInitInspection>;
  buildBaseline(input: ProjectInitBuildBaselineInput): Promise<ProjectBaselineContext>;
  commit(input: ProjectInitCasInput): Promise<ProjectInitCasResult>;
}

export type ProjectInitPreviewStatus =
  | "ready_create"
  | "ready_update"
  | "already_initialized"
  | "no_changes"
  | "invalid_managed_block";

export interface ProjectInitPreview {
  readonly editableDraft?: boolean;
  readonly command: ProjectInitCommand;
  readonly refresh: boolean;
  readonly locale: ProjectInitLocale;
  readonly canonicalWorkspace: string;
  readonly workspaceIdentity: string;
  readonly targetPath: string;
  readonly baseVersion: string | null;
  readonly existing: string;
  readonly proposed: string;
  readonly unifiedDiff: string;
  readonly status: ProjectInitPreviewStatus;
  readonly baselineFingerprint: string | null;
}

export type ProjectInitCommitResult =
  | ProjectInitCasResult
  | { readonly status: "no_op"; readonly reason: "already_initialized" | "no_changes" | "invalid_managed_block" }
  | { readonly status: "stale"; readonly reason: "workspace_identity" };

type ManagedBlockState =
  | { readonly status: "none" }
  | { readonly status: "valid"; readonly start: number; readonly end: number }
  | { readonly status: "invalid" };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function occurrences(content: string, token: string): number[] {
  const result: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(token, offset);
    if (index < 0) break;
    result.push(index);
    offset = index + token.length;
  }
  return result;
}

function inspectManagedBlock(content: string): ManagedBlockState {
  const starts = occurrences(content, PROJECT_INIT_START_TOKEN);
  const ends = occurrences(content, PROJECT_INIT_END_TOKEN);
  if (!starts.length && !ends.length) return { status: "none" };
  if (starts.length !== 1 || ends.length !== 1) return { status: "invalid" };
  const start = content.indexOf(PROJECT_INIT_BLOCK_START);
  const endStart = content.indexOf(PROJECT_INIT_BLOCK_END);
  if (start < 0 || endStart < 0 || starts[0] !== start + "<!-- ".length || ends[0] !== endStart + "<!-- ".length || start >= endStart) {
    return { status: "invalid" };
  }
  return { status: "valid", start, end: endStart + PROJECT_INIT_BLOCK_END.length };
}

function safeInline(value: string): string {
  const bounded = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/`/g, "ˋ").trim().slice(0, 240);
  return `\`${bounded || "unknown"}\``;
}

export function projectInitManagedBlockDigest(content: string): string | null {
  const block = inspectManagedBlock(content);
  return block.status === "valid" ? sha256Hex(content.slice(block.start, block.end)) : null;
}

function factLabel(fact: ProjectBaselineFact): string {
  return `${fact.name}${fact.version ? `@${fact.version}` : ""}${fact.constraint ? ` ${fact.constraint}` : ""}`;
}

function sortedUnique(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].sort(compareText).slice(0, limit);
}

function renderList(label: string, values: readonly string[], empty: string): string {
  return `- ${label}: ${values.length ? values.map(safeInline).join(", ") : empty}`;
}

function safeBaselineFingerprint(value: string): string {
  if (!/^project-baseline-sha256-[A-Za-z0-9._-]+$/.test(value)) throw new Error("PROJECT_INIT_INVALID_BASELINE_FINGERPRINT");
  return value;
}

export function parseProjectInitCommand(input: string): ProjectInitCommand | null {
  if (typeof input !== "string") return null;
  const match = input.trim().match(/^\/(?:规则|rules|init)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] || "").trim();
  const refresh = /^--refresh(?:\s|$)/.test(rest);
  const request = (refresh ? rest.replace(/^--refresh\s*/, "") : rest).trim();
  return { kind: "project_init", refresh, ...(request ? { request } : {}) };
}

export function renderProjectInitManagedBlock(
  baseline: ProjectBaselineContext,
  options: { readonly locale?: ProjectInitLocale } = {},
): string {
  const locale = options.locale || "en";
  const fingerprint = safeBaselineFingerprint(baseline.fingerprints.overall);
  const languages = sortedUnique(baseline.facts.languages.map(factLabel), PROJECT_INIT_RENDER_LIMITS.facts);
  const managers = sortedUnique(baseline.facts.packageManagers.map(factLabel), PROJECT_INIT_RENDER_LIMITS.facts);
  const runtimes = sortedUnique(baseline.facts.runtimes.map(factLabel), PROJECT_INIT_RENDER_LIMITS.facts);
  const packages = [...(baseline.facts.packages || [])]
    .sort((a, b) => Number(b.name.startsWith("com.unity.render-pipelines.")) - Number(a.name.startsWith("com.unity.render-pipelines.")) || compareText(a.name, b.name))
    .slice(0, PROJECT_INIT_RENDER_LIMITS.facts);
  const scripts = [...baseline.facts.scripts]
    .sort((a, b) => compareText(a.name, b.name))
    .slice(0, PROJECT_INIT_RENDER_LIMITS.scripts);
  const directories = sortedUnique(
    baseline.topology.filter(entry => entry.kind === "directory").map(entry => `${entry.path}/`),
    PROJECT_INIT_RENDER_LIMITS.directories,
  );
  const anchors = sortedUnique(baseline.anchors.map(anchor => anchor.path), PROJECT_INIT_RENDER_LIMITS.anchors);
  const zh = locale === "zh";
  const lines = [
    PROJECT_INIT_BLOCK_START,
    `<!-- baseline-fingerprint: ${fingerprint} -->`,
    zh ? "## MAIN 项目快速参考" : "## MAIN project quick reference",
    zh ? "> 此区块由 MAIN 确定性生成。请在区块外维护人工规则，版本以当前工程文件为准。" : "> MAIN generates this section from project facts. Keep human rules outside it. Use the current project files as the source of version information.",
    "",
    renderList(zh ? "语言" : "Languages", languages, zh ? "未检测到" : "none detected"),
    renderList(zh ? "包管理器" : "Package managers", managers, zh ? "未检测到" : "none detected"),
    renderList(zh ? "运行时" : "Runtimes", runtimes, zh ? "未检测到" : "none detected"),
    ...packages.map(fact => `- ${safeInline(factLabel(fact))} — ${safeInline(fact.provenance.path)}`),
    ...(baseline.facts.runtimes.some(fact => fact.provenance.path === "ProjectSettings/ProjectVersion.txt") ? [
      zh ? "- 引擎版本来源为 `ProjectSettings/ProjectVersion.txt`。编写引擎代码前核对当前包或匹配版本的文档，修改后查看实际 Editor 编译与 Shader 导入结果。"
        : "- Read the engine version from `ProjectSettings/ProjectVersion.txt`. Check installed packages or version-matched documentation for engine APIs. Verify actual Editor compilation and shader import after editing.",
    ] : []),
    "",
    zh ? "### 已声明命令" : "### Declared commands",
    ...(scripts.length
      ? scripts.map(script => `- ${safeInline(script.invocation || script.name)} — ${safeInline(script.provenance.path)}`)
      : [zh ? "- 未检测到" : "- none detected"]),
    "",
    zh ? "### 关键目录" : "### Key directories",
    ...(directories.length ? directories.map(directory => `- ${safeInline(directory)}`) : [zh ? "- 未检测到" : "- none detected"]),
    "",
    zh ? "### 基线锚点" : "### Baseline anchors",
    ...(anchors.length ? anchors.map(anchor => `- ${safeInline(anchor)}`) : [zh ? "- 未检测到" : "- none detected"]),
    PROJECT_INIT_BLOCK_END,
  ];
  return lines.join("\n");
}

function splitDiffLines(content: string): string[] {
  if (!content) return [];
  return content.replace(/\r\n?/g, "\n").split("\n");
}

export function createProjectInitUnifiedDiff(existing: string, proposed: string, targetPath: string): string {
  if (existing === proposed) return "";
  if (!targetPath || /[\r\n\u0000]/.test(targetPath)) throw new Error("PROJECT_INIT_INVALID_TARGET_PATH");
  const before = splitDiffLines(existing);
  const after = splitDiffLines(proposed);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const beforeChangeEnd = before.length - suffix;
  const afterChangeEnd = after.length - suffix;
  const beforeContextEnd = Math.min(before.length, beforeChangeEnd + 3);
  const afterContextEnd = Math.min(after.length, afterChangeEnd + 3);
  const oldCount = beforeContextEnd - contextStart;
  const newCount = afterContextEnd - contextStart;
  const oldStart = oldCount ? contextStart + 1 : 0;
  const newStart = newCount ? contextStart + 1 : 0;
  const output = [`--- ${targetPath}`, `+++ ${targetPath}`, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
  for (const line of before.slice(contextStart, prefix)) output.push(` ${line}`);
  for (const line of before.slice(prefix, beforeChangeEnd)) output.push(`-${line}`);
  for (const line of after.slice(prefix, afterChangeEnd)) output.push(`+${line}`);
  for (const line of after.slice(afterChangeEnd, afterContextEnd)) output.push(` ${line}`);
  return `${output.join("\n")}\n`;
}

function newlineFor(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function appendManagedBlock(existing: string, block: string): string {
  const newline = newlineFor(existing);
  const localized = block.replace(/\n/g, newline);
  if (!existing) return `${localized}${newline}`;
  const double = `${newline}${newline}`;
  const separator = existing.endsWith(double) ? "" : existing.endsWith(newline) ? newline : double;
  return `${existing}${separator}${localized}${newline}`;
}

function replaceManagedBlock(existing: string, block: string, state: Extract<ManagedBlockState, { status: "valid" }>): string {
  const localized = block.replace(/\n/g, newlineFor(existing));
  return `${existing.slice(0, state.start)}${localized}${existing.slice(state.end)}`;
}

export function withProjectInitManagedBlock(
  content: string,
  baseline: ProjectBaselineContext,
  locale: ProjectInitLocale,
): string {
  const managed = inspectManagedBlock(content);
  if (managed.status === "invalid") throw new Error("PROJECT_INIT_INVALID_MANAGED_BLOCK");
  const block = renderProjectInitManagedBlock(baseline, { locale });
  return managed.status === "valid" ? replaceManagedBlock(content, block, managed) : appendManagedBlock(content, block);
}

function normalizedAbsolutePath(value: string): string | null {
  let normalized = String(value || "").trim().replace(/\\/g, "/");
  if (!normalized || /[\r\n\u0000]/.test(normalized) || (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized))) return null;
  if (normalized !== "/" && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function validateInspection(inspection: ProjectInitInspection): void {
  if (!inspection.canonicalWorkspace || !inspection.workspaceIdentity || !inspection.targetPath || /[\r\n\u0000]/.test(`${inspection.canonicalWorkspace}${inspection.workspaceIdentity}${inspection.targetPath}`)) {
    throw new Error("PROJECT_INIT_INVALID_INSPECTION");
  }
  if (typeof inspection.content !== "string" || new TextEncoder().encode(inspection.content).byteLength > PROJECT_INIT_MAX_EXISTING_BYTES) {
    throw new Error("PROJECT_INIT_INVALID_INSPECTION");
  }
  const workspacePath = normalizedAbsolutePath(inspection.canonicalWorkspace);
  const targetPath = normalizedAbsolutePath(inspection.targetPath);
  const expectedTarget = workspacePath === "/" ? `/${PROJECT_INIT_TARGET_PATH}` : workspacePath ? `${workspacePath}/${PROJECT_INIT_TARGET_PATH}` : null;
  if (!workspacePath || !targetPath || targetPath !== expectedTarget || (inspection.baseVersion && (/[^\x20-\x7e]/.test(inspection.baseVersion) || inspection.baseVersion.length > 240))) {
    throw new Error("PROJECT_INIT_INVALID_INSPECTION");
  }
  if (inspection.exists ? !inspection.baseVersion : inspection.baseVersion !== null || !!inspection.content) {
    throw new Error("PROJECT_INIT_INVALID_INSPECTION");
  }
}

function previewWithoutChange(
  command: ProjectInitCommand,
  locale: ProjectInitLocale,
  inspection: ProjectInitInspection,
  status: "already_initialized" | "invalid_managed_block",
): ProjectInitPreview {
  return deepFreeze({ command, refresh: command.refresh, locale, canonicalWorkspace: inspection.canonicalWorkspace, workspaceIdentity: inspection.workspaceIdentity, targetPath: inspection.targetPath, baseVersion: inspection.baseVersion, existing: inspection.content, proposed: inspection.content, unifiedDiff: "", status, baselineFingerprint: null });
}

/** AI drafts and user edits share the existing inspected-file CAS boundary. */
export function buildProjectRulesPreview(inspection: ProjectInitInspection, candidate: string, locale: ProjectInitLocale = "zh"): ProjectInitPreview {
  validateInspection(inspection);
  if (typeof candidate !== "string") throw new Error("PROJECT_RULES_DRAFT_INVALID");
  if (new TextEncoder().encode(candidate).byteLength > PROJECT_INIT_MAX_CONTENT_BYTES) throw new Error("PROJECT_INIT_CONTENT_TOO_LARGE");
  return deepFreeze({ editableDraft: true, command: { kind: "project_init", refresh: false }, refresh: false, locale,
    canonicalWorkspace: inspection.canonicalWorkspace, workspaceIdentity: inspection.workspaceIdentity, targetPath: inspection.targetPath,
    baseVersion: inspection.baseVersion, existing: inspection.content, proposed: candidate,
    unifiedDiff: createProjectInitUnifiedDiff(inspection.content, candidate, inspection.targetPath),
    status: candidate === inspection.content ? "no_changes" : inspection.exists ? "ready_update" : "ready_create", baselineFingerprint: null });
}

export function updateProjectRulesPreview(preview: ProjectInitPreview, candidate: string): ProjectInitPreview {
  return buildProjectRulesPreview({ canonicalWorkspace: preview.canonicalWorkspace, workspaceIdentity: preview.workspaceIdentity, targetPath: preview.targetPath,
    exists: preview.baseVersion !== null, content: preview.existing, baseVersion: preview.baseVersion }, candidate, preview.locale);
}

export async function prepareProjectInitPreview(input: {
  readonly command: string;
  readonly workspace: string;
  readonly locale?: ProjectInitLocale;
  readonly io: ProjectInitIo;
}): Promise<ProjectInitPreview> {
  const command = parseProjectInitCommand(input.command);
  if (!command) throw new Error("PROJECT_INIT_INVALID_COMMAND");
  const locale = input.locale || "en";
  const inspection = await input.io.inspect({ workspace: input.workspace, targetPath: PROJECT_INIT_TARGET_PATH });
  validateInspection(inspection);
  const managed = inspectManagedBlock(inspection.content);
  if (managed.status === "invalid") return previewWithoutChange(command, locale, inspection, "invalid_managed_block");
  if (managed.status === "valid" && !command.refresh) return previewWithoutChange(command, locale, inspection, "already_initialized");
  const baseline = await input.io.buildBaseline({ canonicalWorkspace: inspection.canonicalWorkspace, workspaceIdentity: inspection.workspaceIdentity });
  if (baseline.workspace.canonicalPath !== inspection.canonicalWorkspace || baseline.workspace.identity !== inspection.workspaceIdentity) {
    throw new Error("PROJECT_INIT_BASELINE_WORKSPACE_MISMATCH");
  }
  const proposed = withProjectInitManagedBlock(inspection.content, baseline, locale);
  if (new TextEncoder().encode(proposed).byteLength > PROJECT_INIT_MAX_CONTENT_BYTES) {
    throw new Error("PROJECT_INIT_CONTENT_TOO_LARGE");
  }
  const status: ProjectInitPreviewStatus = proposed === inspection.content
    ? "no_changes"
    : inspection.exists ? "ready_update" : "ready_create";
  return deepFreeze({
    command,
    refresh: command.refresh,
    locale,
    canonicalWorkspace: inspection.canonicalWorkspace,
    workspaceIdentity: inspection.workspaceIdentity,
    targetPath: inspection.targetPath,
    baseVersion: inspection.baseVersion,
    existing: inspection.content,
    proposed,
    unifiedDiff: createProjectInitUnifiedDiff(inspection.content, proposed, inspection.targetPath),
    status,
    baselineFingerprint: baseline.fingerprints.overall,
  });
}

export async function commitProjectInitPreview(input: {
  readonly preview: ProjectInitPreview;
  readonly currentWorkspaceIdentity: string;
  readonly io: Pick<ProjectInitIo, "commit">;
}): Promise<ProjectInitCommitResult> {
  if (input.preview.editableDraft && !input.preview.proposed.trim()) throw new Error("PROJECT_RULES_DRAFT_EMPTY");
  if (input.currentWorkspaceIdentity !== input.preview.workspaceIdentity) return { status: "stale", reason: "workspace_identity" };
  if (input.preview.status === "already_initialized" || input.preview.status === "no_changes" || input.preview.status === "invalid_managed_block") {
    return { status: "no_op", reason: input.preview.status };
  }
  const result = await input.io.commit({
    expectedCanonicalWorkspace: input.preview.canonicalWorkspace,
    expectedWorkspaceIdentity: input.preview.workspaceIdentity,
    expectedTargetPath: input.preview.targetPath,
    expectedBaseVersion: input.preview.baseVersion,
    proposedContent: input.preview.proposed,
  });
  if (result.status === "committed" && result.version) return result;
  if (result.status === "no_op") return result;
  if (result.status === "stale" && ["workspace_identity", "target_path", "base_version"].includes(result.reason)) return result;
  throw new Error("PROJECT_INIT_INVALID_COMMIT_RESULT");
}

export interface ManagedProjectRulesPreference {
  readonly blockDigest: string;
  readonly locale: ProjectInitLocale;
}

/** Update only a block whose exact bytes the user last approved. */
export async function refreshApprovedProjectInitBlock(input: {
  readonly workspace: string;
  readonly preference: ManagedProjectRulesPreference;
  readonly io: ProjectInitIo;
  readonly isCurrent: () => boolean;
}): Promise<ManagedProjectRulesPreference | "needs_review" | null> {
  const inspection = await input.io.inspect({ workspace: input.workspace, targetPath: PROJECT_INIT_TARGET_PATH });
  if (!input.isCurrent()) return null;
  if (projectInitManagedBlockDigest(inspection.content) !== input.preference.blockDigest) return "needs_review";
  const preview = await prepareProjectInitPreview({
    command: "/rules --refresh",
    workspace: input.workspace,
    locale: input.preference.locale,
    io: { ...input.io, inspect: async () => inspection },
  });
  if (!input.isCurrent()) return null;
  if (preview.status === "no_changes") return null;
  if (preview.status !== "ready_update") return "needs_review";
  const blockDigest = projectInitManagedBlockDigest(preview.proposed);
  if (!blockDigest) return "needs_review";
  const result = await commitProjectInitPreview({
    preview,
    currentWorkspaceIdentity: inspection.workspaceIdentity,
    io: input.io,
  });
  return result.status === "committed" || result.status === "no_op"
    ? { ...input.preference, blockDigest } : "needs_review";
}

export function cancelProjectInitPreview(_preview: ProjectInitPreview): { readonly status: "canceled" } {
  return { status: "canceled" };
}
