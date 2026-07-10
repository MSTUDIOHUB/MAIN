# Context Management

MAIN owns context budgeting, trimming, recovery prompts, and provider-specific
retry behavior. Game Studio workflows must not ask the user to run unsupported
context commands or assume that a forced context pass dropped messages.

## Durable Project State

Use project files for decisions that must survive across tasks:

- Write approved design and production decisions to their real artifacts.
- Keep `.MAIN/game-studio/studio.config.json` as the Studio runtime source of truth.
- Use `production/session-state/active.md` only when the selected workflow creates
  and maintains that artifact; do not invent it for a one-off task.
- After a recovery or context trim, reuse the latest tool results and project
  artifacts before reading the same files again.

## Progress Rules

1. Read only the files needed for the current decision.
2. Once evidence is sufficient, move to the requested write, validation, or user
   decision instead of repeating broad reads.
3. Record approved lifecycle decisions in workspace artifacts as they are made.
4. Treat a specialist profile as a review viewpoint in the current MAIN run.
5. Report a real blocker when required evidence, permission, or an external tool
   is unavailable; do not fabricate progress.

## Recovery Summary

When MAIN asks for a compact recovery summary, preserve:

- the active workflow command and production stage;
- the configured engine and sticky specialist;
- files changed and validations run;
- approved decisions and unresolved blockers;
- the next concrete action.
