---
name: team-polish
description: "Orchestrate the polish team: coordinates performance-analyst, technical-artist, sound-designer, and qa-tester to optimize, polish, and harden a feature or area for release quality."
argument-hint: "[feature or area to polish]"
user-invocable: true
---
If no argument is provided, output usage guidance and exit without applying any agents:
> Usage: `/team-polish [feature or area]` — specify the feature or area to polish (e.g., `combat`, `main menu`, `inventory system`, `level-1`). Do not ask the user here; output the guidance directly.

When this skill is invoked with an argument, orchestrate the polish team through a structured pipeline.

**Decision Points:** At each phase transition, present
the specialist review's proposals as selectable options. Write the agent's
full analysis in conversation, then capture the decision with concise labels.
The user must approve before moving to the next phase.

## Team Composition
- **performance-analyst** — Profiling, optimization, memory analysis, frame budget
- **engine-programmer** — Engine-level bottlenecks: rendering pipeline, memory, resource loading (invoke when performance-analyst identifies low-level root causes)
- **technical-artist** — VFX polish, shader optimization, visual quality
- **sound-designer** — Audio polish, mixing, ambient layers, feedback sounds
- **tools-programmer** — Content pipeline tool verification, editor tool stability, automation fixes (invoke when content authoring tools are involved in the polished area)
- **qa-tester** — Edge case testing, regression testing, soak testing

## How to Apply Specialist Profiles

Apply each listed specialist profile as a separate review pass in the current MAIN run:
- `specialist profile: performance-analyst` — Profiling, optimization, memory analysis
- `specialist profile: engine-programmer` — Engine-level fixes for rendering, memory, resource loading
- `specialist profile: technical-artist` — VFX polish, shader optimization, visual quality
- `specialist profile: sound-designer` — Audio polish, mixing, ambient layers
- `specialist profile: tools-programmer` — Content pipeline and editor tool verification
- `specialist profile: qa-tester` — Edge case testing, regression testing, soak testing

Always provide full context in each agent's prompt (target feature/area, performance budgets, known issues). Apply each specialist profile as a separate review pass in the current MAIN run, then synthesize the results before advancing.

## Pipeline

### Phase 1: Assessment
Apply the **performance-analyst** profile:
- Profile the target feature/area using `/perf-profile`
- Identify performance bottlenecks and frame budget violations
- Measure memory usage and check for leaks
- Benchmark against target hardware specs
- Output: performance report with prioritized optimization list

### Phase 2: Optimization
Apply the **performance-analyst** profile (with relevant programmers as needed):
- Fix performance hotspots identified in Phase 1
- Optimize draw calls, reduce overdraw
- Fix memory leaks and reduce allocation pressure
- Verify optimizations don't change gameplay behavior
- Output: optimized code with before/after metrics

If Phase 1 identified engine-level root causes (rendering pipeline, resource loading, memory allocator), apply the **engine-programmer** profile as a separate review pass:
- Optimize hot paths in engine systems
- Fix allocation pressure in core loops
- Output: engine-level fixes with profiler validation

### Phase 3: Visual Polish (parallel with Phase 2)
Apply the **technical-artist** profile:
- Review VFX for quality and consistency with art bible
- Optimize particle systems and shader effects
- Add screen shake, camera effects, and visual juice where appropriate
- Ensure effects degrade gracefully on lower settings
- Output: polished visual effects

### Phase 4: Audio Polish (parallel with Phase 2)
Apply the **sound-designer** profile:
- Review audio events for completeness (are any actions missing sound feedback?)
- Check audio mix levels — nothing too loud or too quiet relative to the mix
- Add ambient audio layers for atmosphere
- Verify audio plays correctly with spatial positioning
- Output: audio polish list and mixing notes

### Phase 5: Hardening
Apply the **qa-tester** profile:
- Test all edge cases: boundary conditions, rapid inputs, unusual sequences
- Soak test: run the feature for extended periods checking for degradation
- Stress test: maximum entities, worst-case scenarios
- Regression test: verify polish changes haven't broken existing functionality
- Test on minimum spec hardware (if available)
- Output: test results with any remaining issues

### Phase 6: Sign-off
- Collect results from all team members
- Compare performance metrics against budgets
- Report: READY FOR RELEASE / NEEDS MORE WORK
- List any remaining issues with severity and recommendations

## Error Recovery Protocol

If a specialist review identifies a blocker or cannot produce a verdict:

1. **Surface immediately**: Report "[SpecialistProfile]: BLOCKED — [reason]" to the user before continuing to dependent phases
2. **Assess dependencies**: Check whether the blocked review's output is required by subsequent phases. If yes, do not proceed past that dependency point without user input.
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

The current MAIN run owns all file writes (performance reports, test results, evidence docs). Specialist review passes only produce analysis and verdicts. Before each write, the main run lists the target path and requests approval.

## Output

A summary report covering: performance before/after metrics, visual polish changes, audio polish changes, test results, and release readiness assessment.

## Next Steps

- If READY FOR RELEASE: run `/release-checklist` for the final pre-release validation.
- If NEEDS MORE WORK: schedule remaining issues in `/sprint-plan update` and re-run `/team-polish` after fixes.
- Run `/gate-check` for a formal phase gate verdict before handing off to release.
