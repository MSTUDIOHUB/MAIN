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
- `src/lib/submit/turnSubmission.ts` owns the first broader pure submit-pipeline slice: submit input envelope construction, pending-review abort decisions, reply-option exact matching, previous-turn reuse, plan hydration signals, intent shortcut parsing, intent-confirmation pending decision construction, initial effective intent/summary/directive resolution, runtime/display intent selection, execution consent, plan-state reset decisions, send busy/queue/pending-review gate decisions, session bootstrap/run metadata decisions, session bootstrap effect patch construction, turn title/session title seed decisions, semantic metadata request decisions, blocking preflight request/action decisions, local Game Studio slash turn patch construction, visible-turn run-state patch construction, launch harness marker draft construction, local execution-approval decisions, blocking-preflight result interpretation, preflight staleness/resume-option decisions, Game Studio mode-switch decisions, visible-turn patch construction, option archival, and operation proposal patching.
- `src/store/submitRuntimeFacade.ts` owns the store-level runtime facade, pre-run session patcher, and elapsed-timer lease for submission runs. This keeps active/background session patching and timer cleanup out of the `sendMessage` body without moving `AbortController` or session runtime ownership into pure submit logic.
- `src/store/submitSessionRuntimeController.ts` owns submit-run scoped state wiring: decorated conversation-turn callbacks, plan task/artifact runtime updates, plan panel opening, current intent lookup, and active/background runtime callback routing.
- `src/store/submitPreflightExecutor.ts` owns blocking intent-preflight effect startup and execution: running the injected preflight request, checking latest composer/session staleness, applying pending decisions through the pre-run session patcher, skipping inactive async resumes, or resuming the original submit with preflight metadata.
- `src/store/submitPendingReviewTransition.ts` owns pending-review interruption effects: aborting the current controller, rejecting the pending review promise, clearing review/tool state, and marking the interrupted source turn as `stopped_no_action` while exact approval reply options stay on the approval path.
- `src/store/submitPlanStateReset.ts` owns submit-time approved-plan runtime reset effects for new requests when the pure runtime decision says plan state should not be preserved.
- `src/store/submitSendGateEffects.ts` owns send-gate effect execution: busy/hidden allowance logging, empty-input blocking, queueing visible submissions with context snapshots, pending-review approval bypass, and stuck running/pending-review reset while the pure decision remains in `src/lib/submit/turnSubmission.ts`.
- `src/store/submitIntentRouting.ts` owns submit-time intent-routing effects: initial effective-intent wiring, same-draft pending-decision suppression, reused-turn execution escalation, plan approval/resume control actions, local execution-approval prompts, and blocking preflight startup while pure intent decisions remain in `src/lib/submit/turnSubmission.ts`.
- `src/store/submitPlanHydration.ts` owns auto plan hydration effect execution: hydrating existing `.MAIN/plans` artifacts, applying plan state, guarding inactive async resumes, and resubmitting with `skipAutoPlanHydration`.
- `src/store/submitPlanExecutionResume.ts` owns the `resume_plan_execution` control effect: clearing pre-run composer state, hydrating or reusing approved plan artifacts, restoring execution plan state, building the trusted resume prompt, and dispatching the hidden execution turn.
- `src/store/submitAttachmentContext.ts` owns submit-time attachment context construction: external attachment ingest, @ mention/file dedupe, text/document/tabular preview formatting, and failed context-item marking callbacks.
- `src/store/submitPromptContext.ts` owns submit-time prompt augmentation: PLAN mode guardrails, PLAN continuation prompts, unfinished-turn continuation prompts, operation-approval continuation prompts, and turn-intake context prefixing.
- `src/store/submitApprovedPlanExecution.ts` owns approved-plan execution prompt construction, runtime task derivation/normalization, command execution hints, and requested root markdown deliverable detection.
- `src/store/submitSessionBootstrap.ts` owns submit-session bootstrap side effects: auto-session patch application and run-session updated-at/active touch.
- `src/store/submitTurnDraft.ts` owns submit-time turn draft preparation: deterministic turn id selection, UI display turn routing, turn input context signals, user context item construction, active session lookup, and local title/seed decision inputs.
- `src/store/submitTitleEffects.ts` owns visible-turn session title seeding and semantic metadata callback handling, including stale callback guards and non-overwrite behavior for manual/semantic session titles.
- `src/store/submitVisibleTurn.ts` owns ordinary visible-turn append, reply-option archival logging, run-state patch application, and context-item failed marking.
- `src/store/submitRunLease.ts` owns agent user-message construction, abort-controller lease creation, goal-start handoff, and harness run marker initialization for a submit run.
- `src/store/submitWorkflowContext.ts` owns initial `WorkflowContext` construction and mutable stream-state defaults for the workflow engine handoff.
- `src/store/submitStreamingUi.ts` owns understanding-progress emission and streaming thought/agent block updates for submit runs.
- `src/store/submitWorkflowEngineRunner.ts` owns workflow-engine helper callback wiring and engine launch for submit runs.
- `src/store/submitAsyncWorkflowRun.ts` owns the async post-submit workflow launch phase: attachment context, prompt augmentation, Game Studio preparation, composer context clearing, run lease creation, workspace tree loading, `WorkflowContext` construction, streaming UI startup, and workflow-engine launch. It keeps a phase-runner test seam so focused node tests can validate ordering and early returns without starting the real engine.
- `src/lib/gameStudio/GameStudioRuntimeService.ts` is the first Game Studio domain facade for initialization, engine configuration, slash command resolution, turn envelope construction, and mode-switch decisions.
- `src/store/gameStudioTurnPreparation.ts` owns store-adjacent Game Studio turn setup: explicit `/setup-engine`, workspace engine auto-configuration, required workflow pack initialization, and turn envelope construction. It depends on an injected runtime service so node tests do not load Vite-only workflow-pack imports.
- `src/store/submitGameStudioPreparation.ts` owns Game Studio preparation result application for submit runs: workspace tree invalidation, runtime patch application, workspace content-version bumps, and failure cleanup that appends the visible system error block and clears active run state.
- `src/store/gameStudioLocalSlashSubmission.ts` owns Game Studio local slash dispatch for `/agent`, `/auto`, and local-fast workflow markdown.
- `src/store/gameStudioLocalSlashBridge.ts` owns Game Studio local slash transcript append, runtime-event emission, and session snapshot persistence.

## Compatibility Shims Kept

- `src/store/useAppStore.ts` still re-exports several moved types and helpers so existing UI/tests do not need a broad migration in the same slice.
- `useAppStore.sendMessage` still owns high-level submission sequencing and async turn preparation. The new `buildSubmitInputEnvelope`, `buildSubmitPipelineDecision`, `buildSubmitIntentConfirmationPendingDecision`, `resolveSubmitEffectiveIntentDecision`, `resolveSubmitRuntimeDecision`, `resolveSubmitSendGateDecision`, `buildSubmitSessionBootstrapDecision`, `buildSubmitSessionBootstrapPatch`, `resolveSubmitTurnTitleDecision`, `resolveSubmitSemanticMetadataDecision`, `buildSubmitBlockingPreflightEffect`, `resolveSubmitPreflightEffectAction`, `buildSubmitLocalStudioTurnPatch`, `buildSubmitRunStatePatch`, `buildSubmitHarnessRunMarkerDraft`, `resolveSubmitPreflightStalenessDecision`, `buildSubmitPreflightResumeOptions`, `buildSubmitVisibleTurnPatch`, `resolveSubmitExecutionApprovalDecision`, `resolveSubmitPreflightResultDecision`, `createSubmitPreRunSessionPatcher`, `createSubmitSessionRuntimeFacade`, `createSubmitSessionRuntimeController`, `prepareSubmitTurnDraft`, `startSubmitElapsedTimer`, `applySubmitPendingReviewTransition`, `applySubmitPlanStateReset`, `applySubmitSendGateEffects`, `resolveAndApplySubmitIntentRouting`, `runSubmitPlanHydrationEffect`, `startSubmitPlanHydrationEffect`, `runSubmitPlanExecutionResumeEffect`, `buildTrustedPlanResumePrompt`, `buildSubmitAttachmentContext`, `prepareAttachedFileForRead`, `buildSubmitPromptContext`, `buildOperationApprovalContinuationPrompt`, `buildApprovedPlanExecutionPrompt`, `ensureApprovedPlanRuntimeTasksForState`, `normalizeApprovedPlanTaskStatuses`, `applySubmitSessionBootstrap`, `applySubmitVisibleTurn`, `runSubmitGameStudioPreparation`, `applySubmitGameStudioPreparationResult`, `prepareGameStudioTurn`, `executeSubmitBlockingPreflight`, `startSubmitBlockingPreflightEffect`, `applySubmitSeedSessionTitle`, `startSubmitSemanticMetadataEffect`, `startSubmitRunLease`, `createSubmitWorkflowContext`, `startSubmitStreamingUi`, `runSubmitWorkflowEngine`, `runSubmitAsyncWorkflowRun`, `startSubmitAsyncWorkflowRun`, `createGameStudioLocalSlashBridge`, and `startGameStudioLocalSlashSubmission` helpers are the intended boundary for continuing Phase 2 without changing the public store hook.
- Game Studio pack/doc/runtime primitives still have legacy exports in `src/lib/gameStudioPack.ts`; the new service facade is the intended narrow entry point for future store/UI migration.
- `src/lib/e2e.ts` is still allowed to import `useAppStore` as the test bridge exception.

## Behavior Notes

- Normal MAIN mode can still handle game-development tasks.
- Game Studio remains a workspace-local workflow pack, not a replacement for MAIN general execution.
- Local-fast Game Studio slash help bypasses execution approval and renders command markdown directly in the transcript.
- `game_studio_local_markdown` is visible transcript output and is not folded into process timelines.
- Awaiting-input turns keep effective progress visible without showing a stale running-tool state.

## Phase 2 Boundary Audit

- `useAppStore.sendMessage` is currently 649 lines by TypeScript AST range. The remaining body now mainly sequences existing submit helpers and store effects: input envelope/pipeline decision, intent routing, runtime decision, send gate, session bootstrap, turn draft/materialization, local Game Studio slash handling, title metadata, elapsed timer, and async workflow launch.
- The earlier 300-500 line target is directional. For this slice, the next obvious extraction would mostly wrap many store callbacks and already-named helpers into another parameter-heavy facade, so it is intentionally left in `sendMessage` until a later phase creates a clearer owner.
- The Phase 2 stop point is therefore ownership-based rather than line-count-based: pure decisions and behavior-heavy effects have focused helper/test coverage, while `sendMessage` remains the public hook entrypoint and high-level submit orchestration layer.
- Further reduction should wait for a coherent Phase 3/4 boundary, such as an orchestrator callback contract change or a narrower Game Studio runtime service handoff.

## Pending Phases

- Phase 2 has a test-covered pure-decision/effect-plan boundary for submit input envelope construction, reply-option reuse, pending-review interruption effects, plan hydration decisions and auto hydration execution, trusted plan execution resume, submit attachment context construction, submit prompt augmentation, approved-plan execution prompt/runtime task construction, intent shortcuts, intent-confirmation pending decision construction, effective intent resolution, auto-approve execution forcing, runtime/display intent selection, execution consent, plan-state reset decisions and reset effects, send busy/queue/pending-review gate decisions and effect execution, submit intent-routing effect execution, pre-run session patch routing, session bootstrap/run metadata, temporary-session bootstrap patching and store-side application, submit scoped runtime callbacks, turn draft construction, turn title/session title seed decisions, semantic metadata request planning and callback execution, blocking preflight request/action planning and execution startup, local Game Studio slash turn patch construction, dispatch, transcript persistence, ordinary visible-turn append/run-state application, launch harness marker draft construction and run lease creation, async workflow-run launch orchestration, initial WorkflowContext construction, streaming UI ownership, workflow-engine callback wiring, store runtime facade/timer ownership, preflight stale/resume handling, visible-turn patch construction, local execution-approval prompts, blocking-preflight outcomes, Game Studio mode switching, Game Studio setup/envelope preparation, and Game Studio preparation result application/failure cleanup. `sendMessage` is currently 649 lines by TypeScript AST range; remaining Phase 2 work should keep moving coherent decisions/effects out of `useAppStore.sendMessage` only when the extracted boundary improves readability, testing, or ownership. The earlier 300-500 line target is directional, not a hard gate; do not split stable code just to satisfy a line count.
- Phase 3 still needs `AgentOrchestrator.execute` split into runtime state, turn preparation, stream invocation, tool planning, tool execution, recovery, and completion guards.
- Phase 5 still needs `Composer`, `ChatArea`, `SettingsModal`, and e2e scenario seed decomposition after runtime boundaries settle.

## Verification

- `npm run build`
- `npm run test:workflow-assets` (911 node tests)
- `node --test --test-reporter=dot tests/node/*.test.mjs` (911 node tests; sandboxed run still hits the known `listen EPERM 127.0.0.1` gateway-proxy restriction, non-sandbox rerun passed)
- `node --test --test-reporter=dot tests/node/submit-async-workflow-run.test.mjs tests/node/workflow-runtime-state.test.mjs` (focused async workflow-run and structure-guard slice)
- `node --test --test-reporter=dot tests/node/submit-intent-routing.test.mjs tests/node/run-intent.test.mjs tests/node/plan-state-hydration.test.mjs tests/node/workflow-runtime-state.test.mjs` (focused submit intent-routing and structure-guard slice)
- `node --test --test-reporter=dot tests/node/submit-runtime-facade.test.mjs tests/node/submit-plan-state-reset.test.mjs tests/node/submit-send-gate-effects.test.mjs tests/node/submit-turn-draft.test.mjs tests/node/submit-pipeline.test.mjs tests/node/workflow-runtime-state.test.mjs` (focused submit runtime/pre-run/controller/turn-draft/plan-reset/send-gate slice)
- `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts -g "existing .MAIN/plans execution hydrates approved plan and exposes execute tools|approved plan resumes with execute runtime tools while preserving plan turn identity"` (2 tests)
- `npx playwright test tests/e2e/plan-reload-resume.spec.ts` (1 test)
- `npx playwright test tests/e2e/awaiting-choice.spec.ts tests/e2e/streaming-timer.spec.ts` (8 tests)
- `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts -g "plain fix request shows operation approval before execute tools|workspace-external local file reads request approval before ingesting and reading|plan executable reply options are ignored when the same turn has tool calls"` (3 tests)
- `npx playwright test tests/e2e/streaming-timer.spec.ts tests/e2e/game-studio-onboarding.spec.ts tests/e2e/game-studio-plan-shortcuts.spec.ts tests/e2e/game-studio-tool-group-collapse.spec.ts` (16 tests)
- `npx playwright test tests/e2e/cloud-tool-protocol.spec.ts -g "game studio execute reply resumes the source turn with studio workflow tools"`
