import { extractPrimaryUserRequestText } from "./turnIntake";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import { analyzePtyObservationResult } from "./devServerRuntime";
import {
  normalizePlanEvidenceValue,
  requiresPtyObservationForPlanCommand,
  type PlanExecutionEvidenceEntry,
} from "./workflowModels";
import type { ToolDiffPreview } from "./toolDiff";
import { preserveNumberedUserGoalLines } from "./numberedGoalFacets";
import { classifyFailedFiniteValidationOutcome } from "./commandValidationOutcome";
import {
  EXTERNAL_WORKSPACE_MUTATION_TOOL_NAMES,
  hasResolvedWorkspaceMutationTarget,
  isWorkspaceMutationToolName,
} from "./workspaceMutationTools";

export interface PlanEvidenceFactInput {
  tool: string;
  target: string;
  status: string;
  summary?: string;
  hash?: string;
}

export interface PlanEvidenceFact {
  id: string;
  tool: string;
  target: string;
  summary: string;
  hash: string;
}

export interface PlanEvidenceBundle {
  bundleId: string;
  hash: string;
  turnId: string;
  objective: string;
  constraints: string[];
  facts: PlanEvidenceFact[];
  changeTargets: string[];
  verificationTargets: string[];
}

export interface PlanClosureEvidenceAssessment {
  ready: boolean;
  reason:
    | "bundle_not_ready"
    | "confirmed_change_rationale_available"
    | "contract_counterpart_unverified"
    | "change_targets_lack_confirmed_rationale";
  objectiveTargetMatches: number;
  defectSignalMatches: number;
  contractMismatchMatches: number;
  contractMismatchKinds: string[];
  unresolvedContractKinds: string[];
}

export interface PlanConfigurationContractAssessment {
  key: string;
  status: "consistent" | "mismatch";
  values: string[];
  targets: string[];
}

export interface PlanCandidateChange {
  text: string;
  targetRef: string;
  evidenceRefs: string[];
}

export interface PlanCandidate {
  bundleHash: string;
  summary: string[];
  findings: string[];
  changes: PlanCandidateChange[];
  interfaces: string[];
  tests: string[];
  assumptions: string[];
  blockingChoices: string[];
}

const SOURCE_TARGET_RE = /\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|swift|java|kt|cs|cpp|c|h|hpp|vue|svelte|css|scss|html|json|toml|ya?ml)$/i;
const PLAN_PATH_RE = /(?:^|[\\/])\.MAIN[\\/]plans[\\/]/i;
const LOW_SIGNAL_TARGET_RE = /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const PATH_LIKE_RE = /(?:^|[\s`'"(])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+)(?=$|[\s`'"),:;])/g;
const MAX_PLAN_EVIDENCE_FACTS = 24;

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function compact(value: unknown, maxChars = 280): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
}

function unique(values: string[], limit = 16): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const value = compact(raw);
    const key = value.toLowerCase().replace(/\\/g, "/");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function isSemanticFact(input: PlanEvidenceFactInput): boolean {
  const summary = compact(input.summary);
  const target = compact(input.target);
  if (!summary || summary.length < 12 || !target || PLAN_PATH_RE.test(target)) return false;
  const normalizedSummary = summary.toLowerCase().replace(/\\/g, "/");
  const normalizedTarget = target.toLowerCase().replace(/\\/g, "/");
  if (normalizedSummary === normalizedTarget) return false;
  if (new RegExp(`^(?:已读取文件|read file|已查看目录|listed directory)[:：; ]+${escapeRegExp(normalizedTarget)}[.;； ]*$`, "i").test(normalizedSummary)) {
    return false;
  }
  if (/^(?:searched files|已搜索文件|inspected project structure|已查看项目结构)[:：; ]/i.test(summary)) return false;
  if (/^(?:L\d+\s*[:：]\s*)?import\s+[^;]+;?$/i.test(summary)) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferVerificationTargets(constraints: string[], facts: PlanEvidenceFact[]): string[] {
  const commands = [...constraints, ...facts.map((fact) => fact.summary)]
    .flatMap((value) => [...value.matchAll(/`([^`]+)`/g)].map((match) => compact(match[1], 180)))
    .filter((value) => /^(?:npm|pnpm|yarn|bun|npx|node|cargo|pytest|python|go|swift|dotnet|mvn|gradle)/i.test(value));
  return unique(commands, 8);
}

function objectiveMentionsTarget(objective: string, target: string): boolean {
  const normalizedObjective = objective.replace(/\\/g, "/").toLowerCase();
  const normalizedTarget = target.replace(/\\/g, "/").toLowerCase();
  const basename = normalizedTarget.split("/").pop() || normalizedTarget;
  return normalizedObjective.includes(normalizedTarget) || (!!basename && normalizedObjective.includes(basename));
}

function summaryExposesTargetDefect(summary: string): boolean {
  const withoutDiagnosticMessages = String(summary || "")
    .replace(/console\.(?:error|warn|log)\s*\([^)]*\)/gi, " ");
  return /(?:\b(?:missing|incorrect(?:ly)?|wrong(?:ly)?|broken|unimplemented|stubbed?|fails?|failure|no-op|empty handler|does not|doesn't|without|never\s+(?:assigns?|maps?|registers?|listens?|returns?|sets?|handles?|calls?|emits?))\b|\bonly\s+(?:returns?|sets?|writes?|handles?|calls?|emits?)\b|缺少|缺失|错误|不正确|失效|失败|未实现|未注册|未监听|未等待|从未(?:映射|注册|监听|返回|设置|处理|调用)|没有(?:映射|注册|监听|返回|设置|处理)|为空|空实现|只(?:返回|设置|写入|处理|调用)|仅(?:返回|设置|写入|处理|调用))/i.test(withoutDiagnosticMessages);
}

function summaryExposesImplementationStructure(summary: string): boolean {
  return /(?:\b(?:function|handler|listener|event|command|invoke|emit|payload|callback|builder|setup|registers?|listens?|returns?|forwards?|loads?|stores?|permissions?|capabilit(?:y|ies)|plugins?)\b|\b(?:handler|permission|event_(?:emit|dom_listener|tauri_listener))_contract\b|(?:window|app|tauri|dialog)\s*[.:]|[_-](?:event|handler)\b|函数|处理器|监听|事件|命令|调用|回调|注册|返回|转发|加载|存储|配置|权限|能力|插件)/i.test(summary);
}

interface ComparableConfigurationObservation {
  key: "development_server_port";
  value: string;
}

function extractComparableConfigurationObservations(
  fact: Pick<PlanEvidenceFact, "target" | "summary">,
): ComparableConfigurationObservation[] {
  const target = String(fact.target || "");
  const summary = String(fact.summary || "");
  const looksLikeDevelopmentConfig =
    /(?:^|[\\/])(?:[^\\/]*(?:config|conf)[^\\/]*)\.[A-Za-z0-9]+$/i.test(target) ||
    /\b(?:devUrl|dev[_-]?server|development server|beforeDevCommand|localhost|127\.0\.0\.1)\b/i.test(summary);
  if (!looksLikeDevelopmentConfig) return [];

  const values = new Set<string>();
  for (const match of summary.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*(\d{2,5})/gi)) {
    if (match[1]) values.add(match[1]);
  }
  for (const match of summary.matchAll(/(?:\bdevUrl\b|\bdev[_-]?server(?:\s+port)?\b|\bdevelopment server(?:\s+port)?\b|\bport\b)\s*["']?\s*[:=]\s*["']?(\d{2,5})\b/gi)) {
    if (match[1]) values.add(match[1]);
  }
  for (const match of summary.matchAll(/--port(?:=|\s+)(\d{2,5})\b/gi)) {
    if (match[1]) values.add(match[1]);
  }
  return [...values].map((value) => ({ key: "development_server_port", value }));
}

function objectiveRequestsComparableConfiguration(objective: string): boolean {
  return /\b(?:dev(?:elopment)?(?:\s+server)?|startup|launch|serve|port)\b|开发(?:服务器|服务)?|启动|端口/i.test(
    String(objective || ""),
  );
}

function collectConfigurationContractAssessments(
  facts: PlanEvidenceFact[],
  objective: string,
): PlanConfigurationContractAssessment[] {
  if (!objectiveRequestsComparableConfiguration(objective)) return [];
  const grouped = new Map<string, { values: Set<string>; targets: Set<string> }>();
  for (const fact of facts) {
    for (const observation of extractComparableConfigurationObservations(fact)) {
      const entry = grouped.get(observation.key) || {
        values: new Set<string>(),
        targets: new Set<string>(),
      };
      entry.values.add(observation.value);
      entry.targets.add(fact.target);
      grouped.set(observation.key, entry);
    }
  }
  return [...grouped.entries()]
    .filter(([, entry]) => entry.targets.size > 1)
    .map(([key, entry]) => ({
      key,
      status: entry.values.size > 1 ? "mismatch" as const : "consistent" as const,
      values: [...entry.values],
      targets: [...entry.targets],
    }));
}

export function assessPlanConfigurationContracts(
  bundle: PlanEvidenceBundle,
): PlanConfigurationContractAssessment[] {
  return collectConfigurationContractAssessments(bundle.facts, bundle.objective);
}

function planEvidenceFactPriority(fact: PlanEvidenceFact, objective: string, index: number): number {
  let score = Math.min(index, 10) / 100;
  if (objectiveMentionsTarget(objective, fact.target)) score += 20;
  if (summaryExposesTargetDefect(fact.summary)) score += 10;
  if (/(?:command_invoke|handler|event_(?:emit|dom_listener|tauri_listener)|permission)_contract\s*\(|@tauri-apps\/plugin-|tauri_plugin_/i.test(fact.summary)) {
    score += 12;
  }
  if (extractComparableConfigurationObservations(fact).length > 0) score += 10;
  if (summaryExposesImplementationStructure(fact.summary)) score += 2;
  if (/^(?:read_file|read_file_window|read_document|code_ast_query|find_symbol_references|git_diff)$/i.test(fact.tool)) score += 1;
  return score;
}

function collectContractMismatchKinds(facts: PlanEvidenceFact[], objective = ""): string[] {
  const invokedCommands = new Set<string>();
  const registeredCommands = new Set<string>();
  const emittedEvents = new Set<string>();
  const tauriListenedEvents = new Set<string>();
  const domListenedEvents = new Set<string>();
  const configuredPlugins = new Set<string>();
  const capabilityEvidence: string[] = [];
  let hasCompleteHandlerList = false;

  for (const fact of facts) {
    const summary = String(fact.summary || "");
    for (const match of summary.matchAll(/(?:\binvoke\s*\(\s*[`'"]([A-Za-z0-9_.:-]+)[`'"]|command_invoke_contract\s*\(([^)]+)\))/gi)) {
      const command = match[1] || match[2] || "";
      if (command) invokedCommands.add(command);
    }
    for (const match of summary.matchAll(/(?:generate_handler!\s*\[([\s\S]*?)\]|handler_contract\s*\(([^)]*)\))/gi)) {
      hasCompleteHandlerList = true;
      for (const identifier of (match[1] || match[2] || "").match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        registeredCommands.add(identifier);
      }
    }
    for (const match of summary.matchAll(/(?:\.emit\s*\(\s*[`'"]([A-Za-z0-9_.:-]+)[`'"]|event_emit_contract\s*\(([^)]+)\))/gi)) {
      const eventName = match[1] || match[2] || "";
      if (eventName) emittedEvents.add(eventName);
    }
    for (const match of summary.matchAll(/(?:(?:^|[^A-Za-z0-9_])listen\s*\(\s*[`'"]([A-Za-z0-9_.:-]+)[`'"]|event_tauri_listener_contract\s*\(([^)]+)\))/gi)) {
      const eventName = match[1] || match[2] || "";
      if (eventName) tauriListenedEvents.add(eventName);
    }
    for (const match of summary.matchAll(/(?:addEventListener\s*\(\s*[`'"]([A-Za-z0-9_.:-]+)[`'"]|event_dom_listener_contract\s*\(([^)]+)\))/gi)) {
      const eventName = match[1] || match[2] || "";
      if (eventName) domListenedEvents.add(eventName);
    }
    for (const match of summary.matchAll(/(?:@tauri-apps\/plugin-([a-z0-9_-]+)|tauri_plugin_([a-z0-9_]+))/gi)) {
      const plugin = String(match[1] || match[2] || "").replace(/_/g, "-").toLowerCase();
      if (plugin) configuredPlugins.add(plugin);
    }
    if (
      /(?:^|\/)capabilities\//i.test(fact.target) &&
      /(?:permissions|permission_contract)/i.test(summary) &&
      (/(?:permission_contract\s*\([^)]*\)|permissions[\s\S]*\])/i.test(summary))
    ) {
      capabilityEvidence.push(summary);
    }
  }

  const mismatches: string[] = [];
  if (hasCompleteHandlerList) {
    for (const command of invokedCommands) {
      if (!registeredCommands.has(command)) mismatches.push(`unregistered_command:${command}`);
    }
  }
  for (const eventName of emittedEvents) {
    if (domListenedEvents.has(eventName) && !tauriListenedEvents.has(eventName)) {
      mismatches.push(`event_listener_api:${eventName}`);
    }
  }
  const capabilityPermissions = capabilityEvidence.join("\n");
  if (capabilityPermissions) {
    for (const plugin of configuredPlugins) {
      const permissionPrefix = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(plugin)}:[A-Za-z0-9_*-]+`, "i");
      if (!permissionPrefix.test(capabilityPermissions)) {
        mismatches.push(`missing_permission:${plugin}`);
      }
    }
  }
  for (const contract of collectConfigurationContractAssessments(facts, objective)) {
    if (contract.status === "mismatch") {
      mismatches.push(`config_value_mismatch:${contract.key}`);
    }
  }
  return [...new Set(mismatches)].slice(0, 8);
}

function collectUnresolvedContractKinds(
  facts: PlanEvidenceFact[],
  changeTargets: string[],
): string[] {
  const frontendPlugins = new Map<string, Set<string>>();
  const backendPlugins = new Map<string, Set<string>>();
  let hasCapabilityPermissionEvidence = false;
  for (const fact of facts) {
    const summary = String(fact.summary || "");
    if (
      /(?:^|\/)capabilities\//i.test(fact.target.replace(/\\/g, "/")) &&
      /permission_contract\s*\(/i.test(summary)
    ) {
      hasCapabilityPermissionEvidence = true;
    }
    for (const match of summary.matchAll(/@tauri-apps\/plugin-([a-z0-9_-]+)/gi)) {
      const plugin = String(match[1] || "").replace(/_/g, "-").toLowerCase();
      if (!plugin) continue;
      const targets = frontendPlugins.get(plugin) || new Set<string>();
      targets.add(fact.target);
      frontendPlugins.set(plugin, targets);
    }
    for (const match of summary.matchAll(/tauri_plugin_([a-z0-9_]+)/gi)) {
      const plugin = String(match[1] || "").replace(/_/g, "-").toLowerCase();
      if (!plugin) continue;
      const targets = backendPlugins.get(plugin) || new Set<string>();
      targets.add(fact.target);
      backendPlugins.set(plugin, targets);
    }
  }
  if (hasCapabilityPermissionEvidence) return [];

  const normalizedChangeTargets = new Set(
    changeTargets.map((target) => target.replace(/\\/g, "/").toLowerCase()),
  );
  return [...frontendPlugins.keys()]
    .filter((plugin) => backendPlugins.has(plugin))
    .filter((plugin) => {
      const owners = [
        ...(frontendPlugins.get(plugin) || []),
        ...(backendPlugins.get(plugin) || []),
      ];
      return owners.some((target) =>
        normalizedChangeTargets.has(target.replace(/\\/g, "/").toLowerCase())
      );
    })
    .map((plugin) => `permission_contract:${plugin}`)
    .slice(0, 8);
}

function factIsChangeTargetForContractMismatch(
  fact: PlanEvidenceFact,
  mismatchKinds: string[],
): boolean {
  const summary = String(fact.summary || "");
  const normalizedTarget = fact.target.replace(/\\/g, "/").toLowerCase();
  for (const kind of mismatchKinds) {
    if (kind.startsWith("unregistered_command:") && /(?:generate_handler!\s*\[|handler_contract\s*\()/i.test(summary)) {
      return true;
    }
    if (kind.startsWith("event_listener_api:")) {
      const eventName = kind.slice("event_listener_api:".length);
      const escapedEventName = escapeRegExp(eventName);
      if (new RegExp(`(?:addEventListener\\s*\\(\\s*[\u0060'"]${escapedEventName}[\u0060'"]|event_dom_listener_contract\\s*\\(${escapedEventName}\\))`, "i").test(summary)) {
        return true;
      }
    }
    if (
      kind.startsWith("missing_permission:") &&
      /(?:^|\/)capabilities\//i.test(normalizedTarget) &&
      /(?:permissions|permission_contract)/i.test(summary)
    ) {
      return true;
    }
    if (kind.startsWith("config_value_mismatch:")) {
      const key = kind.slice("config_value_mismatch:".length);
      if (extractComparableConfigurationObservations(fact).some((observation) => observation.key === key)) {
        return true;
      }
    }
  }
  return false;
}

function isActionableChangeTarget(fact: PlanEvidenceFact, objective: string): boolean {
  if (!SOURCE_TARGET_RE.test(fact.target) || LOW_SIGNAL_TARGET_RE.test(fact.target)) return false;
  if (!objectiveMentionsTarget(objective, fact.target) && !summaryExposesTargetDefect(fact.summary)) return false;
  const normalizedTarget = fact.target.replace(/\\/g, "/").toLowerCase();
  if (normalizedTarget.endsWith("/package.json") || normalizedTarget === "package.json") {
    return /dependency|dependencies|script|plugin|exports|module|version|package manager|依赖|脚本|插件|导出|模块|版本/i.test(fact.summary) &&
      !/general package metadata|only package metadata|普通包元数据|仅.*元数据/i.test(fact.summary);
  }
  if (normalizedTarget.endsWith("/index.html") || normalizedTarget === "index.html") {
    return /mount|script|module|base href|element|webview|入口|挂载|脚本|元素/i.test(fact.summary) &&
      !/(?:only|仅).{0,20}(?:title|标题)/i.test(fact.summary);
  }
  return true;
}

export function buildPlanEvidenceBundle(input: {
  turnId?: string | null;
  objective: string;
  constraints?: string[];
  evidenceRecords?: PlanEvidenceFactInput[];
  files?: string[];
}): PlanEvidenceBundle {
  const rawObjective = extractPrimaryUserRequestText(input.objective) || input.objective;
  const objective = preserveNumberedUserGoalLines(rawObjective, 600) || compact(rawObjective, 600);
  const constraints = unique(input.constraints || [], 8);
  const semanticFacts = (input.evidenceRecords || [])
    .filter((record) => record.status === "succeeded" && isSemanticFact(record))
    .map((record, index) => {
      const summary = compact(record.summary, 320);
      const target = compact(record.target, 220);
      const hash = compact(record.hash) || stableHash(`${record.tool}\n${target}\n${summary}`);
      return {
        id: `fact-${index + 1}-${hash}`,
        tool: compact(record.tool, 80),
        target,
        summary,
        hash,
      };
    });
  const selectedFactIndexes = new Set(
    semanticFacts
      .map((fact, index) => ({
        score: planEvidenceFactPriority(fact, objective, index),
        index,
      }))
      .sort((left, right) => right.score - left.score || right.index - left.index)
      .slice(0, MAX_PLAN_EVIDENCE_FACTS)
      .map((entry) => entry.index),
  );
  const facts = semanticFacts
    .filter((_fact, index) => selectedFactIndexes.has(index))
    .map((fact, index) => ({ ...fact, id: `fact-${index + 1}-${fact.hash}` }));
  const strictFactTargets = facts
    .filter((fact) => isActionableChangeTarget(fact, objective))
    .map((fact) => fact.target);
  const contractMismatchKinds = collectContractMismatchKinds(facts, objective);
  const contractFactTargets = facts
    .filter((fact) => factIsChangeTargetForContractMismatch(fact, contractMismatchKinds))
    .map((fact) => fact.target);
  const groundedFactTargets = unique([...strictFactTargets, ...contractFactTargets], 12);
  // Symptom-only requests usually do not name implementation paths. When the
  // targeted reads already expose concrete source structure, retain those
  // paths as the evidence-backed scope instead of reporting zero targets and
  // forcing the model into another broad read loop. This fallback is used only
  // when no stricter defect/path match exists, so related-consumer reads do not
  // widen an already grounded plan.
  const factTargets = groundedFactTargets.length > 0
    ? groundedFactTargets
    : facts
      .filter((fact) =>
        SOURCE_TARGET_RE.test(fact.target) &&
        !LOW_SIGNAL_TARGET_RE.test(fact.target) &&
        summaryExposesImplementationStructure(fact.summary)
      )
      .map((fact) => fact.target);
  const fileTargets = (input.files || []).filter((target) =>
    SOURCE_TARGET_RE.test(target) &&
    !PLAN_PATH_RE.test(target) &&
    !LOW_SIGNAL_TARGET_RE.test(target) &&
    facts.some((fact) =>
      factTargets.includes(fact.target) && workspacePathsReferToSameFile(fact.target, target)
    )
  );
  const changeTargets = unique([...factTargets, ...fileTargets], 12);
  const verificationTargets = inferVerificationTargets(constraints, facts);
  const payload = JSON.stringify({ objective, constraints, facts, changeTargets, verificationTargets });
  const hash = stableHash(payload);
  const turnId = compact(input.turnId) || "unknown-turn";
  return {
    bundleId: `plan-evidence-${turnId}-${hash}`,
    hash,
    turnId,
    objective,
    constraints,
    facts,
    changeTargets,
    verificationTargets,
  };
}

export function isPlanEvidenceBundleReady(bundle: PlanEvidenceBundle): boolean {
  return !!bundle.objective && bundle.facts.length > 0 && bundle.changeTargets.length > 0;
}

/**
 * A runtime-generated fallback plan must be held to a higher bar than a
 * model-authored draft.  Structural excerpts can guide further investigation,
 * but they do not establish that a particular file is the cause of a
 * symptom-only request.  Auto-materializing from those excerpts produces a
 * formally shaped but operationally empty checklist.
 */
export function assessPlanClosureEvidence(
  bundle: PlanEvidenceBundle,
): PlanClosureEvidenceAssessment {
  if (!isPlanEvidenceBundleReady(bundle)) {
    return {
      ready: false,
      reason: "bundle_not_ready",
      objectiveTargetMatches: 0,
      defectSignalMatches: 0,
      contractMismatchMatches: 0,
      contractMismatchKinds: [],
      unresolvedContractKinds: [],
    };
  }
  const normalizedTargets = new Set(bundle.changeTargets.map((target) =>
    target.replace(/\\/g, "/").toLowerCase(),
  ));
  let objectiveTargetMatches = 0;
  let defectSignalMatches = 0;
  for (const fact of bundle.facts) {
    const target = fact.target.replace(/\\/g, "/").toLowerCase();
    if (!normalizedTargets.has(target)) continue;
    if (objectiveMentionsTarget(bundle.objective, fact.target)) {
      objectiveTargetMatches += 1;
    }
    if (summaryExposesTargetDefect(fact.summary)) {
      defectSignalMatches += 1;
    }
  }
  const contractMismatchKinds = collectContractMismatchKinds(bundle.facts, bundle.objective);
  const contractMismatchMatches = contractMismatchKinds.length;
  const unresolvedContractKinds = collectUnresolvedContractKinds(
    bundle.facts,
    bundle.changeTargets,
  );
  const hasConfirmedRationale =
    objectiveTargetMatches > 0 ||
    defectSignalMatches > 0 ||
    contractMismatchMatches > 0;
  const ready = hasConfirmedRationale && unresolvedContractKinds.length === 0;
  return {
    ready,
    reason: unresolvedContractKinds.length > 0
      ? "contract_counterpart_unverified"
      : ready
        ? "confirmed_change_rationale_available"
        : "change_targets_lack_confirmed_rationale",
    objectiveTargetMatches,
    defectSignalMatches,
    contractMismatchMatches,
    contractMismatchKinds,
    unresolvedContractKinds,
  };
}

export function hasDeterministicPlanMaterializationEvidence(bundle: PlanEvidenceBundle): boolean {
  return assessPlanClosureEvidence(bundle).ready;
}

export function formatPlanEvidenceBundleForModel(
  bundle: PlanEvidenceBundle,
  language: "zh" | "en",
): string {
  const facts = bundle.facts.map((fact) => `- [${fact.id}] ${fact.tool} ${fact.target}: ${fact.summary}`);
  const targets = bundle.changeTargets.map((target) => `- ${target}`);
  const verification = bundle.verificationTargets.map((target) => `- ${target}`);
  if (language === "en") {
    return [
      `[plan_evidence_bundle id=${bundle.bundleId} hash=${bundle.hash}]`,
      `Canonical objective: ${bundle.objective}`,
      "Confirmed semantic facts:",
      ...(facts.length ? facts : ["- none"]),
      "Grounded change targets:",
      ...(targets.length ? targets : ["- none"]),
      ...(verification.length ? ["Verification targets:", ...verification] : []),
      "Use this exact bundle for the plan. Do not quote the bundle id/hash or this wrapper in visible output.",
      "[/plan_evidence_bundle]",
    ].join("\n");
  }
  return [
    `[plan_evidence_bundle id=${bundle.bundleId} hash=${bundle.hash}]`,
    `规范用户目标：${bundle.objective}`,
    "已确认的语义事实：",
    ...(facts.length ? facts : ["- 无"]),
    "有证据支撑的改动目标：",
    ...(targets.length ? targets : ["- 无"]),
    ...(verification.length ? ["验证目标：", ...verification] : []),
    "计划必须使用这一个证据包；可见输出中不要复述 bundle id/hash 或本包装。",
    "[/plan_evidence_bundle]",
  ].join("\n");
}

function sectionLines(content: string, heading: RegExp): string[] {
  let active = false;
  const lines: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^#{1,6}\s+(.+?)\s*$/);
    if (match) {
      if (active) break;
      active = heading.test(match[1] || "");
      continue;
    }
    if (!active) continue;
    const line = rawLine.trim().replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (line) lines.push(compact(line, 500));
  }
  return lines;
}

function findTargetRef(text: string, bundle: PlanEvidenceBundle): string {
  const explicitPaths = [...text.matchAll(PATH_LIKE_RE)]
    .map((match) => match[1] || "")
    .filter(Boolean);
  for (const path of explicitPaths) {
    const exact = bundle.changeTargets.find((target) =>
      workspacePathsReferToSameFile(target, path)
    );
    if (exact) return exact;
  }
  // An explicit file reference is a hard claim. Preserve it when it is not
  // grounded so validation can reject a false relative suffix instead of
  // silently assigning it to a different file with the same basename.
  if (explicitPaths[0]) return explicitPaths[0];

  const normalized = text.replace(/\\/g, "/").toLowerCase();
  const basenameMatches = bundle.changeTargets.filter((target) => {
    const path = target.replace(/\\/g, "/").toLowerCase();
    const base = path.split("/").pop() || path;
    return !!base && normalized.includes(base);
  });
  if (basenameMatches.length === 1) return basenameMatches[0];
  return bundle.changeTargets.length === 1 ? bundle.changeTargets[0] : "";
}

export function buildPlanCandidate(input: {
  content: string;
  bundle: PlanEvidenceBundle;
}): PlanCandidate {
  const summary = sectionLines(input.content, /^(?:摘要|目标|用户目标|概述|背景|Summary|Goal|User Goal|Overview|Objective|Background)$/i);
  const findings = sectionLines(input.content, /^(?:已确认证据|已读证据|证据引用|已确认事实|真实发现|发现|当前状态|当前实现|现有架构|项目背景|实现约束|Confirmed Evidence|Read Evidence|Evidence References?|Confirmed Facts|Findings|Current State|Current Implementation|Existing Architecture|Project Context|Implementation Constraints)$/i);
  const changeLines = sectionLines(input.content, /^(?:关键改动|关键实现改动|实现改动|实现方案|实施方案|执行方案|架构改动|设计方案|落地方案|Key Changes|Implementation Changes|Implementation Plan|Implementation|Approach|Architecture Changes|Design Changes|Plan of Work)$/i);
  const changes = changeLines.map((text) => {
    const targetRef = findTargetRef(text, input.bundle);
    const evidenceRefs = input.bundle.facts
      .filter((fact) => !targetRef || workspacePathsReferToSameFile(fact.target, targetRef))
      .map((fact) => fact.id);
    return { text, targetRef, evidenceRefs };
  });
  return {
    bundleHash: input.bundle.hash,
    summary,
    findings,
    changes,
    interfaces: sectionLines(input.content, /^(?:公共\s*API.*|接口|类型|Public APIs?.*|Interfaces?|Types?)$/i),
    tests: sectionLines(input.content, /^(?:测试方案|测试计划|验证方案|验收标准|成功标准|完成标准|Test Plan|Testing|Tests?|Validation|Acceptance Criteria|Success Criteria|Definition of Done)$/i),
    assumptions: sectionLines(input.content, /^(?:假设与默认值|默认假设|假设|默认值|Assumptions.*|Defaults)$/i),
    blockingChoices: sectionLines(input.content, /^(?:阻塞选择|待用户选择|Blocking Choices?|User Choices?)$/i),
  };
}

export function validatePlanCandidate(candidate: PlanCandidate, expectedBundleHash: string): string[] {
  const failures: string[] = [];
  if (!expectedBundleHash || candidate.bundleHash !== expectedBundleHash) failures.push("evidence_bundle_hash_mismatch");
  // PlanCandidate is a best-effort projection used to bind recognized change
  // lines to the frozen evidence bundle. The preceding artifact quality gate
  // already validates a task-appropriate goal, work path, and verification;
  // requiring canonical headings again here would reject valid feature,
  // design, research, and verification plans solely because of their titles.
  if (candidate.changes.some((change) => !change.targetRef || change.evidenceRefs.length === 0)) failures.push("ungrounded_changes");
  return [...new Set(failures)];
}

const NON_EXECUTION_EVIDENCE_TOOLS = new Set([
  "list_directory", "glob_search", "grep_search", "repo_map_status", "repo_map_search",
  "repo_map_context", "repo_map_files", "repo_map_impact", "code_ast_query",
  "find_symbol_references", "git_status", "git_diff", "read_file", "read_document",
  "knowledge_search", "knowledge_get_excerpt", "analyze_tabular_document", "query_tabular_document",
  "index_workspace_documents", "read_pty_buffer", "read_pty_tail", "read_pty_since",
  "get_pty_status", "clear_pty_buffer", "send_pty_input",
]);

const VERIFICATION_EVIDENCE_TOOLS = new Set([
  "read_file", "read_document", "knowledge_search", "knowledge_get_excerpt", "grep_search",
  "code_ast_query", "find_symbol_references", "git_status", "git_diff",
  "read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status",
]);

const COMMAND_EVIDENCE_TOOLS = new Set(["run_command", "execute_command"]);
const PTY_OBSERVATION_EVIDENCE_TOOLS = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);
const WORKSPACE_FILE_REF_RE =
  /(?:^|[\s`"'(（])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s`"',，。；;:)）])/g;
const MAX_EVIDENCE_REFERENCES = 20;

function sourceToolLooksLikeBrowserAutomation(toolName: string): boolean {
  return /(?:browser|playwright|puppeteer|cypress)/i.test(String(toolName || ""));
}

function sourceToolLooksLikeTauriAutomation(toolName: string): boolean {
  return /(?:tauri|desktop|computer|osascript|applescript|webdriver)/i.test(String(toolName || ""));
}

function commandLooksLikeDevServerOrHttpProbe(value: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:dev|preview|vite)\b/i.test(String(value || "")) ||
    /\b(?:vite|webpack-dev-server|next\s+dev)\b/i.test(String(value || "")) ||
    /\bcurl\b[\s\S]{0,120}\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)/i.test(String(value || ""));
}

export function isPlanArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/");
}

export function commandResultLooksSuccessful(toolName: string, result: string): boolean {
  if (!COMMAND_EVIDENCE_TOOLS.has(toolName)) return true;
  try {
    const parsed = JSON.parse(result);
    const exitCode = parsed?.exitCode ?? parsed?.code ?? parsed?.status;
    if (typeof exitCode === "number") return exitCode === 0;
    if (typeof parsed?.success === "boolean") return parsed.success;
  } catch {
    // Plain-text adapters are accepted unless they carry a clear failure marker.
  }
  return !/\b(exit\s*code\s*[=:]\s*[1-9]\d*|command failed|error:)\b/i.test(result);
}

export function browserResultLooksSuccessful(result: string): boolean {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.ok === false || record.success === false) return false;
      if (typeof record.error === "string" && record.error.trim()) return false;
      if (Array.isArray(record.assertions)) {
        return !record.assertions.some((item) =>
          item && typeof item === "object" && (item as Record<string, unknown>).passed === false
        );
      }
    }
  } catch {
    // Plain-text adapters are accepted unless they carry a clear failure marker.
  }
  return !/(?:"ok"\s*:\s*false|"success"\s*:\s*false|browser validation failed|assertion failed|DEV_SERVER_NOT_READY|REPEATED_FAILURE_BLOCKED|navigation timeout|timed?\s*out|page (?:runtime )?error|error:)/i.test(result);
}

export function isPlanExecutionEvidenceTool(toolName: string, target: string): boolean {
  if (NON_EXECUTION_EVIDENCE_TOOLS.has(toolName)) return false;
  if (target && isPlanArtifactPath(target)) return false;
  return true;
}

export function isPlanEvidenceLedgerTool(toolName: string, target: string): boolean {
  if (target && isPlanArtifactPath(target)) return false;
  return isPlanExecutionEvidenceTool(toolName, target) || VERIFICATION_EVIDENCE_TOOLS.has(toolName);
}

function extractWorkspaceFileReferences(...values: string[]): string[] {
  const seen = new Set<string>();
  const references: string[] = [];
  for (const value of values) {
    for (const matched of String(value || "").matchAll(WORKSPACE_FILE_REF_RE)) {
      const candidate = String(matched[1] || "").replace(/\\/g, "/").trim();
      if (!candidate || isPlanArtifactPath(candidate)) continue;
      const key = normalizePlanEvidenceValue(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      references.push(candidate);
      if (references.length >= MAX_EVIDENCE_REFERENCES) return references;
    }
  }
  return references;
}

export function createPlanExecutionEvidenceEntry(input: {
  toolName: string;
  target: string;
  result: string;
  noOp?: boolean;
  diff?: ToolDiffPreview;
}): PlanExecutionEvidenceEntry | null {
  const target = String(input.target || "").trim();
  if (!target || input.noOp || isPlanArtifactPath(target)) return null;
  // Foreground input is a process-lifecycle action, not durable proof of a
  // command, mutation, or validation. Readiness comes from a later PTY
  // observation and workspace completion from a verified diff.
  if (input.toolName === "send_pty_input") return null;
  const timestamp = Date.now();
  const base = {
    id: `evidence-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    value: target,
    target,
    references: extractWorkspaceFileReferences(target, input.result),
    sourceTool: input.toolName,
    createdAt: timestamp,
  };
  if (isWorkspaceMutationToolName(input.toolName)) {
    if (
      EXTERNAL_WORKSPACE_MUTATION_TOOL_NAMES.has(input.toolName) &&
      (!input.diff?.path || !hasResolvedWorkspaceMutationTarget(input.toolName, target))
    ) {
      // Dynamic editor tools may also expose read/inspect actions (notably
      // manage_script). Only a verified changed path/diff is trusted as Plan
      // mutation evidence.
      return null;
    }
    const beforeLines = new Set(String(input.diff?.old || "").split(/\r?\n/));
    const changedText = String(input.diff?.new || "")
      .split(/\r?\n/)
      .filter((line) => !beforeLines.has(line))
      .join("\n");
    const changedIdentifiers = Array.from(new Set(
      Array.from(changedText.matchAll(/[A-Za-z_$][\w$-]*/g), (match) => match[0]),
    )).slice(0, 200);
    return {
      ...base,
      kind: "file",
      ...(changedIdentifiers.length > 0 ? { changedIdentifiers } : {}),
    };
  }
  if (COMMAND_EVIDENCE_TOOLS.has(input.toolName)) {
    if (!commandResultLooksSuccessful(input.toolName, input.result)) {
      if (
        input.toolName !== "run_command" ||
        classifyFailedFiniteValidationOutcome({ result: input.result }) !== "validation_failure"
      ) {
        return null;
      }
      // A validation that really ran but failed is durable negative evidence.
      // Keeping it in the ordered command ledger prevents an unrelated later
      // command from satisfying a generic focused-validation placeholder.
      return {
        ...base,
        kind: "cmd",
        observationStatus: "failed",
      };
    }
    return {
      ...base,
      kind: "cmd",
      ...(input.toolName === "execute_command" && requiresPtyObservationForPlanCommand(target)
        ? { observationStatus: "pending" as const }
        : {}),
    };
  }
  if (PTY_OBSERVATION_EVIDENCE_TOOLS.has(input.toolName)) {
    const observation = analyzePtyObservationResult(input.result);
    return {
      ...base,
      kind: observation.status === "ready" && observation.url ? "dev_server_url" : "tool",
      value: observation.status === "ready" && observation.url ? observation.url : target,
      observationStatus: observation.status,
    };
  }
  if (sourceToolLooksLikeBrowserAutomation(input.toolName)) {
    if (!browserResultLooksSuccessful(input.result)) return null;
    const screenshot = /screenshot|snapshot|capture/i.test(input.toolName) || /screenshot|image|png|jpeg|webp/i.test(input.result);
    return { ...base, kind: screenshot ? "browser_screenshot" : "browser_dom" };
  }
  if (sourceToolLooksLikeTauriAutomation(input.toolName)) return { ...base, kind: "tauri_required" };
  if (VERIFICATION_EVIDENCE_TOOLS.has(input.toolName)) {
    return { ...base, kind: commandLooksLikeDevServerOrHttpProbe(target) ? "dev_server_url" : "tool" };
  }
  return null;
}

export function appendPlanEvidenceEntry(
  ledger: PlanExecutionEvidenceEntry[],
  entry: PlanExecutionEvidenceEntry | null,
): PlanExecutionEvidenceEntry[] {
  if (!entry) return ledger;
  // Process dispatch and terminal observations are ordered events, not stable
  // facts. Keeping only the first identical value lets an old ready state
  // satisfy a later restart, so always retain their latest bounded sequence.
  if (
    entry.sourceTool === "run_command" ||
    entry.sourceTool === "execute_command" ||
    PTY_OBSERVATION_EVIDENCE_TOOLS.has(entry.sourceTool)
  ) {
    return [...ledger, entry].slice(-200);
  }
  const entryKey = `${entry.kind}:${normalizePlanEvidenceValue(entry.value)}:${entry.sourceTool}`;
  if (ledger.some((item) => `${item.kind}:${normalizePlanEvidenceValue(item.value)}:${item.sourceTool}` === entryKey)) {
    return ledger;
  }
  return [...ledger, entry].slice(-200);
}
