---
name: skill-improve
description: "Improve one installed Game Studio command through a review, approval, patch, and retest loop."
argument-hint: "[skill-name]"
user-invocable: true
---

# Skill Improve

Improve one command document under
`.protocols/game-studio/commands/` without relying on external catalogs or
destructive Git rollback commands.

## Phase 1: Resolve Target

Read the command name from the argument and verify
`.protocols/game-studio/commands/[name].md` exists. If it does not, show usage
and stop.

## Phase 2: Establish Baseline

Run the same seven checks defined by `/skill-test static [name]` and record:

- Failures and warnings.
- Exact affected lines.
- Whether the problem is structural, path-related, tool-related, interaction
  protocol, specialist routing, or write safety.

If the command already passes every check, report COMPLETE and stop.

## Phase 3: Propose A Focused Change

Read the full command document. Propose the smallest coherent patch that fixes
the failed checks while preserving the command's game-development purpose.

Present:

- The current problem.
- The proposed replacement.
- Any behavior change the user should understand.
- The exact file that would be modified.

Ask for write approval with one flat `<user_options>` block, then stop and wait.

## Phase 4: Apply And Retest

After approval, use the current MAIN file-editing tool to apply the focused
patch. Re-run `/skill-test static [name]` and compare before and after results.

Keep the change only when the command improves or preserves all existing passing
checks. If the score is unchanged or worse, report the regression and propose a
corrective patch. Do not run `git checkout`, reset the worktree, or overwrite
unrelated user changes.

## Phase 5: Report

Summarize:

- Checks fixed.
- Checks still failing.
- Behavior changes.
- Validation evidence.

Recommend another `/skill-improve [name]` only when a concrete next target is
known. Otherwise report COMPLETE.
