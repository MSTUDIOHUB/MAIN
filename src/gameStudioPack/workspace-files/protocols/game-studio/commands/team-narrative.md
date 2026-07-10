---
name: team-narrative
description: "Orchestrate the narrative team: coordinates narrative-director, writer, world-builder, and level-designer to create cohesive story content, world lore, and narrative-driven level design."
argument-hint: "[narrative content description]"
user-invocable: true
---
If no argument is provided, output usage guidance and exit without applying any agents:
> Usage: `/team-narrative [narrative content description]` — describe the story content, scene, or narrative area to work on (e.g., `boss encounter cutscene`, `faction intro dialogue`, `tutorial narrative`). Do not ask the user here; output the guidance directly.

When this skill is invoked with an argument, orchestrate the narrative team through a structured pipeline.

**Decision Points:** At each phase transition, present
the specialist review's proposals as selectable options. Write the agent's
full analysis in conversation, then capture the decision with concise labels.
The user must approve before moving to the next phase.

## Team Composition
- **narrative-director** — Story arcs, character design, dialogue strategy, narrative vision
- **writer** — Dialogue writing, lore entries, item descriptions, in-game text
- **world-builder** — World rules, faction design, history, geography, environmental storytelling
- **art-director** — Character visual design, environmental visual storytelling, cutscene/cinematic tone
- **level-designer** — Level layouts that serve the narrative, pacing, environmental storytelling beats

## How to Apply Specialist Profiles

Apply each listed specialist profile as a separate review pass in the current MAIN run:
- `specialist profile: narrative-director` — Story arcs, character design, narrative vision
- `specialist profile: writer` — Dialogue writing, lore entries, in-game text
- `specialist profile: world-builder` — World rules, faction design, history, geography
- `specialist profile: art-director` — Character visual profiles, environmental visual storytelling, cinematic tone
- `specialist profile: level-designer` — Level layouts that serve the narrative, pacing
- `specialist profile: localization-lead` — i18n validation, string key compliance, translation headroom

Always provide full context in each agent's prompt (narrative brief, lore dependencies, character profiles). Apply each specialist profile as a separate review pass in the current MAIN run, then synthesize the results before advancing.

## Pipeline

### Phase 1: Narrative Direction
Apply the **narrative-director** profile:
- Define the narrative purpose of this content: what story beat does it serve?
- Identify characters involved, their motivations, and how this fits the overall arc
- Set the emotional tone and pacing targets
- Specify any lore dependencies or new lore this introduces
- Output: narrative brief with story requirements

### Phase 2: World Foundation (parallel)
Apply these specialist profiles as separate review passes:
- **world-builder**: Create or update lore entries for factions, locations, and history relevant to this content. Cross-reference against existing lore for contradictions. Set canon level for new entries.
- **writer**: Draft character dialogue using voice profiles. Ensure all lines are under 120 characters, use named placeholders for variables, and are localization-ready.
- **art-director**: Define character visual design direction for key characters appearing in this content (silhouette, visual archetype, distinguishing features). Specify environmental visual storytelling elements for each key space (prop composition, lighting notes, spatial arrangement). Define tone palette and cinematic direction for any cutscenes or scripted sequences.

### Phase 3: Level Narrative Integration
Apply the **level-designer** profile:
- Review the narrative brief and lore foundation
- Design environmental storytelling elements in the level
- Place narrative triggers, dialogue zones, and discovery points
- Ensure pacing serves both gameplay and story

### Phase 4: Review and Consistency
Apply the **narrative-director** profile:
- Review all dialogue against character voice profiles
- Verify lore consistency across new and existing entries
- Confirm narrative pacing aligns with level design
- Check that all mysteries have documented "true answers"

### Phase 5: Polish (parallel)
Apply these specialist profiles as separate review passes:
- **writer**: Final self-review — verify no line exceeds dialogue box constraints, all text uses string keys (not raw strings), placeholder variable names are consistent
- **localization-lead**: Validate i18n compliance — check string key naming conventions, flag any strings with hardcoded formatting that won't survive translation, verify character limit headroom for languages that expand (German/Finnish typically +30%), confirm no cultural assumptions in text that would need locale-specific variants
- **world-builder**: Finalize canon levels for all new lore entries

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

The current MAIN run owns all file writes (narrative docs, dialogue files, lore entries). Specialist review passes only produce analysis and verdicts. Before each write, the main run lists the target path and requests approval.

## Output

A summary report covering: narrative brief status, lore entries created/updated, dialogue lines written, level narrative integration points, consistency review results, and any unresolved contradictions.

Verdict: **COMPLETE** — narrative content delivered.

If the pipeline stops because a dependency is unresolved (e.g., lore contradiction or missing prerequisite not resolved by the user):

Verdict: **BLOCKED** — [reason]

## Next Steps

- Run `/design-review` on the narrative documents for consistency validation.
- Run `/localize extract` to extract new strings for translation after dialogue is finalized.
- Run `/dev-story` to implement dialogue triggers and narrative events in-engine.
