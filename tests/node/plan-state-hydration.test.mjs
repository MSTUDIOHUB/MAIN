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

const { resolvePlanStateHydrationReason } = hydration;
const { parseGameStudioSlashCommand } = catalog;

test("plan state hydration prefers explicit existing-plan execution semantics", () => {
  const reason = resolvePlanStateHydrationReason({
    text: "请按照 .MAIN/plans/tasks.md 继续执行",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: null,
  });
  assert.equal(reason, "existing_plan_execution");
});

test("plan state hydration recognizes natural plan resume wording", () => {
  const reason = resolvePlanStateHydrationReason({
    text: "继续完成计划方案",
    hasPlanState: false,
    hasContinuationState: false,
    slashCommand: null,
  });
  assert.equal(reason, "existing_plan_execution");
});

test("plan state hydration triggers for continuation state and execution studio commands", () => {
  const continuation = resolvePlanStateHydrationReason({
    text: "继续",
    hasPlanState: false,
    hasContinuationState: true,
    slashCommand: null,
  });
  assert.equal(continuation, "continuation_state");

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
  assert.match(source, /derivePlanStageFromArtifacts\(\s*hydratedPlan\.artifacts,\s*hydratedPlan\.tasks,\s*false,\s*s\.planStage,\s*\)/);
  assert.match(source, /plan_workspace_hydration_skipped_stale_owner/);
  assert.match(source, /setRightPanelTab:\s*\(tab\)\s*=>\s*\{\s*if \(tab === "plan"\)/);
});

test("ChatArea omits the duplicated effective progress ledger", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");

  assert.match(source, /\{isTurnExpanded && shouldShowTurnActivityNotice && \(/);
  assert.doesNotMatch(source, /getActiveTurnActivity|turn-activity-text|activityText=\{/);
  assert.match(source, /shouldShowTurnActivityNotice =[\s\S]*Boolean\(bottomThoughtSummary\)/);
  assert.doesNotMatch(source, /data-testid="effective-progress-ledger"/);
  assert.doesNotMatch(source, /progressItems=\{effectiveProgressLedger\}/);
  assert.match(source, /data-testid="effective-progress-popover"/);
  assert.match(source, /archived-phase-analysis[\s\S]*archivedAfterChoice: false/);
});

test("plan panel gives a lease-bound paused execution priority over planning continuation", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/RightPanel.tsx"), "utf8");
  const resumeGateStart = source.indexOf("const canResumeExecution =");
  const resumeGateEnd = source.indexOf("const planPresentationRequest", resumeGateStart);
  const resumeGate = source.slice(resumeGateStart, resumeGateEnd);
  const resumeHandlerStart = source.indexOf("const handleResumeExecution = () => {");
  const resumeHandlerEnd = source.indexOf("const handleSavePlanDocument", resumeHandlerStart);
  const resumeHandler = source.slice(resumeHandlerStart, resumeHandlerEnd);

  assert.notEqual(resumeGateStart, -1);
  assert.notEqual(resumeGateEnd, -1);
  assert.match(source, /planLifecycle:\s*useAppStore\(\(s\) => s\.planLifecycle\)/);
  assert.match(resumeGate, /planLifecycle\.status === "paused"/);
  assert.match(resumeGate, /isPlanApprovalLeaseBoundToState\(planLifecycle\)/);
  assert.match(resumeGate, /!activeActionRequest/);
  assert.match(resumeGate, /!isGenerating/);
  assert.match(resumeGate, /!abortController/);
  assert.match(resumeGate, /const canContinuePlanning = !canResumeExecution && canOfferPlanContinuation/);
  assert.doesNotMatch(resumeGate, /isPlanApproved &&/);
  assert.doesNotMatch(resumeGate, /planStage === "executing"/);
  assert.doesNotMatch(resumeGate, /allTrustedComplete/);
  assert.notEqual(resumeHandlerStart, -1);
  assert.notEqual(resumeHandlerEnd, -1);
  assert.match(source, /resumePlanExecution:\s*useAppStore\(\(s\) => s\.resumePlanExecution\)/);
  assert.match(resumeHandler, /resumePlanExecution\(\s*buildTrustedResumePrompt\(\{/);
  assert.doesNotMatch(resumeHandler, /sendMessage\s*\(/);
  assert.doesNotMatch(resumeHandler, /executionConsentGranted:\s*true/);
});

test("store resume replaces a never-started Plan reservation instead of reusing its ghost Run", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const dispatchStart = source.indexOf("export function startApprovedPlanExecutionInCurrentTurn");
  const dispatchEnd = source.indexOf("async function hydrateExistingPlanArtifactsForWorkspace", dispatchStart);
  const dispatchSource = source.slice(dispatchStart, dispatchEnd);
  const resumeStart = source.indexOf("resumePlanExecution: (instruction) => {");
  const resumeEnd = source.indexOf("rejectPlan: (expectedIdentity)", resumeStart);
  const resumeSource = source.slice(resumeStart, resumeEnd);

  assert.notEqual(dispatchStart, -1);
  assert.notEqual(dispatchEnd, -1);
  assert.match(dispatchSource, /reason:\s*"plan_execution_dispatch_failed"/);
  assert.match(dispatchSource, /pendingPlanApprovalHandoff:\s*reservedAttemptPaused \? null : input\.handoff/);
  assert.match(dispatchSource, /planStage:\s*"ready_to_execute"/);
  assert.notEqual(resumeStart, -1);
  assert.notEqual(resumeEnd, -1);
  assert.doesNotMatch(resumeSource, /!lifecycle\.execution\s*\|\|/);
  assert.match(resumeSource, /lifecycle\.execution\?\.runId \|\| lifecycle\.approvalLease\.approvalRunId/);
  assert.match(resumeSource, /executionLeaseId:\s*`plan-execution-resume-\$\{executionRunId\}`/);
  assert.match(resumeSource, /const planTurnAlreadyTerminal =/);
  assert.match(resumeSource, /plan_turn_terminal_owner_revoked_to_discovery/);
  assert.match(resumeSource, /revokePlanLifecycleToDiscovery\(\{/);
  assert.match(resumeSource, /pendingPlanApprovalHandoff:\s*null/);
  assert.match(resumeSource, /currentTurnExecutionConsent:\s*\{ turnId: null, granted: false \}/);
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
    /const hasEarlyGoalAuthority = !!earlyGoalCreationAuthorization \|\|[\s\S]*?!!goalContinuationAuthorization[\s\S]*?const earlyGoalQueuedRunContext =?[\s\S]*?shouldUseEarlyPlanSendGate && hasEarlyGoalAuthority[\s\S]*?runtimeIntentOverride:\s*"goal"[\s\S]*?goalCreationAuthorization:\s*earlyGoalCreationAuthorization[\s\S]*?goalContinuationAuthorization/,
  );
  assert.match(
    source,
    /const shouldUseEarlyPlanSendGate =[\s\S]{0,150}?autoHydrationReason \|\| shouldRouteContinuationToPlanResume[\s\S]*?if \(shouldUseEarlyPlanSendGate\)[\s\S]{0,500}?applyCurrentSendGate\(\s*state,\s*earlyGoalQueuedRunContext,?\s*\)/,
  );
  assert.match(
    source,
    /resumeSubmission:[\s\S]*?refreshedGoalSourceContextSnapshot[\s\S]*?goalSourceContextSnapshot:\s*refreshedGoalSourceContextSnapshot/,
  );
});

test("new empty workspace sessions discover persisted plans without manufacturing approval", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const submitIntentRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitIntentRouting.ts"), "utf8");
  const planExecutionResumeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPlanExecutionResume.ts"), "utf8");
  const appSource = fsSync.readFileSync(path.join(workspaceRoot, "src/App.tsx"), "utf8");

  assert.doesNotMatch(storeSource, /promoteTasksToExecuting/);
  assert.match(storeSource, /isPlanApproved:\s*false,\s*planStage:\s*nextStage/);
  assert.match(submitIntentRoutingSource, /controlAction === "resume_plan_execution"[\s\S]*?startPlanExecutionResume\(\{/);
  assert.match(storeSource, /startPlanExecutionResume: \(resumeRequest\) =>[\s\S]*?runSubmitPlanExecutionResumeEffect\(\{/);
  assert.match(planExecutionResumeSource, /kind:\s*"discovery_only"/);
  assert.match(planExecutionResumeSource, /requiresTurnAdmission:\s*true/);
  assert.match(planExecutionResumeSource, /requiresApproval:\s*true/);
  assert.match(planExecutionResumeSource, /isPlanApproved:\s*false/);
  assert.match(planExecutionResumeSource, /existing_plan_discovered_for_review/);
  assert.doesNotMatch(planExecutionResumeSource, /resumeSubmission/);
  assert.doesNotMatch(planExecutionResumeSource, /executionConsentGranted:\s*true/);
  assert.doesNotMatch(planExecutionResumeSource, /reuseCurrentTurn/);
  assert.doesNotMatch(planExecutionResumeSource, /turnIdOverride/);
  assert.doesNotMatch(planExecutionResumeSource, /existing_plan_hydrated_for_execution/);

  assert.match(appSource, /hydrateWorkspacePlanForEmptySession\("new_session"\)/);
  assert.doesNotMatch(appSource, /promoteTasksToExecuting/);
  assert.match(appSource, /hydrationWorkspace[\s\S]*hydrationSessionKey[\s\S]*saveCurrentRuntimeToSession/);
});
