---
name: design-review
description: "Reviews a game design document for completeness, internal consistency, implementability, and adherence to project design standards. Run this before handing a design document to programmers."
argument-hint: "[path-to-design-doc] [--depth full|lean|solo]"
user-invocable: true
---

## Phase 0: Parse Arguments

Extract `--depth [full|lean|solo]` if present. Default is `full` when no flag is given.

**Note**: `--depth` controls the *analysis depth* of this skill (how many specialist agents are applied). It is independent of the global review mode in `production/review-mode.txt`, which controls director gate applying. These are two different concepts — `--depth` is about how thoroughly *this* skill analyses the document.

- **`full`**: Complete review — all phases + specialist agent delegation (Phase 3b)
- **`lean`**: All phases, no specialist agents — faster, single-session analysis
- **`solo`**: Phases 1-4 only, no delegation, no Phase 5 next-step prompt — use when called from within another skill

---

## Phase 1: Load Documents

Read the target design document in full. Read AGENTS.md to understand project context and standards. Read related design documents referenced or implied by the target doc (check `design/gdd/` for related systems).

**Dependency graph validation:** For every system listed in the Dependencies section, use glob_search to check whether its GDD file exists in `design/gdd/`. Flag any that don't exist yet — these are broken references that downstream authors will hit.

**Lore/narrative alignment:** If `design/gdd/game-concept.md` or any file in `design/narrative/` exists, read it. Note any mechanical choices in this GDD that contradict established world rules, tone, or design pillars. Pass this context to `game-designer` in Phase 3b.

**Prior review check:** Check whether `design/gdd/reviews/[doc-name]-review-log.md` exists. If it does, read the most recent entry — note what verdict was given and what blocking items were listed. This session is a re-review; track whether prior items were addressed.

---

## Phase 2: Completeness Check

Evaluate against the Design Document Standard checklist:

- [ ] Has Overview section (one-paragraph summary)
- [ ] Has Player Fantasy section (intended feeling)
- [ ] Has Detailed Rules section (unambiguous mechanics)
- [ ] Has Formulas section (all math defined with variables)
- [ ] Has Edge Cases section (unusual situations handled)
- [ ] Has Dependencies section (other systems listed)
- [ ] Has Tuning Knobs section (configurable values identified)
- [ ] Has Acceptance Criteria section (testable success conditions)

---

## Phase 3: Consistency and Implementability

**Internal consistency:**
- Do the formulas produce values that match the described behavior?
- Do edge cases contradict the main rules?
- Are dependencies bidirectional (does the other system know about this one)?

**Implementability:**
- Are the rules precise enough for a programmer to implement without guessing?
- Are there any "hand-wave" sections where details are missing?
- Are performance implications considered?

**Cross-system consistency:**
- Does this conflict with any existing mechanic?
- Does this create unintended interactions with other systems?
- Is this consistent with the game's established tone and pillars?

---

## Phase 3b: Adversarial Specialist Review (full mode only)

**Skip this phase in `lean` or `solo` mode.**

**This phase is MANDATORY in full mode.** Do not skip it.

**Before applying any agents**, print this notice:
> "Full review: applying the complete set of specialist review passes. This typically takes 8–15 minutes. Use `--review lean` for faster single-session analysis."

### Step 1 — Identify all domains the GDD touches

Read the GDD and identify every domain present. A GDD can touch multiple domains simultaneously — be thorough. Common signals:

| If the GDD contains... | Apply these agents |
|------------------------|-------------------|
| Costs, prices, drops, rewards, economy | `economy-designer` |
| Combat stats, damage, health, DPS | `game-designer`, `systems-designer` |
| AI behaviour, pathfinding, targeting | `ai-programmer` |
| Level layout, applying, wave structure | `level-designer` |
| Player progression, XP, unlocks | `economy-designer`, `game-designer` |
| UI, HUD, menus, player-facing displays | `ux-designer`, `ui-programmer` |
| Dialogue, quests, story, lore | `narrative-director` |
| Animation, feel, timing, juice | `gameplay-programmer` |
| Multiplayer, sync, replication | `network-programmer` |
| Audio cues, music triggers | `audio-director` |
| Performance, draw calls, memory | `performance-analyst` |
| Engine-specific patterns or APIs | Primary engine specialist (from `.protocols/game-studio/docs/technical-preferences.md`) |
| Acceptance criteria, test coverage | `qa-lead` |
| Data schema, resource structure | `systems-designer` |
| Any gameplay system | `game-designer` (always) |

**Always apply `game-designer` and `systems-designer` as a baseline minimum.** Every GDD touches their domain.

### Step 2 — Apply all relevant specialist reviews

Run each relevant profile as a clearly separated adversarial review pass in the
current MAIN run. Label the profile used and keep its findings distinct; do not
claim that a separate model process ran unless MAIN actually executed one.

**Prompt each specialist adversarially:**
> "Here is the GDD for [system] and the main review's structural findings so far.
> Your job is NOT to validate this design — your job is to find problems.
> Challenge the design choices from your domain expertise. What is wrong,
> underspecified, likely to cause problems, or missing entirely?
> Be specific and critical. Disagreement with the main review is welcome."

**Additional instructions per agent type:**

- **`game-designer`**: Anchor your review to the Player Fantasy stated in Section B of this GDD. Does this design actually deliver that fantasy? Would a player feel the intended experience? Flag any rules that serve implementability but undermine the stated feeling.

- **`systems-designer`**: For every formula in the GDD, plug in boundary values (minimum and maximum plausible inputs). Report whether any outputs go degenerate — negative values, division by zero, infinity, or nonsensical results at the extremes.

- **`qa-lead`**: Review every acceptance criterion. Flag any that are not independently testable — phrases like "feels balanced", "works correctly", "performs well" are not ACs. Suggest concrete rewrites for any that fail this test.

### Step 3 — Senior lead review

After all specialists respond, apply `creative-director` as the **senior reviewer**:
- Provide: the GDD, all specialist findings, any disagreements between them
- Ask: "Synthesise these findings. What are the most important issues? Do you agree with the specialists? What is your overall verdict on this design?"
- The creative-director's synthesis becomes the **final verdict** in Phase 4.

### Step 4 — Surface disagreements

If specialists disagree with each other or with the creative-director, do NOT silently pick one view. Present the disagreement explicitly in Phase 4 so the user can adjudicate.

Mark every finding with its source: `[game-designer]`, `[economy-designer]`, `[creative-director]` etc.

---

## Phase 4: Output Review

```
## Design Review: [Document Title]
Specialists consulted: [list agents applied]
Re-review: [Yes — prior verdict was X on YYYY-MM-DD / No — first review]

### Completeness: [X/8 sections present]
[List missing sections]

### Dependency Graph
[List each declared dependency and whether its GDD file exists on disk]
- ✓ enemy-definition-data.md — exists
- ✗ loot-system.md — NOT FOUND (file does not exist yet)

### Required Before Implementation
[Numbered list — blocking issues only. Each item tagged with source agent.]

### Recommended Revisions
[Numbered list — important but not blocking. Source-tagged.]

### Specialist Disagreements
[Any cases where agents disagreed with each other or with the main review.
Present both sides — do not silently resolve.]

### Nice-to-Have
[Minor improvements, low priority.]

### Senior Verdict [creative-director]
[Creative director's synthesis and overall assessment.]

### Scope Signal
Estimate implementation scope based on: dependency count, formula count,
systems touched, and whether new ADRs are required.
- **S** — single system, no formulas, no new ADRs, <3 dependencies
- **M** — moderate complexity, 1-2 formulas, 3-6 dependencies
- **L** — multi-system integration, 3+ formulas, may require new ADR
- **XL** — cross-cutting concern, 5+ dependencies, multiple new ADRs likely
Label clearly: "Rough scope signal: M (producer should verify before sprint planning)"

### Verdict: [APPROVED / NEEDS REVISION / MAJOR REVISION NEEDED]
```

This skill is read-only — no files are written during Phase 4.

---

## Phase 5: Next Steps

Ask the user for ALL closing interactions. Never plain text.

**First `<user_options>` block — what to do next:**

If APPROVED (first-pass, no revision needed), proceed directly to the systems-index `<user_options>` block, review-log `<user_options>` block, then the final closing `<user_options>` block. Do not show a separate "what to do" `<user_options>` block — the final closing `<user_options>` block covers next steps.

If NEEDS REVISION or MAJOR REVISION NEEDED, options:
- `[A] Revise the GDD now — address blocking items together`
- `[B] Stop here — revise in a separate session`
- `[C] Accept as-is and move on (only if all items are advisory)`

**If user selects [A] — Revise now:**

Work through all blocking items, asking for design decisions only where you cannot resolve the issue from the GDD and existing docs alone. Group all design-decision questions into a sequence of flat `<user_options>` blocks, one decision per turn before making any edits — do not interrupt mid-revision for each blocker individually.

After all revisions are complete, show a summary table (blocker → fix applied) and ask the user for a **post-revision closing `<user_options>` block**:

- Prompt: "Revisions complete — [N] blockers resolved. What next?"
- Note current context usage: if context is above ~50%, add: "(Recommended: /clear before re-review — this session has used X% context. A full re-review runs 5 agents and needs clean context.)"
- Options:
  - `[A] Re-review in a new session — run /design-review [doc-path] after /clear`
  - `[B] Accept revisions and mark Approved — update systems index, skip re-review`
  - `[C] Move to next system — /design-system [next-system] (#N in design order)`
  - `[D] Stop here`

Never end the revision flow with plain text. Always close with this `<user_options>` block.

**Second `<user_options>` block — systems index update (always show this separately):**

Use a second `<user_options>`:
- Prompt: "May I update `design/gdd/systems-index.md` to mark [system] as [In Review / Approved]?"
- Options: `[A] Yes — update it` / `[B] No — leave it as-is`

**Third `<user_options>` block — review log (always offer):**

Use a third `<user_options>`:
- Prompt: "May I append this review summary to `design/gdd/reviews/[doc-name]-review-log.md`? This creates a revision history so future re-reviews can track what changed."
- Options: `[A] Yes — append to review log` / `[B] No — skip`

If yes, append an entry in this format:
```
## Review — [YYYY-MM-DD] — Verdict: [APPROVED / NEEDS REVISION / MAJOR REVISION NEEDED]
Scope signal: [S/M/L/XL]
Specialists: [list]
Blocking items: [count] | Recommended: [count]
Summary: [2-3 sentence summary of key findings from creative-director verdict]
Prior verdict resolved: [Yes / No / First review]
```

---

**Final closing `<user_options>` block — always show after all file writes complete:**

Once the systems-index and review-log `<user_options>` blocks are answered, check project state and show one final `<user_options>`:

Before building options, read:
- `design/gdd/systems-index.md` — find any system with Status: In Review or NEEDS REVISION (other than the one just reviewed)
- Count `.md` files in `design/gdd/` (excluding game-concept.md, systems-index.md) to determine if `/review-all-gdds` is worth offering (≥2 GDDs)
- Find the next system with Status: Not Started in design order

Build the option list dynamically — only include options that are genuinely next:
- `[_] Run /design-review [other-gdd-path] — [system name] is still [In Review / NEEDS REVISION]` (include if another GDD needs review)
- `[_] Run /consistency-check — verify this GDD's values don't conflict with existing GDDs` (always include if ≥1 other GDD exists)
- `[_] Run /review-all-gdds — holistic design-theory review across all designed systems` (include if ≥2 GDDs exist)
- `[_] Run /design-system [next-system] — next in design order` (always include, name the actual system)
- `[_] Stop here`

Assign letters A, B, C… only to included options. Mark the most pipeline-advancing option as `(recommended)`.

Never end the skill with plain text after file writes. Always close with this `<user_options>` block.
