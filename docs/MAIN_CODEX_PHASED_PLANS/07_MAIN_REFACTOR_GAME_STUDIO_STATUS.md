# MAIN Refactor And Game Studio Status

## Status: 2026-07-09

This note records the first behavior-equivalent refactor slice for the MAIN architecture and Game Studio plan.

## Stabilized Boundaries

- Pure app/session/task DTOs now live outside the Zustand monolith:
  - `src/lib/appTypes.ts`
  - `src/lib/appConfig.ts`
  - `src/lib/sessionTypes.ts`
  - `src/lib/taskTypes.ts`
  - `src/lib/remoteContextTypes.ts`
  - `src/lib/thoughtCompaction.ts`
- `src/lib/orchestrator/workflowEngine.ts` no longer imports from `src/store/useAppStore.ts`; store-only helpers are injected through `WorkflowEngineStoreHelpers`.
- `src/lib/submit/turnSubmission.ts` owns the first broader pure submit-pipeline slice: pending-review abort decisions, reply-option exact matching, previous-turn reuse, plan hydration signals, intent shortcut parsing, initial effective intent/summary/directive resolution, runtime/display intent selection, execution consent, plan-state reset decisions, send busy/queue/pending-review gate decisions, session bootstrap/run metadata decisions, session bootstrap effect patch construction, turn title/session title seed decisions, semantic metadata request decisions, blocking preflight request/action decisions, local Game Studio slash turn patch construction, visible-turn run-state patch construction, launch harness marker draft construction, local execution-approval decisions, blocking-preflight result interpretation, preflight staleness/resume-option decisions, Game Studio mode-switch decisions, visible-turn patch construction, option archival, and operation proposal patching.
- `src/store/submitRuntimeFacade.ts` owns the store-level runtime facade and elapsed-timer lease for submission runs. This keeps active/background session patching and timer cleanup out of the `sendMessage` body without moving `AbortController` or session runtime ownership into pure submit logic.
- `src/store/submitPreflightExecutor.ts` owns blocking intent-preflight effect execution: running the injected preflight request, checking latest composer/session staleness, applying pending decisions, skipping inactive async resumes, or resuming the original submit with preflight metadata.
- `src/store/submitPendingReviewTransition.ts` owns pending-review interruption effects: aborting the current controller, rejecting the pending review promise, clearing review/tool state, and marking the interrupted source turn as `stopped_no_action` while exact approval reply options stay on the approval path.
- `src/store/submitPlanHydration.ts` owns auto plan hydration effect execution: hydrating existing `.MAIN/plans` artifacts, applying plan state, guarding inactive async resumes, and resubmitting with `skipAutoPlanHydration`.
- `src/store/submitPlanExecutionResume.ts` owns the `resume_plan_execution` control effect: clearing pre-run composer state, hydrating or reusing approved plan artifacts, restoring execution plan state, building the trusted resume prompt, and dispatching the hidden execution turn.
- `src/store/submitAttachmentContext.ts` owns submit-time attachment context construction: external attachment ingest, @ mention/file dedupe, text/document/tabular preview formatting, and failed context-item marking callbacks.
- `src/store/submitPromptContext.ts` owns submit-time prompt augmentation: PLAN mode guardrails, PLAN continuation prompts, unfinished-turn continuation prompts, operation-approval continuation prompts, and turn-intake context prefixing.
- `src/store/submitApprovedPlanExecution.ts` owns approved-plan execution prompt construction, runtime task derivation/normalization, command execution hints, and requested root markdown deliverable detection.
- `src/store/submitSessionBootstrap.ts` owns submit-session bootstrap side effects: auto-session patch application and run-session updated-at/active touch.
- `src/store/submitTitleEffects.ts` owns visible-turn session title seeding and semantic metadata callback handling, including stale callback guards and non-overwrite behavior for manual/semantic session titles.
- `src/store/submitVisibleTurn.ts` owns ordinary visible-turn append, reply-option archival logging, run-state patch application, and context-item failed marking.
- `src/store/submitRunLease.ts` owns agent user-message construction, abort-controller lease creation, goal-start handoff, and harness run marker initialization for a submit run.
- `src/store/submitWorkflowContext.ts` owns initial `WorkflowContext` construction and mutable stream-state defaults for the workflow engine handoff.
- `src/store/submitStreamingUi.ts` owns understanding-progress emission and streaming thought/agent block updates for submit runs.
- `src/store/submitWorkflowEngineRunner.ts` owns workflow-engine helper callback wiring and engine launch for submit runs.
- `src/lib/gameStudio/GameStudioRuntimeService.ts` is the first Game Studio domain facade for initialization, engine configuration, slash command resolution, turn envelope construction, and mode-switch decisions.
- `src/store/gameStudioTurnPreparation.ts` owns store-adjacent Game Studio turn setup: explicit `/setup-engine`, workspace engine auto-configuration, required workflow pack initialization, and turn envelope construction. It depends on an injected runtime service so node tests do not load Vite-only workflow-pack imports.
- `src/store/submitGameStudioPreparation.ts` owns Game Studio preparation result application for submit runs: workspace tree invalidation, runtime patch application, workspace content-version bumps, and failure cleanup that appends the visible system error block and clears active run state.
- `src/store/gameStudioLocalSlashSubmission.ts` owns Game Studio local slash dispatch for `/agent`, `/auto`, and local-fast workflow markdown.
- `src/store/gameStudioLocalSlashBridge.ts` owns Game Studio local slash transcript append, runtime-event emission, and session snapshot persistence.

## Compatibility Shims Kept

- `src/store/useAppStore.ts` still re-exports several moved types and helpers so existing UI/tests do not need a broad migration in the same slice.
- `useAppStore.sendMessage` still owns submission side effects and queue/approve/reset execution of send-gate effects. The new `buildSubmitPipelineDecision`, `resolveSubmitEffectiveIntentDecision`, `resolveSubmitRuntimeDecision`, `resolveSubmitSendGateDecision`, `buildSubmitSessionBootstrapDecision`, `buildSubmitSessionBootstrapPatch`, `resolveSubmitTurnTitleDecision`, `resolveSubmitSemanticMetadataDecision`, `buildSubmitBlockingPreflightEffect`, `resolveSubmitPreflightEffectAction`, `buildSubmitLocalStudioTurnPatch`, `buildSubmitRunStatePatch`, `buildSubmitHarnessRunMarkerDraft`, `resolveSubmitPreflightStalenessDecision`, `buildSubmitPreflightResumeOptions`, `buildSubmitVisibleTurnPatch`, `resolveSubmitExecutionApprovalDecision`, `resolveSubmitPreflightResultDecision`, `createSubmitSessionRuntimeFacade`, `startSubmitElapsedTimer`, `applySubmitPendingReviewTransition`, `runSubmitPlanHydrationEffect`, `startSubmitPlanHydrationEffect`, `runSubmitPlanExecutionResumeEffect`, `buildTrustedPlanResumePrompt`, `buildSubmitAttachmentContext`, `prepareAttachedFileForRead`, `buildSubmitPromptContext`, `buildOperationApprovalContinuationPrompt`, `buildApprovedPlanExecutionPrompt`, `ensureApprovedPlanRuntimeTasksForState`, `normalizeApprovedPlanTaskStatuses`, `applySubmitSessionBootstrap`, `applySubmitVisibleTurn`, `runSubmitGameStudioPreparation`, `applySubmitGameStudioPreparationResult`, `prepareGameStudioTurn`, `executeSubmitBlockingPreflight`, `applySubmitSeedSessionTitle`, `startSubmitSemanticMetadataEffect`, `startSubmitRunLease`, `createSubmitWorkflowContext`, `startSubmitStreamingUi`, `runSubmitWorkflowEngine`, `createGameStudioLocalSlashBridge`, and `startGameStudioLocalSlashSubmission` helpers are the intended boundary for continuing Phase 2 without changing the public store hook.
- Game Studio pack/doc/runtime primitives still have legacy exports in `src/lib/gameStudioPack.ts`; the new service facade is the intended narrow entry point for future store/UI migration.
- `src/lib/e2e.ts` is still allowed to import `useAppStore` as the test bridge exception.

## Behavior Notes

- Normal MAIN mode can still handle game-development tasks.
- Game Studio remains a workspace-local workflow pack, not a replacement for MAIN general execution.
- Local-fast Game Studio slash help bypasses execution approval and renders command markdown directly in the transcript.
- `game_studio_local_markdown` is visible transcript output and is not folded into process timelines.
- Awaiting-input turns keep effective progress visible without showing a stale running-tool state.

## Pending Phases

- Phase 2 has a test-covered pure-decision/effect-plan boundary for reply-option reuse, pending-review interruption effects, plan hydration decisions and auto hydration execution, trusted plan execution resume, submit attachment context construction, submit prompt augmentation, approved-plan execution prompt/runtime task construction, intent shortcuts, effective intent resolution, auto-approve execution forcing, runtime/display intent selection, execution consent, plan-state reset decisions, send busy/queue/pending-review gates, session bootstrap/run metadata, temporary-session bootstrap patching and store-side application, turn title/session title seed decisions, semantic metadata request planning and callback execution, blocking preflight request/action planning and execution, local Game Studio slash turn patch construction, dispatch, transcript persistence, ordinary visible-turn append/run-state application, launch harness marker draft construction and run lease creation, initial WorkflowContext construction, streaming UI ownership, workflow-engine callback wiring, store runtime facade/timer ownership, preflight stale/resume handling, visible-turn patch construction, local execution-approval prompts, blocking-preflight outcomes, Game Studio mode switching, Game Studio setup/envelope preparation, and Game Studio preparation result application/failure cleanup. Remaining Phase 2 work is to move additional small effect execution out of `useAppStore.sendMessage`, then reduce the method toward the 300-500 line target.
- Phase 3 still needs `AgentOrchestrator.execute` split into runtime state, turn preparation, stream invocation, tool planning, tool execution, recovery, and completion guards.
- Phase 5 still needs `Composer`, `ChatArea`, `SettingsModal`, and e2e scenario seed decomposition after runtime boundaries settle.

## Verification

- `npm run build`
- `npm run test:workflow-assets` (886 node tests)
- `node --test --test-reporter=dot tests/node/*.test.mjs` (886 node tests)
- `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts -g "existing .MAIN/plans execution hydrates approved plan and exposes execute tools|approved plan resumes with execute runtime tools while preserving plan turn identity"` (2 tests)
- `npx playwright test tests/e2e/plan-reload-resume.spec.ts` (1 test)
- `npx playwright test tests/e2e/awaiting-choice.spec.ts tests/e2e/streaming-timer.spec.ts` (8 tests)
- `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts -g "plain fix request shows operation approval before execute tools|workspace-external local file reads request approval before ingesting and reading|plan executable reply options are ignored when the same turn has tool calls"` (3 tests)
- `npx playwright test tests/e2e/streaming-timer.spec.ts tests/e2e/game-studio-onboarding.spec.ts tests/e2e/game-studio-plan-shortcuts.spec.ts tests/e2e/game-studio-tool-group-collapse.spec.ts` (16 tests)
- `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts -g "game studio execute reply resumes the source turn with studio workflow tools"`
