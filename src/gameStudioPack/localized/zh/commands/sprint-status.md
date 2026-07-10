---
name: sprint-status
description: "快速汇总当前 Sprint 进度、阻塞项和剩余工作。"
argument-hint: "[Sprint 编号；留空表示当前 Sprint]"
user-invocable: true
---

# Sprint 状态

这是一次快速态势检查, not a sprint review. It reads the
current sprint plan and story files, scans for status markers, and produces a
concise snapshot in under 30 lines. For detailed sprint management, use
`/sprint-plan update` or `/milestone-review`.

**此技能为只读.** 它不会提出变更, never asks to write
files, and makes at most one concrete recommendation.

---

## 1. Find the Sprint

**Argument:** `the first token after the slash command in the current user request` (blank = use current sprint)

- If an argument is given (e.g., `/sprint-status 3`), search
  `production/sprints/` for a file matching `sprint-03.md`, `sprint-3.md`,
  or similar. 报告 which file was found.
- If no argument is given, find the most recently modified file in
  `production/sprints/` and treat it as the current sprint.
- If `production/sprints/` does not exist or is empty, report: "No sprint
  files found. Start a sprint with `/sprint-plan new`." Then stop.

Read the sprint file in full. Extract:
- Sprint number and goal
- Start date and end date
- All story or task entries with their priority (Must Have / Should Have /
  Nice to Have), owner, and estimate

---

## 2. Calculate Days Remaining

Using today's date and the sprint end date from the sprint file, calculate:
- Total sprint days (end minus start)
- Days elapsed
- Days remaining
- Percentage of time consumed

If the sprint file does not include explicit dates, note "Sprint dates not
found — burndown assessment skipped."

---

## 3. Scan Story Status

**First: check for `production/sprint-status.yaml`.**

If it exists, read it directly — it is the authoritative source of truth.
Extract status for each story from the `status` field. No markdown scanning needed.
Use its `sprint`, `goal`, `start`, `end` fields instead of re-parsing the sprint plan.

**If `sprint-status.yaml` does not exist** (legacy sprint or first-time setup),
fall back to markdown scanning:

1. If the entry references a story file path, check if the file exists.
   Read the file and scan for status markers: DONE, COMPLETE, IN PROGRESS,
   BLOCKED, NOT STARTED (case-insensitive).
2. If the entry has no file path (inline task in the sprint plan), scan the
   sprint plan itself for status markers next to that entry.
3. If no status marker is found, classify as NOT STARTED.
4. If a file is referenced but does not exist, classify as MISSING and note it.

When using the fallback, add a note at the bottom of the output:
"⚠ No `sprint-status.yaml` found — status inferred from markdown. Run `/sprint-plan update` to generate one."

Optionally (fast check only — do not do a deep scan): grep `src/` for a
directory or file name that matches the story's system slug to check for
implementation evidence. This is a hint only, not a definitive status.

### Stale Story Detection

After collecting status for all stories, check each IN PROGRESS story for staleness:

- For each story that has a referenced file, read the file and look for a
  `Last Updated:` field in the frontmatter or header (e.g., `Last Updated: 2026-04-01`
  or `updated: 2026-04-01`). Accept any reasonable date field name: `Last Updated`,
  `Updated`, `last-updated`, `updated_at`.
- Calculate days since that date using today's date.
- If the date is more than 2 days ago, flag the story as **STALE**.
- If no date field is found in the story file, note "no timestamp — cannot check staleness."
- If the story has no referenced file (inline task), note "inline task — cannot check staleness."

STALE stories are included in the output table and collected into an "Attention Needed"
section (see Phase 5 output format).

**Stale story escalation**: If any IN PROGRESS story is flagged STALE, the burndown verdict
is upgraded to at least **At Risk** — even if the completion percentage is within the normal
On Track window. Record this escalation reason: "At Risk — [N] story(ies) with no progress in
[N] days."

---

## 4. Burndown Assessment

Calculate:
- Tasks complete (DONE or COMPLETE)
- Tasks in progress (IN PROGRESS)
- Tasks blocked (BLOCKED)
- Tasks not started (NOT STARTED or MISSING)
- Completion percentage: (complete / total) * 100

Assess burndown by comparing completion percentage to time consumed percentage:

- **On Track**: completion % is within 10 points of time consumed % or ahead
- **At Risk**: completion % is 10-25 points behind time consumed %
- **Behind**: completion % is more than 25 points behind time consumed %

If dates are unavailable, skip the burndown assessment and report "On Track /
At Risk / Behind: unknown — sprint dates not found."

---

## 5. Output

Keep the total output to 30 lines or fewer. Use this format:

```markdown
## Sprint [N] Status — [Today's Date]
**Sprint Goal**: [from sprint plan]
**Days Remaining**: [N] of [total] ([% time consumed])

### Progress: [complete/total] tasks ([%])

| Story / Task         | Priority   | Status      | Owner   | Blocker        |
|----------------------|------------|-------------|---------|----------------|
| [title]              | Must Have  | DONE        | [owner] |                |
| [title]              | Must Have  | IN PROGRESS | [owner] |                |
| [title]              | Must Have  | BLOCKED     | [owner] | [brief reason] |
| [title]              | Should Have| NOT STARTED | [owner] |                |

### Attention Needed
| Story / Task         | Status      | Last Updated   | Days Stale | Note           |
|----------------------|-------------|----------------|------------|----------------|
| [title]              | IN PROGRESS | [date or N/A]  | [N days]   | [STALE / no timestamp — cannot check staleness / inline task — cannot check staleness] |

*(Omit this section entirely if no IN PROGRESS stories are stale or have timestamp concerns.)*

### Burndown: [On Track / At Risk / Behind]
[1-2 sentences. If behind: which Must Haves are at risk. If on track: confirm
and note any Should Haves the team could pull.]

### Must-Haves at Risk
[List any Must Have stories that are BLOCKED or NOT STARTED with less than
40% of sprint time remaining. If none, write "None."]

### Emerging Risks
[Any risks visible from the story scan: missing files, cascading blockers,
stories with no owner. If none, write "None identified."]

### 建议
[One concrete action, or "Sprint is on track — no action needed."]
```

---

## 6. Fast Escalation Rules

Apply these rules before outputting, and place the flag at the TOP of the
output if triggered (above the status table):

**Critical flag** — if Must Have stories are BLOCKED or NOT STARTED and
less than 40% of the sprint time remains:

```
SPRINT AT RISK: [N] Must Have stories are not complete with [X]% of sprint
time remaining. Recommend replanning with `/sprint-plan update`.
```

**Completion flag** — if all Must Have stories are DONE:

```
All Must Haves complete. Team can pull from Should Have backlog.
```

**Missing stories flag** — if any referenced story files do not exist:

```
NOTE: [N] story files referenced in the sprint plan are missing.
Run `/story-readiness sprint` to validate story file coverage.
```

---

## 协作协议

此技能为只读. It reports observed facts from files on disk.

- It does not update the sprint plan
- It does not change story status
- It does not propose scope cuts (that is `/sprint-plan update`)
- It makes at most one recommendation per run

For more detail on a specific story, the user can read the story file directly
or run `/story-readiness [path]`.

For sprint replanning, use `/sprint-plan update`.
For end-of-sprint retrospective, use `/milestone-review`.
