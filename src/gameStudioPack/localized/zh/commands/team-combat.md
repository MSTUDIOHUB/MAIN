---
name: team-combat
description: "编排多位专家协同处理战斗相关复杂特性。"
argument-hint: "[combat feature description]"
user-invocable: true
---

**Argument check:** If no combat feature description is provided, output:
> "Usage: `/team-combat [combat feature description]` — Provide a description of the combat feature to design and implement (e.g., `melee parry system`, `ranged weapon spread`)."
Then stop immediately without applying any specialist reviews or reading any files.

When this skill is invoked with a valid argument, orchestrate the combat team through a structured pipeline.

**Decision Points:** At each phase transition, present
the specialist review's proposals as selectable options. Write the agent's
full analysis in conversation, then capture the decision with concise labels.
The user must approve before moving to the next phase.

## Team Composition
- **game-designer** — Design the mechanic, define formulas and edge cases
- **gameplay-programmer** — Implement the core gameplay code
- **ai-programmer** — Implement NPC/enemy AI behavior for the feature
- **technical-artist** — Create VFX, shader effects, and visual feedback
- **sound-designer** — Define audio events, impact sounds, and ambient combat audio
- **engine specialist** (primary) — Validate architecture and implementation patterns are idiomatic for the engine (read from `.protocols/game-studio/docs/technical-preferences.md` Engine Specialists section)
- **qa-tester** — Write test cases and validate the implementation

## How to Apply Specialist Profiles

Apply each listed specialist profile as a separate review pass in the current MAIN run:
- `specialist profile: game-designer` — Design the mechanic, define formulas and edge cases
- `specialist profile: gameplay-programmer` — Implement the core gameplay code
- `specialist profile: ai-programmer` — Implement NPC/enemy AI behavior
- `specialist profile: technical-artist` — Create VFX, shader effects, visual feedback
- `specialist profile: sound-designer` — Define audio events, impact sounds, ambient audio
- `specialist profile: [primary engine specialist]` — Engine idiom validation for architecture and implementation
- `specialist profile: qa-tester` — Write test cases and validate implementation

Always provide full context in each agent's prompt (design doc path, relevant code files, constraints). Apply each specialist profile as a separate review pass in the current MAIN run, then synthesize the results before advancing.

## Pipeline

### Phase 1: Design
Apply the **game-designer** profile:
- Create or update the design document in `design/gdd/` covering: mechanic overview, player fantasy, detailed rules, formulas with variable definitions, edge cases, dependencies, tuning knobs with safe ranges, and acceptance criteria
- Output: completed design document

### Phase 2: Architecture
Apply the **gameplay-programmer** profile (with **ai-programmer** if AI is involved):
- Review the design document
- Design the code architecture: class structure, interfaces, data flow
- Identify integration points with existing systems
- Output: architecture sketch with file list and interface definitions

Then apply the **primary engine specialist** to validate the proposed architecture:
- Is the class/node/component structure idiomatic for the pinned engine? (e.g., Godot node hierarchy, Unity MonoBehaviour vs DOTS, Unreal Actor/Component design)
- Are there engine-native systems that should be used instead of custom implementations?
- Any proposed APIs that are deprecated or changed in the pinned engine version?
- Output: engine architecture notes — incorporate into the architecture before Phase 3 begins

### Phase 3: Implementation (parallel where possible)
Apply these specialist profiles as separate review passes:
- **gameplay-programmer**: Implement core combat mechanic code
- **ai-programmer**: Implement AI behaviors (if the feature involves NPC reactions)
- **technical-artist**: Create VFX and shader effects
- **sound-designer**: Define audio event list and mixing notes

### Phase 4: Integration
- Wire together gameplay code, AI, VFX, and audio
- Ensure all tuning knobs are exposed and data-driven
- Verify the feature works with existing combat systems

### Phase 5: Validation
Apply the **qa-tester** profile:
- Write test cases from the acceptance criteria
- Test all edge cases documented in the design
- Verify performance impact is within budget
- File bug reports for any issues found

### Phase 6: Sign-off
- Collect results from all team members
- 报告 feature status: COMPLETE / NEEDS WORK / BLOCKED
- List any outstanding issues and their assigned owners

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

The current MAIN run owns all file writes (design documents, implementation files, test cases). Specialist review passes only produce analysis and verdicts. Before each write, the main run lists the target path and requests approval.

## 输出

A summary report covering: design completion status, implementation status per team member, test results, and any open issues.

结论: **COMPLETE** — combat feature designed, implemented, and validated.
结论: **BLOCKED** — one or more phases could not complete; partial report produced with unresolved items listed.

## 下一步

- Run `/code-review` on the implemented combat code before closing stories.
- Run `/balance-check` to validate combat formulas and tuning values.
- Run `/team-polish` if VFX, audio, or performance polish is needed.
