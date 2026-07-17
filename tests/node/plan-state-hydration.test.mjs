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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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

const hydration = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planStateHydration.ts"));
const catalog = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/gameStudio/catalog.ts"));

const { resolvePlanStateHydrationReason, shouldPromoteHydratedPlanToExecuting } = hydration;
const { parseGameStudioSlashCommand } = catalog;

test("plan state hydration prefers explicit existing-plan execution semantics", () => {
  const reason = resolvePlanStateHydrationReason({
    text: "请按照 .MAIN/plans/tasks.md 继续执行",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: null,
  });
  assert.equal(reason, "existing_plan_execution");
  assert.equal(shouldPromoteHydratedPlanToExecuting(reason), true);
});

test("plan state hydration recognizes natural plan resume wording", () => {
  const reason = resolvePlanStateHydrationReason({
    text: "继续完成计划方案",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: null,
  });
  assert.equal(reason, "existing_plan_execution");
  assert.equal(shouldPromoteHydratedPlanToExecuting(reason), true);
});

test("plan state hydration triggers for continuation state and execution studio commands", () => {
  const continuation = resolvePlanStateHydrationReason({
    text: "继续",
    hasPlanState: false,
    hasContinuationState: true,
    slashCommand: null,
  });
  assert.equal(continuation, "continuation_state");
  assert.equal(shouldPromoteHydratedPlanToExecuting(continuation), true);

  const execCmd = resolvePlanStateHydrationReason({
    text: "/dev-story",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: parseGameStudioSlashCommand("/dev-story"),
  });
  assert.equal(execCmd, "studio_execution_command");
});

test("plan state hydration remains conservative when plan state already exists or command is non-execution", () => {
  const alreadyHasState = resolvePlanStateHydrationReason({
    text: "继续执行",
    hasPlanState: true,
    hasContinuationState: true,
    slashCommand: parseGameStudioSlashCommand("/dev-story"),
  });
  assert.equal(alreadyHasState, null);

  const nonExecStudioCommand = resolvePlanStateHydrationReason({
    text: "/help",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: parseGameStudioSlashCommand("/help"),
  });
  assert.equal(nonExecStudioCommand, null);
});

test("plan panel open path hydrates artifacts without auto-approving execution", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");

  assert.match(source, /ensurePlanArtifactsHydratedForWorkspace:\s*async/);
  assert.match(source, /openPlanWorkspacePanel:\s*async/);
  assert.match(source, /actualPathByCanonicalPath/);
  assert.match(source, /\.MAIN\/plans\/\$\{entry\.name\}/);
  assert.match(source, /derivePlanStageFromArtifacts\(\s*hydratedPlan\.artifacts,\s*hydratedPlan\.tasks,\s*s\.isPlanApproved,\s*s\.planStage,\s*\)/);
  assert.match(source, /setRightPanelTab:\s*\(tab\)\s*=>\s*\{\s*if \(tab === "plan"\)/);
});

test("ChatArea omits the duplicated effective progress ledger", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");

  assert.match(source, /\{isTurnExpanded && shouldShowTurnActivityNotice && \(/);
  assert.doesNotMatch(source, /data-testid="effective-progress-ledger"/);
  assert.doesNotMatch(source, /progressItems=\{effectiveProgressLedger\}/);
  assert.match(source, /data-testid="effective-progress-popover"/);
  assert.match(source, /archived-phase-analysis[\s\S]*archivedAfterChoice: false/);
});

test("plan panel keeps resume action available for paused approved execution", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/RightPanel.tsx"), "utf8");

  assert.match(source, /const canResumeExecution =[\s\S]*?isPlanApproved[\s\S]*?planStage === "executing"[\s\S]*?\(agentStatus === "idle" \|\| agentStatus === "error"\);/);
  assert.doesNotMatch(source, /canResumeExecution[\s\S]*?allTrustedComplete/);
  assert.match(source, /resolvedIntent:\s*"execute"/);
  assert.doesNotMatch(source, /runtimeIntentOverride:\s*"execute"/);
  assert.match(source, /executionConsentGranted:\s*true/);
  assert.match(source, /createVisibleTurnForHiddenMessage:\s*!resumeTurnId/);
  assert.match(source, /reuseCurrentTurn:\s*!!resumeTurnId/);
});

test("plan UI distinguishes a candidate from an executable artifact without guessing failure", () => {
  const rightPanelSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/RightPanel.tsx"), "utf8");
  const planPanelSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/PlanPanel.tsx"), "utf8");
  const chatAreaSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");

  assert.match(rightPanelSource, /selectLatestPlanCandidatePreview\(latestPlanEntry\.blocks\)/);
  assert.match(planPanelSource, /data-plan-document-kind=/);
  assert.match(planPanelSource, /这是模型生成的候选草稿，尚未形成通过校验的正式计划，不能审批或执行/);
  assert.doesNotMatch(planPanelSource, /候选草稿未通过计划校验/);
  assert.match(chatAreaSource, /计划草稿未通过校验/);
  assert.match(chatAreaSource, /block\.variant === "plan_quality_gate"/);
  assert.match(chatAreaSource, /hasReviewablePlanArtifact && turn\.id === planArtifactOwnerTurnId/);
});

test("early Plan hydration busy gate retains validated Goal authority and refreshes its source context", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");

  assert.match(
    source,
    /const hasEarlyGoalAuthority = !!earlyGoalCreationAuthorization \|\|[\s\S]*?!!goalContinuationAuthorization[\s\S]*?const earlyGoalQueuedWorkflowContext =?[\s\S]*?shouldUseEarlyPlanSendGate && hasEarlyGoalAuthority[\s\S]*?runtimeIntentOverride:\s*"goal"[\s\S]*?goalCreationAuthorization:\s*earlyGoalCreationAuthorization[\s\S]*?goalContinuationAuthorization/,
  );
  assert.match(
    source,
    /const shouldUseEarlyPlanSendGate =[\s\S]{0,150}?autoHydrationReason \|\| shouldRouteContinuationToPlanResume[\s\S]*?if \(shouldUseEarlyPlanSendGate\)[\s\S]{0,500}?applyCurrentSendGate\(\s*state,\s*earlyGoalQueuedWorkflowContext,?\s*\)/,
  );
  assert.match(
    source,
    /resumeSubmission:[\s\S]*?refreshedGoalSourceContextSnapshot[\s\S]*?goalSourceContextSnapshot:\s*refreshedGoalSourceContextSnapshot/,
  );
});

test("new empty workspace sessions hydrate persisted plan tasks into resumable execution state", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const submitIntentRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitIntentRouting.ts"), "utf8");
  const planExecutionResumeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPlanExecutionResume.ts"), "utf8");
  const appSource = fsSync.readFileSync(path.join(workspaceRoot, "src/App.tsx"), "utf8");

  assert.match(storeSource, /promoteTasksToExecuting\?:\s*boolean/);
  assert.match(storeSource, /options\.promoteTasksToExecuting === true[\s\S]*?hydratedPlan\.hasTasksArtifact[\s\S]*?hydratedPlan\.tasks\.length > 0/);
  assert.match(storeSource, /isPlanApproved:\s*shouldPromoteHydratedTasksToExecuting \|\| s\.isPlanApproved/);
  assert.match(storeSource, /planStage:\s*shouldPromoteHydratedTasksToExecuting \? "executing" : nextStage/);
  assert.match(submitIntentRoutingSource, /controlAction === "resume_plan_execution"[\s\S]*?startPlanExecutionResume\(\{/);
  assert.match(storeSource, /startPlanExecutionResume: \(resumeRequest\) =>[\s\S]*?runSubmitPlanExecutionResumeEffect\(\{/);
  assert.match(planExecutionResumeSource, /createVisibleTurnForHiddenMessage:\s*!continuationTurnId/);
  assert.match(planExecutionResumeSource, /reuseCurrentTurn:\s*!!continuationTurnId/);
  assert.match(planExecutionResumeSource, /turnIdOverride:\s*continuationTurnId/);
  assert.match(planExecutionResumeSource, /existing_plan_hydrated_for_execution/);

  assert.match(appSource, /hydrateWorkspacePlanForEmptySession\("new_session"\)/);
  assert.match(appSource, /promoteTasksToExecuting:\s*true/);
});
