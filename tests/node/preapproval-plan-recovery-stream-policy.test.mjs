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
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS,
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
  PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS,
  applyPreapprovalPlanQualityRecoveryStreamOptions,
  capPreapprovalPlanQualityRecoveryMaxEscalations,
  capPreapprovalPlanQualityRecoveryMaxTokens,
  resolvePreapprovalPlanQualityRecoveryStreamPolicy,
} = policyModule;

function resolvePolicy(overrides = {}) {
  return resolvePreapprovalPlanQualityRecoveryStreamPolicy({
    workflowMode: "plan",
    isPlanApproved: false,
    planRuntimePhase: "needs_rewrite",
    planQualityRejectCount: 1,
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
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
  );
  assert.equal(
    policy.maxStreamElapsedMs,
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS,
  );
  assert.equal(policy.maxStreamElapsedMs, 120_000);
  assert.equal(policy.maxOutputTokens, 2_048);
  assert.equal(policy.toolChoice, "required");
  assert.equal(
    policy.stopClass,
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS,
  );
});

test("auto scaffold keeps the same single bounded lease and explicit stage", () => {
  const byRejectCount = resolvePolicy({ planQualityRejectCount: 2 });
  const byIssuedPrompt = resolvePolicy({
    planQualityRejectCount: 1,
    planAutoScaffoldPromptIssued: true,
  });

  assert.equal(byRejectCount.stage, "auto_scaffold");
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

  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(policy, undefined), 2_048);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(policy, 1_024), 1_024);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxTokens(policy, 8_192), 2_048);
  assert.equal(capPreapprovalPlanQualityRecoveryMaxEscalations(policy, 3), 0);
  assert.equal(stricterOptions.maxStreamElapsedMs, 45_000);
  assert.equal(stricterOptions.maxStreamElapsedLabel, "stricter_upstream_limit");
  assert.equal(stricterOptions.toolChoice, "required");
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
