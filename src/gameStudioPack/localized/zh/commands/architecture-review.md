---
name: architecture-review
description: "审查架构完整性、依赖顺序、引擎适配和潜在技术风险。"
argument-hint: "[focus: full | coverage | consistency | engine | single-gdd path/to/gdd.md]"
user-invocable: true
---

# Architecture Review

The architecture review validates that the complete body of architectural decisions
covers all game design requirements, is internally consistent, and correctly targets
the project's pinned engine version. It is the quality gate between Technical Setup
and Pre-Production.

**Argument modes:**
- **No argument / `full`**: Full review — all phases
- **`coverage`**: Traceability only — which GDD requirements have no ADR
- **`consistency`**: Cross-ADR conflict detection only
- **`engine`**: Engine compatibility audit only
- **`single-gdd [path]`**: Review architecture coverage for one specific GDD
- **`rtm`**: Requirements Traceability Matrix — extends the standard matrix
  to include story file paths and test file paths; outputs
  `docs/architecture/requirements-traceability.md` with the full
  GDD requirement → ADR → Story → Test chain. Use in Production phase when
  stories and tests exist.

---

## 阶段 1: Load Everything

### Phase 1a — L0: Summary Scan (fast, low tokens)

Before reading any full document, use grep_search to extract `## Summary` sections
from all GDDs and ADRs:

```
`grep_search` pattern="## Summary" glob="design/gdd/*.md" output_mode="content" -A 4
`grep_search` pattern="## Summary" glob="docs/architecture/adr-*.md" output_mode="content" -A 3
```

For `single-gdd [path]` mode: use the target GDD's summary to identify which
ADRs reference the same system (`grep_search` ADRs for the system name), then full-read
only those ADRs. Skip full-reading unrelated GDDs entirely.

For `engine` mode: only full-read ADRs — GDDs are not needed for engine checks.

For `coverage` or `full` mode: proceed to full-read everything below.

### Phase 1b — L1/L2: Full Document Load

Read all inputs appropriate to the mode:

### Design Documents
- All in-scope GDDs in `design/gdd/` — read every file completely
- `design/gdd/systems-index.md` — the authoritative list of systems

### Architecture Documents
- All in-scope ADRs in `docs/architecture/` — read every file completely
- `docs/architecture/architecture.md` if it exists

### Engine Reference
- `docs/engine-reference/[engine]/VERSION.md`
- `docs/engine-reference/[engine]/breaking-changes.md`
- `docs/engine-reference/[engine]/deprecated-apis.md`
- All files in `docs/engine-reference/[engine]/modules/`

### Project Standards
- `.protocols/game-studio/docs/technical-preferences.md`

报告 a count: "Loaded [N] GDDs, [M] ADRs, engine: [name + version]."

**Also read `docs/consistency-failures.md`** if it exists. Extract entries with
Domain matching the systems under review (Architecture, Engine, or any GDD domain
being covered). Surface recurring patterns as a "Known conflict-prone areas" note
at the top of the Phase 4 conflict detection output.

---

## 阶段 2: Extract Technical Requirements from Every GDD

### Pre-load the TR Registry

Before extracting any requirements, read `docs/architecture/tr-registry.yaml`
if it exists. Index existing entries by `id` and by normalized `requirement`
text (lowercase, trimmed). This prevents ID renumbering across review runs.

For each requirement you extract, the matching rule is:
1. **Exact/near match** to an existing registry entry for the same system →
   reuse that entry's TR-ID unchanged. Update the `requirement` text in the
   registry only if the GDD wording changed (same intent, clearer phrasing) —
   add a `revised: [date]` field.
2. **No match** → assign a new ID: next available `TR-[system]-NNN` for that
   system, starting from the highest existing sequence + 1.
3. **Ambiguous** (partial match, intent unclear) → ask the user:
   > "Does '[new requirement text]' refer to the same requirement as
   > `TR-[system]-NNN: [existing text]'`, or is it a new requirement?"
   User answers: "Same requirement" (reuse ID) or "New requirement" (new ID).

For any requirement with `status: deprecated` in the registry — skip it.
It was removed from the GDD intentionally.

For each GDD, read it and extract all **technical requirements** — things the
architecture must provide for the system to work. A technical requirement is any
statement that implies a specific architectural decision.

Categories to extract:

| Category | Example |
|----------|---------|
| **Data structures** | "Each entity has health, max health, status effects" → needs a component/data schema |
| **Performance constraints** | "Collision detection must run at 60fps with 200 entities" → physics budget ADR |
| **Engine capability** | "Inverse kinematics for character animation" → IK system ADR |
| **Cross-system communication** | "Damage system notifies UI and audio simultaneously" → event/signal architecture ADR |
| **State persistence** | "Player progress persists between sessions" → save system ADR |
| **Threading/timing** | "AI decisions happen off the main thread" → concurrency ADR |
| **Platform requirements** | "Supports keyboard, gamepad, touch" → input system ADR |

For each GDD, produce a structured list:

```
GDD: [filename]
System: [system name]
Technical Requirements:
  TR-[GDD]-001: [requirement text] → Domain: [Physics/Rendering/etc]
  TR-[GDD]-002: [requirement text] → Domain: [...]
```

This becomes the **requirements baseline** — the complete set of what the
architecture must cover.

---

## 阶段 3: Build the Traceability Matrix

For each technical requirement extracted in Phase 2, search the ADRs:

1. Read every ADR's "GDD Requirements Addressed" section
2. 检查 if it explicitly references the requirement or its GDD
3. 检查 if the ADR's decision text implicitly covers the requirement
4. Mark coverage status:

| Status | Meaning |
|--------|---------|
| ✅ **Covered** | An ADR explicitly addresses this requirement |
| ⚠️ **Partial** | An ADR partially covers this, or coverage is ambiguous |
| ❌ **Gap** | No ADR addresses this requirement |

Build the full matrix:

```
## Traceability Matrix

| Requirement ID | GDD | System | Requirement | ADR Coverage | Status |
|---------------|-----|--------|-------------|--------------|--------|
| TR-combat-001 | combat.md | Combat | Hitbox detection < 1 frame | ADR-0003 | ✅ |
| TR-combat-002 | combat.md | Combat | Combo window timing | — | ❌ GAP |
| TR-inventory-001 | inventory.md | Inventory | Persistent item storage | ADR-0005 | ✅ |
```

Count the totals: X covered, Y partial, Z gaps.

---

## 阶段 3b: Story and Test Linkage (RTM mode only)

*Skip this phase unless the argument is `rtm` or `full` with stories present.*

This phase extends the Phase 3 matrix to include the story that implements
each requirement and the test that verifies it — producing the full
Requirements Traceability Matrix (RTM).

### Step 3b-1 — Load stories

`glob_search` `production/epics/**/*.md` (excluding EPIC.md index files). For each
story file:
- Extract `TR-ID` from the story's Context section
- Extract story file path, title, Status
- Extract `## Test Evidence` section — the stated test file path

### Step 3b-2 — Load test files

`glob_search` `tests/unit/**/*_test.*` and `tests/integration/**/*_test.*`.
Build an index: system → [test file paths].

For each test file path from Step 3b-1, confirm via `glob_search` whether the file
actually exists. Note MISSING if the stated path does not exist.

### Step 3b-3 — Build the extended RTM

For each TR-ID in the Phase 3 matrix, add:
- **Story**: the story file path(s) that reference this TR-ID (may be multiple)
- **Test File**: the test file path stated in the story's Test Evidence section
- **Test Status**: COVERED (test file exists) / MISSING (path stated but not
  found) / NONE (no test path stated, story type may be Visual/Feel/UI) /
  NO STORY (requirement has no story yet — pre-production gap)

Extended matrix format:

```
## Requirements Traceability Matrix (RTM)

| TR-ID | GDD | Requirement | ADR | Story | Test File | Test Status |
|-------|-----|-------------|-----|-------|-----------|-------------|
| TR-combat-001 | combat.md | Hitbox < 1 frame | ADR-0003 | story-001-hitbox.md | tests/unit/combat/hitbox_test.gd | COVERED |
| TR-combat-002 | combat.md | Combo window | — | story-002-combo.md | — | NONE (Visual/Feel) |
| TR-inventory-001 | inventory.md | Persistent storage | ADR-0005 | — | — | NO STORY |
```

RTM coverage summary:
- COVERED: [N] — requirements with ADR + story + passing test
- MISSING test: [N] — story exists but test file not found
- NO STORY: [N] — requirements with ADR but no story yet
- NO ADR: [N] — requirements without architectural coverage (from Phase 3 gaps)
- Full chain complete (COVERED): [N/total] ([%])

---

## 阶段 4: Cross-ADR Conflict Detection

Compare every ADR against every other ADR to detect contradictions. A conflict
exists when:

- **Data ownership conflict**: Two ADRs claim exclusive ownership of the same data
- **Integration contract conflict**: ADR-A assumes System X has interface Y, but
  ADR-B defines System X with a different interface
- **Performance budget conflict**: ADR-A allocates N ms to physics, ADR-B allocates
  N ms to AI, together they exceed the total frame budget
- **Dependency cycle**: ADR-A says System X initialises before Y; ADR-B says Y
  initialises before X
- **Architecture pattern conflict**: ADR-A uses event-driven communication for a
  subsystem; ADR-B uses direct function calls to the same subsystem
- **State management conflict**: Two ADRs define authority over the same game state
  (e.g. both Combat ADR and Character ADR claim to own the health value)

For each conflict found:

```
## Conflict: [ADR-NNNN] vs [ADR-MMMM]
Type: [Data ownership / Integration / Performance / Dependency / Pattern / State]
ADR-NNNN claims: [...]
ADR-MMMM claims: [...]
Impact: [What breaks if both are implemented as written]
Resolution options:
  1. [Option A]
  2. [Option B]
```

### ADR Dependency Ordering

After conflict detection, analyse the dependency graph across all ADRs:

1. **Collect all `Depends On` fields** from every ADR's "ADR Dependencies" section
2. **Topological sort**: Determine the correct implementation order — ADRs with no
   dependencies come first (Foundation), ADRs that depend on those come next, etc.
3. **Flag unresolved dependencies**: If ADR-A's "Depends On" field references an ADR
   that is still `Proposed` or does not exist, flag it:
   ```
   ⚠️  ADR-0005 depends on ADR-0002 — but ADR-0002 is still Proposed.
       ADR-0005 cannot be safely implemented until ADR-0002 is Accepted.
   ```
4. **Cycle detection**: If ADR-A depends on ADR-B and ADR-B depends on ADR-A (directly
   or transitively), flag it as a `DEPENDENCY CYCLE`:
   ```
   🔴 DEPENDENCY CYCLE: ADR-0003 → ADR-0006 → ADR-0003
      This cycle must be broken before either can be implemented.
   ```
5. **Output recommended implementation order**:
   ```
   ### Recommended ADR Implementation Order (topologically sorted)
   Foundation (no dependencies):
     1. ADR-0001: [title]
     2. ADR-0003: [title]
   Depends on Foundation:
     3. ADR-0002: [title] (requires ADR-0001)
     4. ADR-0005: [title] (requires ADR-0003)
   Feature layer:
     5. ADR-0004: [title] (requires ADR-0002, ADR-0005)
   ```

---

## 阶段 5: Engine Compatibility Cross-检查

Across all ADRs, check for engine consistency:

### Version Consistency
- Do all ADRs that mention an engine version agree on the same version?
- If any ADR was written for an older engine version, flag it as potentially stale

### Post-Cutoff API Consistency
- Collect all "Post-Cutoff APIs Used" fields from all ADRs
- For each, verify against the relevant module reference doc
- 检查 that no two ADRs make contradictory assumptions about the same post-cutoff API

### Deprecated API 检查
- `grep_search` all ADRs for API names listed in `deprecated-apis.md`
- Flag any ADR referencing a deprecated API

### Missing Engine Compatibility Sections
- List all ADRs that are missing the Engine Compatibility section entirely
- These are blind spots — their engine assumptions are unknown

Output format:
```
### Engine Audit Results
Engine: [name + version]
ADRs with Engine Compatibility section: X / Y total

Deprecated API References:
  - ADR-0002: uses [deprecated API] — deprecated since [version]

Stale Version References:
  - ADR-0001: written for [older version] — current project version is [version]

Post-Cutoff API Conflicts:
  - ADR-0004 and ADR-0007 both use [API] with incompatible assumptions
```

---

### Engine Specialist Consultation

After completing the engine audit above, apply the **primary engine specialist** using its specialist profile for a domain-expert second opinion:
- Read `.protocols/game-studio/docs/technical-preferences.md` `Engine Specialists` section to get the primary specialist
- If no engine is configured, skip this consultation
- Apply `specialist profile: [primary specialist]` with: all ADRs that contain engine-specific decisions or `Post-Cutoff APIs Used` fields, the engine reference docs, and the Phase 5 audit findings. Ask them to:
  1. Confirm or challenge each audit finding — specialists may know of engine nuances not captured in the reference docs
  2. Identify engine-specific anti-patterns in the ADRs that the audit may have missed (e.g., using the wrong Godot node type, Unity component coupling, Unreal subsystem misuse)
  3. Flag ADRs that make assumptions about engine behaviour that differ from the actual pinned version

Incorporate additional findings under `### Engine Specialist Findings` in the Phase 5 output. These feed into the final verdict — specialist-identified issues carry the same weight as audit-identified issues.

---

## 阶段 5b: Design Revision Flags (Architecture → GDD Feedback)

For each **HIGH RISK engine finding** from Phase 5, check whether any GDD makes an
assumption that the verified engine reality contradicts.

Specific cases to check:

1. **Post-cutoff API behaviour differs from training-data assumptions**: If an ADR
   records a verified API behaviour that differs from the default LLM assumption,
   check all GDDs that reference the related system. Look for design rules written
   around the old (assumed) behaviour.

2. **Known engine limitations in ADRs**: If an ADR records a known engine limitation
   (e.g. "Jolt ignores HingeJoint3D damp", "D3D12 is now the default backend"), check
   GDDs that design mechanics around the affected feature.

3. **Deprecated API conflicts**: If Phase 5 flagged a deprecated API used in an ADR,
   check whether any GDD contains mechanics that assume the deprecated API's behaviour.

For each conflict found, record it in the GDD Revision Flags table:

```
### GDD Revision Flags (Architecture → Design Feedback)
These GDD assumptions conflict with verified engine behaviour or accepted ADRs.
The GDD should be revised before its system enters implementation.

| GDD | Assumption | Reality (from ADR/engine-reference) | Action |
|-----|-----------|--------------------------------------|--------|
| combat.md | "Use HingeJoint3D damp for weapon recoil" | Jolt ignores damp — ADR-0003 | Revise GDD |
```

If no revision flags are found, write: "No GDD revision flags — all GDD assumptions
are consistent with verified engine behaviour."

Ask: "Should I flag these GDDs for revision in the systems index?"
- If yes: update the relevant systems' Status field to "Needs Revision"
  and add a short inline note in the adjacent Notes/Description column explaining the conflict.
  Ask for approval before writing.
  (Do NOT use parentheticals like "Needs Revision (Architecture Feedback)" — other skills
  match the exact string "Needs Revision" and parentheticals break that match.)

---

## 阶段 6: Architecture Document Coverage

If `docs/architecture/architecture.md` exists, validate it against GDDs:

- Does every system from `systems-index.md` appear in the architecture layers?
- Does the data flow section cover all cross-system communication defined in GDDs?
- Do the API boundaries support all integration requirements from GDDs?
- Are there systems in the architecture doc that have no corresponding GDD
  (orphaned architecture)?

---

## 阶段 7: Output the Review 报告

```
## Architecture Review 报告
Date: [date]
Engine: [name + version]
GDDs Reviewed: [N]
ADRs Reviewed: [M]

---

### Traceability Summary
Total requirements: [N]
✅ Covered: [X]
⚠️ Partial: [Y]
❌ Gaps: [Z]

### Coverage Gaps (no ADR exists)
For each gap:
  ❌ TR-[id]: [GDD] → [system] → [requirement]
     Suggested ADR: "/architecture-decision [suggested title]"
     Domain: [Physics/Rendering/etc]
     Engine Risk: [LOW/MEDIUM/HIGH]

### Cross-ADR Conflicts
[List all conflicts from Phase 4]

### ADR Dependency Order
[Topologically sorted implementation order from Phase 4 — dependency ordering section]
[Unresolved dependencies and cycles if any]

### GDD Revision Flags
[GDD assumptions that conflict with verified engine behaviour — from Phase 5b]
[Or: "None — all GDD assumptions consistent with verified engine behaviour"]

### Engine Compatibility Issues
[List all engine issues from Phase 5]

### Architecture Document Coverage
[List missing systems and orphaned architecture from Phase 6]

---

### 结论: [PASS / CONCERNS / FAIL]

PASS: All requirements covered, no conflicts, engine consistent
CONCERNS: Some gaps or partial coverage, but no blocking conflicts
FAIL: Critical gaps (Foundation/Core layer requirements uncovered),
      or blocking cross-ADR conflicts detected

### Blocking Issues (must resolve before PASS)
[List items that must be resolved — FAIL verdict only]

### 必需 ADRs
[Prioritised list of ADRs to create, most foundational first]
```

---

## 阶段 8: Write and Update Traceability Index

Ask the user for the write approval:
- "Review complete. What would you like to write?"
  - [A] Write all three files (review report + traceability index + TR registry)
  - [B] Write review report only — `docs/architecture/architecture-review-[date].md`
  - [C] Don't write anything yet — I need to review the findings first

### RTM Output (rtm mode only)

For `rtm` mode, additionally ask: "May I write the full Requirements Traceability
Matrix to `docs/architecture/requirements-traceability.md`?"

RTM file format:

```markdown
# Requirements Traceability Matrix (RTM)

> Last Updated: [date]
> Mode: /architecture-review rtm
> Coverage: [N]% full chain complete (GDD → ADR → Story → Test)

## How to read this matrix

| Column | Meaning |
|--------|---------|
| TR-ID | Stable requirement ID from tr-registry.yaml |
| GDD | Source design document |
| ADR | Architectural decision governing implementation |
| Story | Story file that implements this requirement |
| Test File | Automated test file path |
| Test Status | COVERED / MISSING / NONE / NO STORY |

## Full Traceability Matrix

| TR-ID | GDD | Requirement | ADR | Story | Test File | Status |
|-------|-----|-------------|-----|-------|-----------|--------|
[Full matrix rows from Phase 3b]

## Coverage Summary

| Status | Count | % |
|--------|-------|---|
| COVERED — full chain complete | [N] | [%] |
| MISSING test — story exists, no test | [N] | [%] |
| NO STORY — ADR exists, not yet implemented | [N] | [%] |
| NO ADR — architectural gap | [N] | [%] |
| **Total requirements** | **[N]** | **100%** |

## Uncovered Requirements (Priority Fix List)

Requirements where the full chain is broken, prioritised by layer:

### Foundation layer gaps
[list with suggested action per gap]

### Core layer gaps
[list]

### Feature / Presentation layer gaps
[list — lower priority]

## History

| Date | Full Chain % | Notes |
|------|-------------|-------|
| [date] | [%] | Initial RTM |
```

### TR Registry Update

Also ask: "May I update `docs/architecture/tr-registry.yaml` with new requirement
IDs from this review?"

If yes:
- **Append** any new TR-IDs that weren't in the registry before this review
- **Update** `requirement` text and `revised` date for any entries whose GDD
  wording changed (ID stays the same)
- **Mark** `status: deprecated` for any registry entries whose GDD requirement
  no longer exists (confirm with user before marking deprecated)
- **Never** renumber or delete existing entries
- Update the `last_updated` and `version` fields at the top

This ensures all future story files can reference stable TR-IDs that persist
across every subsequent architecture review.

### Reflexion Log Update

After writing the review report, append any 🔴 CONFLICT entries found in Phase 4
to `docs/consistency-failures.md` (if the file exists):

```markdown
### [YYYY-MM-DD] — /architecture-review — 🔴 CONFLICT
**Domain**: Architecture / [specific domain e.g. State Ownership, Performance]
**Documents involved**: [ADR-NNNN] vs [ADR-MMMM]
**What happened**: [specific conflict — what each ADR claims]
**Resolution**: [how it was or should be resolved]
**Pattern**: [generalised lesson for future ADR authors in this domain]
```

Only append CONFLICT entries — do not log GAP entries (missing ADRs are expected
before the architecture is complete). Do not create the file if missing — only
append when it already exists.

### Session State Update

After writing all approved files, silently append to
`production/session-state/active.md`:

    ## Session Extract — /architecture-review [date]
    - 结论: [PASS / CONCERNS / FAIL]
    - Requirements: [N] total — [X] covered, [Y] partial, [Z] gaps
    - New TR-IDs registered: [N, or "None"]
    - GDD revision flags: [comma-separated GDD names, or "None"]
    - Top ADR gaps: [top 3 gap titles from the report, or "None"]
    - 报告: docs/architecture/architecture-review-[date].md

If `active.md` does not exist, create it with this block as the initial content.
Confirm in conversation: "Session state updated."

The traceability index format:

```markdown
# Architecture Traceability Index
Last Updated: [date]
Engine: [name + version]

## Coverage Summary
- Total requirements: [N]
- Covered: [X] ([%])
- Partial: [Y]
- Gaps: [Z]

## Full Matrix
[完成 traceability matrix from Phase 3]

## Known Gaps
[All ❌ items with suggested ADRs]

## Superseded Requirements
[Requirements whose GDD was changed after the ADR was written]
```

---

## 阶段 9: Handoff

After completing the review and writing approved files, present:

1. **Immediate actions**: List the top 3 ADRs to create (highest-impact gaps first,
   Foundation layer before Feature layer)
2. **Gate guidance**: "When all blocking issues are resolved, run `/gate-check
   pre-production` to advance"
3. **Rerun trigger**: "Re-run `/architecture-review` after each new ADR is written
   to verify coverage improves"

Then close with `<user_options>`:
- "Architecture review complete. What would you like to do next?"
  - [A] Write a missing ADR — open a fresh session and run `/architecture-decision [system]`
  - [B] Run `/gate-check pre-production` — if all blocking gaps are resolved
  - [C] Stop here for this session

---

## Error Recovery Protocol

If a specialist review identifies a blocker or cannot produce a verdict:

1. **Surface immediately**: 报告 "[AgentName]: BLOCKED — [reason]" before continuing
2. **Assess dependencies**: If the blocked review's output is required by a later phase, do not proceed past that phase without user input
3. **Offer options** in one flat `<user_options>` block:
   - Skip this review pass and note the gap in the final report
   - Retry with narrower scope (fewer GDDs, single-system focus)
   - Stop here and resolve the blocker first
4. **Always produce a partial report** — output whatever was completed so work is not lost

---

## 协作协议

1. **Read silently** — do not narrate every file read
2. **Show the matrix** — present the full traceability matrix before asking for
   anything; let the user see the state
3. **Don't guess** — if a requirement is ambiguous, ask: "Is [X] a technical
   requirement or a design preference?"
4. **Ask before writing** — always confirm before writing the report file
5. **Non-blocking** — the verdict is advisory; the user decides whether to continue
   despite CONCERNS or even FAIL findings
