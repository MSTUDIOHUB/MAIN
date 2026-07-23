import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const policyModule = loadTranspiledModuleSync(path.join(
  workspaceRoot,
  "src/lib/orchestrator/loop/preapprovalPlanRecoveryStreamPolicy.ts",
));
const {
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS,
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS,
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS,
  applyPreapprovalPlanQualityRecoveryStreamOptions,
  capPreapprovalPlanQualityRecoveryMaxEscalations,
  capPreapprovalPlanQualityRecoveryMaxTokens,
  resolvePreapprovalPlanQualityRecoveryOutputTokens,
  resolvePreapprovalPlanQualityRecoveryStreamPolicy,
} = policyModule;

function resolvePolicy(overrides = {}) {
  return resolvePreapprovalPlanQualityRecoveryStreamPolicy({
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "needs_rewrite",
    planAutoScaffoldPromptIssued: false,
    llmToolNames: ["replace_in_file", "write_file"],
    forceXmlTools: false,
    ...overrides,
  });
}

test("preapproval plan rewrite gets one provider-neutral bounded stream lease", () => {
  const policy = resolvePolicy();

  assert.equal(policy.active, true);
  assert.equal(policy.stage, "rewrite");
  assert.equal(
    policy.maxOutputTokens,
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS,
  );
  assert.equal(
    policy.maxStreamElapsedMs,
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS,
  );
  assert.equal(policy.maxStreamElapsedMs, 120_000);
  assert.equal(policy.maxOutputTokens, 4_096);
  assert.equal(policy.toolChoice, undefined);
  assert.equal(
    policy.stopClass,
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS,
  );
});

test("auto scaffold keeps the same single bounded lease and explicit stage", () => {
  const byIssuedPrompt = resolvePolicy({
    planAutoScaffoldPromptIssued: true,
  });

  assert.equal(byIssuedPrompt.stage, "auto_scaffold");
  assert.match(
    byIssuedPrompt.maxStreamElapsedLabel,
    /preapproval_plan_quality_recovery_auto_scaffold/,
  );
});

test("XML fallback remains bounded without requesting unavailable native tools", () => {
  const policy = resolvePolicy({ forceXmlTools: true });
  const options = applyPreapprovalPlanQualityRecoveryStreamOptions(
    policy,
    { workflowMode: "plan", runtimeIntent: "plan" },
    0,
  );

  assert.equal(policy.active, true);
  assert.equal(policy.toolChoice, undefined);
  assert.equal(options.toolChoice, undefined);
  assert.equal(options.maxStreamElapsedMs, 120_000);
});

test("rewrite finalization never manufactures a native write-tool requirement", () => {
  const policy = resolvePolicy({
    llmToolNames: ["write_file", "replace_in_file"],
    forceXmlTools: false,
  });
  const options = applyPreapprovalPlanQualityRecoveryStreamOptions(
    policy,
    { workflowMode: "plan", runtimeIntent: "plan" },
    2,
  );

  assert.equal(policy.toolChoice, undefined);
  assert.equal(options.toolChoice, undefined);
});

test("rewrite requires the exact native typed Plan submission surface", () => {
  const policy = resolvePolicy({
    llmToolNames: ["submit_plan_candidate"],
    forceXmlTools: false,
  });
  const options = applyPreapprovalPlanQualityRecoveryStreamOptions(
    policy,
    { workflowMode: "plan", runtimeIntent: "plan" },
    1,
  );

  assert.equal(policy.toolChoice, "required");
  assert.equal(options.toolChoice, "required");
});

test("non-rewrite plan phases and approved execution are not capped", () => {
  const grounding = resolvePolicy({ planRuntimePhase: "grounding" });
  const approved = resolvePolicy({ isPlanApproved: true });

  assert.equal(grounding.active, false);
  assert.equal(approved.active, false);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(grounding, 8_192), 8_192);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxEscalations(grounding, 2), 2);
});

test("rewrite bounds preserve stricter upstream limits and prohibit escalation", () => {
  const policy = resolvePolicy();
  const stricterOptions = applyPreapprovalPlanQualityRecoveryStreamOptions(
    policy,
    {
      maxStreamElapsedMs: 45_000,
      maxStreamElapsedLabel: "stricter_upstream_limit",
      toolChoice: "required",
    },
    2,
  );

  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(policy, undefined), 4_096);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(policy, 1_024), 1_024);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(policy, 8_192), 4_096);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxEscalations(policy, 3), 0);
  assert.equal(stricterOptions.maxStreamElapsedMs, 45_000);
  assert.equal(stricterOptions.maxStreamElapsedLabel, "stricter_upstream_limit");
  assert.equal(stricterOptions.toolChoice, "required");
});

test("long multi-facet rewrites receive an adaptive lease with a hard ceiling", () => {
  const graphSize = {
    goals: 18,
    evidence: 48,
    changes: 24,
    validations: 18,
    interfaces: 12,
  };
  const policy = resolvePolicy({ graphSize });

  assert.equal(
    resolvePreapprovalPlanQualityRecoveryOutputTokens(graphSize),
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
  );
  assert.equal(policy.maxOutputTokens, 8_192);
  assert.equal(
    capPreapprovalPlanQualityRecoveryMaxTokens(policy, 16_384),
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
  );
  assert.equal(capPreapprovalPlanQualityRecoveryMaxEscalations(policy, 3), 0);

  const compact = resolvePolicy({
    graphSize: { goals: 1, evidence: 0, changes: 0, validations: 1, interfaces: 0 },
  });
  assert.ok(compact.maxOutputTokens >= PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS);
  assert.ok(compact.maxOutputTokens < policy.maxOutputTokens);
});

test("stream pipeline applies the preapproval policy to initial and retry calls", () => {
  const preparationSource = fsSync.readFileSync(path.join(
    workspaceRoot,
    "src/lib/orchestrator/loop/iterationStreamPreparation.ts",
  ), "utf8");
  const invocationSource = fsSync.readFileSync(path.join(
    workspaceRoot,
    "src/lib/orchestrator/loop/streamInvocation.ts",
  ), "utf8");
  const recoverySource = fsSync.readFileSync(path.join(
    workspaceRoot,
    "src/lib/orchestrator/loop/streamRecovery.ts",
  ), "utf8");

  assert.match(preparationSource, /resolvePreapprovalPlanQualityRecoveryStreamPolicy\(\{/);
  assert.match(invocationSource, /effectiveCurrentMaxTokens/);
  assert.match(invocationSource, /preapprovalPlanQualityRecoveryToolChoice/);
  assert.match(recoverySource, /capRecoveryMaxTokens/);
  assert.match(recoverySource, /capRecoveryMaxEscalations/);
  assert.match(recoverySource, /applyRecoveryStreamOptions/);
  assert.match(
    recoverySource,
    /PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS/,
  );
});
