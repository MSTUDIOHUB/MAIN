---
name: onboard
description: "设计玩家新手引导、教程流和前期学习体验。"
argument-hint: "[role|area]"
user-invocable: true
---

## 阶段 1: Load Project Context

Read AGENTS.md for project overview and standards.

Read the relevant agent definition from `.protocols/game-studio/agents/` if a specific role is specified.

---

## 阶段 2: Scan Relevant Area

- For programmers: scan `src/` for architecture, patterns, key files
- For designers: scan `design/` for existing design documents
- For narrative: scan `design/narrative/` for world-building and story docs
- For QA: scan `tests/` for existing test coverage
- For production: scan `production/` for current sprint and milestone

Read recent changes (git log if available) to understand current momentum.

---

## 阶段 3: Generate Onboarding Document

```markdown
# Onboarding: [Role/Area]

## Project Summary
[2-3 sentence summary of what this game is and its current state]

## Your Role
[What this role does on this project, key responsibilities, who you report to]

## Project Architecture
[Relevant architectural overview for this role]

### Key Directories
| Directory | Contents | Your Interaction |
|-----------|----------|-----------------|

### Key Files
| File | Purpose | Read Priority |
|------|---------|--------------|

## Current Standards and Conventions
[Summary of conventions relevant to this role from AGENTS.md and agent definition]

## Current State of Your Area
[What has been built, what is in progress, what is planned next]

## Current Sprint Context
[What the team is working on now and what is expected of this role]

## Key Dependencies
[What other roles/systems this role interacts with most]

## Common Pitfalls
[Things that trip up new contributors in this area]

## First Tasks
[Suggested first tasks to get oriented and productive]

1. [Read these documents first]
2. [Review this code/content]
3. [Start with this small task]

## Questions to Ask
[Questions the new contributor should ask to get fully oriented]
```

---

## 阶段 4: Save Document

Present the onboarding document to the user.

Ask: "May I write this to `production/onboarding/onboard-[role]-[date].md`?"

If yes, write the file, creating the directory if needed.

---

## 阶段 5: Next Steps

结论: **COMPLETE** — onboarding document generated.

- Share the onboarding doc with the new contributor before their first session.
- Run `/sprint-status` to show the new contributor current progress.
- Run `/help` if the contributor needs guidance on what to work on next.
