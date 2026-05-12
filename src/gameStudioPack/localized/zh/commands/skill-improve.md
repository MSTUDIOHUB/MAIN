---
name: skill-improve
description: "根据测试反馈改进技能或协议，使其更稳定、更易用。"
argument-hint: "[skill-name]"
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Bash
---

# Skill Improve

Runs an improvement loop on a single skill:
test → fix → retest → keep or revert.

---

## 阶段 1: Parse Argument

Read the skill name from the first argument. If missing, output usage and stop:

```
Usage: /skill-improve [skill-name]
Example: /skill-improve tech-debt
```

Verify `.claude/skills/[name]/SKILL.md` exists. If not, stop with:
"Skill '[name]' not found."

---

## 阶段 2: Baseline Test

Run `/skill-test static [name]` and record the baseline score:
- Count of FAILs
- Count of WARNs
- Which specific checks failed (检查 1–7)

Display to the user:
```
Static baseline:   [N] failures, [M] warnings
Failing: 检查 4 (no ask-before-write), 检查 5 (no handoff)
```

If baseline is 0 FAILs and 0 WARNs, note it and proceed to Phase 2b.

### Phase 2b: Category Baseline

Look up the skill's `category:` field in `CCGS Skill Testing Framework/catalog.yaml`.

If no `category:` field is found, display:
"Category: not yet assigned — skipping category checks."
and skip to Phase 3.

If category is found, run `/skill-test category [name]` and record the category baseline:
- Count of FAILs
- Count of WARNs
- Which specific category rubric metrics failed

Display to the user:
```
Category baseline: [N] failures, [M] warnings  ([category] rubric)
```

If BOTH static and category baselines are 0 FAILs and 0 WARNs, stop:
"This skill already passes all static and category checks. No improvements needed."

---

## 阶段 3: Diagnose

Read the full skill file at `.claude/skills/[name]/SKILL.md`.

For each failing or warning **static** check, identify the exact gap:

- **检查 1 fail** → which frontmatter field is missing
- **检查 2 fail** → how many phases found vs. minimum required
- **检查 3 fail** → no verdict keywords anywhere in the skill body
- **检查 4 fail** → Write or Edit in allowed-tools but no ask-before-write language
- **检查 5 warn** → no follow-up or next-step section at the end
- **检查 6 warn** → `context: fork` set but fewer than 5 phases found
- **检查 7 warn** → argument-hint is empty or doesn't match documented modes

For each failing or warning **category** check (if category was assigned in Phase 2b),
identify the exact gap in the skill's text. For example:
- If G2 fails (gate mode, full directors not spawned): skill body never references all 4
  PHASE-GATE director prompts
- If A2 fails (authoring, no per-section May-I-write): skill asks once at the end, not
  before each section write
- If T3 fails (team, BLOCKED not surfaced): skill doesn't halt dependent work on blocked agent

Show the full combined diagnosis to the user before proposing any changes.

---

## 阶段 4: Propose Fix

Write a targeted fix for each failure and warning. Show the proposed changes
as clearly marked before/after blocks. Only change what is failing — do not
rewrite sections that are passing.

Ask: "May I write this improved version to `.claude/skills/[name]/SKILL.md`?"

If the user says no, stop here.

---

## 阶段 5: Write and Retest

Record the current content of the skill file (for revert if needed).

Write the improved skill to `.claude/skills/[name]/SKILL.md`.

Re-run `/skill-test static [name]` and record the new static score.
If a category was assigned, also re-run `/skill-test category [name]` and record the new category score.

Display the comparison:
```
Static:   Before [N] failures, [M] warnings  →  After [N'] failures, [M'] warnings
Category: Before [N] failures, [M] warnings  →  After [N'] failures, [M'] warnings  (if applicable)
Combined change: improved / no change / worse
```

---

## 阶段 6: 结论

Count the combined failure total: static FAILs + category FAILs + static WARNs + category WARNs.

**If combined score improved (combined failure count is lower than baseline):**
报告: "Score improved. Changes kept."
Show a summary of what was fixed in each dimension.

**If combined score is the same or worse:**
报告: "Combined score did not improve."
Show what changed and why it may not have helped.
Ask: "May I revert `.claude/skills/[name]/SKILL.md` using git checkout?"
If yes: run `git checkout -- .claude/skills/[name]/SKILL.md`

---

## 阶段 7: Next Steps

- Run `/skill-test static all` to find the next skill with failures.
- Run `/skill-improve [next-name]` to continue the loop on another skill.
- Run `/skill-test audit` to see overall coverage progress.
