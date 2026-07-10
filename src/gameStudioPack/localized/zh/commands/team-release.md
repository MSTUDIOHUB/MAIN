---
name: team-release
description: "编排多位专家协同处理发布、验证与上线准备。"
argument-hint: "[version number 或 'next']"
user-invocable: true
---

**Argument check:** If no version number is provided:
1. Read `production/session-state/active.md` and the most recent file in `production/milestones/` (if they exist) to infer the target version.
2. If a version is found: report "No version argument provided — inferred [version] from milestone data. Proceeding." Then confirm with `<user_options>`: "Releasing [version]. Is this correct?"
3. If no version is discoverable: ask the user "What version number should be released? (e.g., v1.0.0)" and wait for user input before proceeding. Do NOT default to a hardcoded version string.

When this skill is invoked, orchestrate the release team through a structured pipeline.

**Decision Points:** At each phase transition, present
the specialist review's proposals as selectable options. Write the agent's
full analysis in conversation, then capture the decision with concise labels.
The user must approve before moving to the next phase.

## Team Composition
- **release-manager** — Release branch, versioning, changelog, deployment
- **qa-lead** — Test sign-off, regression suite, release quality gate
- **devops-engineer** — Build pipeline, artifacts, deployment automation
- **security-engineer** — Pre-release security audit (invoke if game has online/multiplayer features or player data)
- **analytics-engineer** — Verify telemetry events fire correctly and dashboards are live
- **community-manager** — Patch notes, launch announcement, player-facing messaging
- **producer** — Go/no-go decision, stakeholder communication, scheduling

## How to Apply Specialist Profiles

Apply each listed specialist profile as a separate review pass in the current MAIN run:
- `specialist profile: release-manager` — Release branch, versioning, changelog, deployment
- `specialist profile: qa-lead` — Test sign-off, regression suite, release quality gate
- `specialist profile: devops-engineer` — Build pipeline, artifacts, deployment automation
- `specialist profile: security-engineer` — Security audit for online/multiplayer/data features
- `specialist profile: analytics-engineer` — Telemetry event verification and dashboard readiness
- `specialist profile: community-manager` — Patch notes and launch communication
- `specialist profile: producer` — Go/no-go decision, stakeholder communication
- `specialist profile: network-programmer` — Netcode stability sign-off (invoke if game has multiplayer)

Always provide full context in each agent's prompt (version number, milestone status, known issues). Apply each specialist profile as a separate review pass in the current MAIN run, then synthesize the results before advancing.

## Pipeline

### Phase 1: Release Planning
Apply the **producer** profile:
- Confirm all milestone acceptance criteria are met
- Identify any scope items deferred from this release
- Set the target release date and communicate to team
- Output: release authorization with scope confirmation

### Phase 2: Release Candidate
Apply the **release-manager** profile:
- Cut release branch from the agreed commit
- Bump version numbers in all relevant files
- Generate the release checklist using `/release-checklist`
- Freeze the branch — no feature changes, bug fixes only
- Output: release branch name and checklist

### Phase 3: Quality Gate (parallel)
Apply these specialist profiles as separate review passes:
- **qa-lead**: Execute full regression test suite. Test all critical paths. Verify no S1/S2 bugs. Sign off on quality.
- **devops-engineer**: Build release artifacts for all target platforms. Verify builds are clean and reproducible. Run automated tests in CI.
- **security-engineer** *(if game has online features, multiplayer, or player data)*: Conduct pre-release security audit. Review authentication, anti-cheat, data privacy compliance. Sign off on security posture.
- **network-programmer** *(if game has multiplayer)*: Sign off on netcode stability. Verify lag compensation, reconnect handling, and bandwidth usage under load.

### Phase 4: Localization, Performance, and Analytics
Apply this specialist profile after the Phase 3 context is available:
- Verify all strings are translated (route through **localization-lead** if available)
- Run performance benchmarks against targets (route through **performance-analyst** if available)
- **analytics-engineer**: Verify all telemetry events fire correctly on release build. Confirm dashboards are receiving data. 检查 that critical funnels (onboarding, progression, monetization if applicable) are instrumented.
- Output: localization, performance, and analytics sign-off

### Phase 5: Go/No-Go
Apply the **producer** profile:
- Collect sign-off from: qa-lead, release-manager, devops-engineer, security-engineer (if applied in Phase 3), network-programmer (if applied in Phase 3), and technical-director
- Evaluate any open issues — are they blocking or can they ship?
- Make the go/no-go call
- Output: release decision with rationale

**If producer declares NO-GO:**
- Surface the decision immediately: "PRODUCER: NO-GO — [rationale, e.g., S1 bug found in Phase 3]."
- Ask the user with options:
  - Fix the blocker and re-run the affected phase
  - Defer the release to a later date
  - Override NO-GO with documented rationale (user must provide written justification)
- **Skip Phase 6 entirely** — do not tag, deploy to staging, deploy to production, or apply community-manager.
- Produce a partial report summarizing Phases 1–5 and what was skipped (Phase 6) and why.
- 结论: **BLOCKED** — release not deployed.

### Phase 6: Deployment (if GO)
Apply the **release-manager** profile + **devops-engineer**:
- Tag the release in version control
- Generate changelog using `/changelog`
- Deploy to staging for final smoke test
- Deploy to production
- Monitor for 48 hours post-release

Apply the **community-manager** profile after deployment context is available:
- Finalize patch notes using `/patch-notes [version]`
- Prepare launch announcement (store page updates, social media, community post)
- Draft known issues post if any S3+ issues shipped
- Output: all player-facing release communication, ready to publish on deploy confirmation

### Phase 7: Post-Release
- **release-manager**: Generate release report (what shipped, what was deferred, metrics)
- **producer**: Update milestone tracking, communicate to stakeholders
- **qa-lead**: Monitor incoming bug reports for regressions
- **community-manager**: Publish all player-facing communication, monitor community sentiment
- **analytics-engineer**: Confirm live dashboards are healthy; alert if any critical events are missing
- Schedule post-release retrospective if issues occurred

## Error Recovery Protocol

If a specialist review identifies a blocker or cannot produce a verdict:

1. **Surface immediately**: 报告 "[SpecialistProfile]: BLOCKED — [reason]" to the user before continuing to dependent phases
2. **Assess dependencies**: 检查 whether the blocked review's output is required by subsequent phases. If yes, do not proceed past that dependency point without user input.
3. **Offer options** in one flat `<user_options>` block:
   - Skip this review pass and note the gap in the final report
   - Retry with narrower scope
   - Stop here and resolve the blocker first
4. **Always produce a partial report** — output whatever was completed. Never discard work because one review pass identifies a blocker.

Common blockers:
- Input file missing (story not found, GDD absent) → redirect to the skill that creates it
- ADR status is Proposed → do not implement; run `/architecture-decision` first
- Scope too large → split into two stories via `/create-stories`
- Conflicting instructions between ADR and story → surface the conflict, do not guess

## File Write Protocol

The current MAIN run owns all file writes (release checklists, changelogs, patch notes, deployment scripts). Specialist review passes only produce analysis and verdicts. Before each write, the main run lists the target path and requests approval.

## 输出

A summary report covering: release version, scope, quality gate results, go/no-go decision, deployment status, and monitoring plan.

结论: **COMPLETE** — release executed and deployed.
结论: **BLOCKED** — release halted; go/no-go was NO or a hard blocker is unresolved.

## 下一步

- Monitor post-release dashboards for 48 hours.
- Run `/retrospective` if significant issues occurred during the release.
- Update `production/stage.txt` to `Live` after successful deployment.
