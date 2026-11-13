import { expect, test } from "@playwright/test";
import { installCapsuleFixtureStartup } from "./capsuleFixtureStartup";
import type { RuntimeV2EventDraft, RuntimeV2RunIdentity, RuntimeV2TurnIdentity, TurnAggregateV1 } from "../../src/lib/runtime-v2";

test("approved plan sidebar keeps progress compact and sends the exact review authority to continuation and revision", async ({ page }) => {
  await installCapsuleFixtureStartup(page);
  await page.goto("/?e2eScenario=plan-reload-resume");
  await expect(page.getByTestId("plan-review-panel")).toBeVisible();

  const expected = await page.evaluate(async () => {
    const storeUrl = performance.getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname === "/src/store/useAppStore.ts")
      .at(-1)?.name ?? "/src/store/useAppStore.ts";
    const [store, runtime, adapter, { sha256Hex }] = await Promise.all([
      import(storeUrl) as Promise<typeof import("/src/store/useAppStore.ts")>,
      import("/src/lib/runtime-v2/index.ts"),
      import("/src/store/runtimeV2/workPlanAdapter.ts"),
      import("/src/lib/sha256.ts"),
    ]);
    const state = store.useAppStore.getState();
    const workspaceKey = store.resolveSessionWorkspaceKey(state.currentWorkspace);
    const sessionKey = store.resolveSessionRuntimeKey(workspaceKey, state.currentSessionId)!;
    const sessionEpoch = state.sessionsByWorkspace[workspaceKey]
      .find((session) => session.id === state.currentSessionId)!.planLifecycleEpoch!;
    const turn: RuntimeV2TurnIdentity = {
      workspaceKey, sessionKey, sessionEpoch, turnId: "sidebar-plan", clientSubmissionId: "sidebar-plan-submission",
    };
    const identity = (owner: RuntimeV2TurnIdentity): RuntimeV2RunIdentity => ({
      sessionKey, sessionEpoch, turnId: owner.turnId, runId: `${owner.turnId}-run`,
      parentRunId: null, attemptId: `${owner.turnId}-attempt`,
    });
    const run = identity(turn);
    const objective = "交付游戏脚本和测试";
    const plan = runtime.sealWorkPlanV1({
      id: "sidebar-work-plan", revision: 1, createdAt: 2, evidence: [],
      draft: {
        schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION, objective, summary: objective, findings: [],
        steps: [
          { title: "创建游戏脚本", operation: "create", targets: ["game.py"], basis: [], change: "创建游戏", expectedOutcome: "游戏可运行", dependsOn: [] },
          { title: "创建测试", operation: "create", targets: ["test_game.py"], basis: [], change: "创建测试", expectedOutcome: "覆盖游戏", dependsOn: [0] },
        ],
        validations: [{ stepIndexes: [0, 1], kind: "finite_command", command: "python3 -m unittest -v", cwd: ".", expectedOutcome: "全部游戏测试通过", required: true }],
        risks: [], assumptions: [], blockingQuestions: [],
      },
    });
    const documentFor = (owner: RuntimeV2TurnIdentity, sealed: typeof plan) => ({
      owner: { workspace: workspaceKey, sessionKey, sessionEpoch, turnId: owner.turnId },
      documentId: owner.turnId, revision: 1, contentHash: sha256Hex(sealed.markdown),
      path: `.MAIN/plans/${owner.turnId}/rev-1.md`, title: sealed.draft.objective, kind: "plan" as const,
    });
    const documentRef = documentFor(turn, plan);
    const commit = adapter.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: "sidebar-review", createdAt: 3, documentRef });
    const reference = adapter.toRuntimeV2WorkPlanReference(plan, "pending_review");
    const savedDocument = (run: RuntimeV2RunIdentity, sealed: typeof plan, document: typeof documentRef): RuntimeV2EventDraft[] => {
      const idempotencyKey = `${run.runId}-document`;
      return [
        { type: "command.scheduled", run, command: { idempotencyKey, run, kind: "execute_tool", phase: "planning",
          payload: { toolName: "save_plan_document", runtimeOwnedPlanArtifact: true } } },
        { type: "tool.completed", run, idempotencyKey, status: "succeeded", evidence: [],
          modelContent: JSON.stringify({ planDocument: document, markdown: sealed.markdown }) },
      ];
    };
    const build = (owner: RuntimeV2TurnIdentity, drafts: RuntimeV2EventDraft[]) => {
      const aggregate = drafts.reduce<TurnAggregateV1 | null>((aggregate, event, sequence) => runtime.transition(aggregate, {
        ...event, sequence, at: sequence + 1, eventId: `${owner.turnId}-${sequence}`, schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      }), null)!;
      return runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
    };
    const close = (owner: RuntimeV2TurnIdentity, kind: "canceled" | "blocked"): RuntimeV2EventDraft[] => {
      const run = identity(owner);
      const outcome = { resultKind: kind, reason: kind === "canceled" ? "user_cancelled" : "workspace_changed",
        completedAt: 20, finalProjectionId: `${owner.turnId}-final` };
      const projection = { id: outcome.finalProjectionId, audience: "final", kind: "final", markdown: outcome.reason, dedupeKey: outcome.finalProjectionId } as const;
      return [
        ...(kind === "canceled" ? [{ type: "run.aborted" as const, run, reason: outcome.reason }] : []),
        { type: "run.completed", run, outcome },
        { type: "projection.published", run, audience: "final", projectionId: projection.id, projection },
        { type: "turn.completed", turn: owner, runId: run.runId, outcome },
      ];
    };
    const source = build(turn, [
      { type: "turn.admitted", turn, strategy: "plan", objective, constraints: [], acceptanceCriteria: [] },
      { type: "run.started", run, phase: "planning" },
      ...savedDocument(run, plan, documentRef),
      { type: "work_plan.sealed", run, workPlan: reference, sealedPlan: plan, reviewCommit: commit },
      { type: "work_plan.approved", run, workPlan: { ...reference, status: "approved" } },
      { type: "command.scheduled", run, command: { idempotencyKey: "sidebar-write", run, kind: "execute_tool", phase: "preparing",
        payload: { toolName: "write_file", arguments: { path: "game.py", content: "print(1)" } } } },
      { type: "tool.completed", run, idempotencyKey: "sidebar-write", status: "succeeded",
        evidence: [{ id: "sidebar-write-receipt", kind: "mutation", target: "game.py", version: "game-v1" }] },
      ...close(turn, "canceled"),
    ]);
    const approvalEventId = source.aggregate.events.find((event) => event.type === "work_plan.approved")!.eventId;
    const makeConversationTurn = (owner: RuntimeV2TurnIdentity) => ({
      id: owner.turnId, clientSubmissionId: owner.clientSubmissionId, userPrompt: objective, title: objective,
      intent: "plan", mode: "plan", status: "done", summary: "", blockIds: [], collapsed: false, createdAt: 1,
    } as const);
    const original = { ...makeConversationTurn(turn), planDocument: documentRef, blockIds: [] };
    const attempts: unknown[] = [];
    (window as any).__APPROVED_PLAN_SIDEBAR_ATTEMPTS__ = attempts;
    store.useAppStore.setState({
      currentTurnId: turn.turnId, conversationTurns: [original],
      planStage: "ready_to_execute", showPlanPanel: true, rightPanelTab: "plan",
      runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: source }),
      isGenerating: false, agentStatus: "idle", activeActionRequest: null, abortController: null,
      async continueApprovedWorkPlan(sourceTurnId, authority) {
        attempts.push({ action: "continue", sourceTurnId, authority });
        const driftTurn = { ...turn, turnId: "sidebar-drift", clientSubmissionId: "sidebar-drift-submission" };
        const driftRun = identity(driftTurn);
        const drift = build(driftTurn, [
          { type: "turn.admitted", turn: driftTurn, strategy: "plan", objective, constraints: [], acceptanceCriteria: [] },
          { type: "run.started", run: driftRun, phase: "preparing" },
          { type: "observation.recorded", run: driftRun,
            evidence: { id: "approved-plan-drift:game.py", kind: "tool", target: "game.py", version: null } },
          ...close(driftTurn, "blocked"),
        ]);
        store.useAppStore.setState({
          conversationTurns: [original, {
            ...makeConversationTurn(driftTurn), intent: "execute", mode: "edit",
            runtimeOutcome: { status: "completed", resultKind: "blocked", reason: "workspace_changed",
              runId: driftRun.runId, parentRunId: null, updatedAt: 20 },
            approvedPlanContinuation: { turn, authority, approvalEventId },
          }],
          runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: source, [driftTurn.turnId]: drift }),
        });
        return true;
      },
      async reviseApprovedWorkPlan(sourceTurnId, authority) {
        attempts.push({ action: "revise", sourceTurnId, authority });
        const revisionTurn = { ...turn, turnId: "sidebar-revision", clientSubmissionId: "sidebar-revision-submission" };
        const revisionRun = identity(revisionTurn);
        const revisedPlan = runtime.sealWorkPlanV1({
          id: plan.id, revision: plan.revision + 1, createdAt: 21, evidence: [],
          draft: {
            ...plan.draft, objective: "修订后补齐游戏测试",
            steps: [{ ...plan.draft.steps[1], dependsOn: [] }],
            validations: plan.draft.validations.map((validation) => ({ ...validation, stepIndexes: [0] })),
          },
        });
        const revisedDocument = documentFor(revisionTurn, revisedPlan);
        const revisedCommit = adapter.createRuntimeV2PlanReviewCommit({
          plan: revisedPlan, turn: revisionTurn, run: revisionRun, requestId: "sidebar-revised-review",
          createdAt: 22, documentRef: revisedDocument,
        });
        const revisedReference = adapter.toRuntimeV2WorkPlanReference(revisedPlan, "pending_review");
        const revision = build(revisionTurn, [
          { type: "turn.admitted", turn: revisionTurn, strategy: "plan", objective: revisedPlan.draft.objective, constraints: [], acceptanceCriteria: [] },
          { type: "run.started", run: revisionRun, phase: "planning" },
          ...savedDocument(revisionRun, revisedPlan, revisedDocument),
          { type: "work_plan.sealed", run: revisionRun, workPlan: revisedReference, sealedPlan: revisedPlan, reviewCommit: revisedCommit },
          { type: "work_plan.approved", run: revisionRun, workPlan: { ...revisedReference, status: "approved" } },
        ]);
        store.useAppStore.setState((current) => ({
          conversationTurns: [...current.conversationTurns, {
            ...makeConversationTurn(revisionTurn), blockIds: [], status: "executing", planDocument: revisedDocument,
            approvedPlanContinuation: { turn, authority, approvalEventId, revise: true },
          }],
          currentTurnId: revisionTurn.turnId,
          runtimeV2Checkpoints: { ...current.runtimeV2Checkpoints, [revisionTurn.turnId]: revision },
        }));
        return true;
      },
    });
    return { sourceTurnId: turn.turnId, authority: commit.authority };
  });

  const originalTurn = page.locator('section[data-turn-id="sidebar-plan"]');
  await expect(originalTurn.getByTestId("turn-intent-badge-plan")).toHaveText("计划");
  const progress = page.getByTestId("plan-task-progress-toggle");
  await expect(progress).toContainText("1/2");
  await expect(progress).toContainText("必需验证 0/1");
  await expect(progress).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("plan-task-row")).toHaveCount(0);
  await progress.press("Space");
  await expect(page.getByTestId("plan-task-status")).toHaveText(["已实施", "待执行"]);
  await expect(page.getByTestId("plan-required-validations")).toContainText("待验证");
  await progress.click();

  const continueButton = page.getByTestId("continue-approved-work-plan");
  await expect(continueButton).toHaveText("继续完成");
  await continueButton.click();
  await expect(page.getByTestId("approved-work-plan-issues")).toContainText("game.py");
  const continuedTurn = page.locator('section[data-turn-id="sidebar-drift"]');
  await expect(continuedTurn.getByTestId("turn-state-anchor")).toBeVisible();
  await expect(continuedTurn.getByTestId("turn-intent-badge-plan-revision")).toHaveCount(0);
  await expect(progress).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("revise-approved-work-plan").click();
  expect(await page.evaluate(() => (window as any).__APPROVED_PLAN_SIDEBAR_ATTEMPTS__)).toEqual([
    { action: "continue", ...expected },
    { action: "revise", ...expected },
  ]);
  const panel = page.getByTestId("plan-review-panel");
  await expect(panel).toHaveAttribute("data-turn-id", "sidebar-revision");
  const revisedTurn = page.locator('section[data-turn-id="sidebar-revision"]');
  await expect(revisedTurn.getByTestId("turn-intent-badge-plan-revision")).toHaveText("复核修订");
  await expect(revisedTurn.getByTestId("turn-intent-badge-plan")).toHaveCount(0);
  await expect(panel).toContainText("修订后补齐游戏测试");
  await expect(progress).toContainText("0/1");
  await expect(progress).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("approved-work-plan-issues")).toHaveCount(0);
  await expect(page.getByTestId("continue-approved-work-plan")).toHaveCount(0);
});
