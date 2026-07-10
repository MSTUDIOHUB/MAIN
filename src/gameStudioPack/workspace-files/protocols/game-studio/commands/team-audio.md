---
name: team-audio
description: "Orchestrate audio team: audio-director + sound-designer + technical-artist + gameplay-programmer for full audio pipeline from direction to implementation."
argument-hint: "[feature or area to design audio for]"
user-invocable: true
---

If no argument is provided, output usage guidance and exit without applying any agents:
> Usage: `/team-audio [feature or area]` — specify the feature or area to design audio for (e.g., `combat`, `main menu`, `forest biome`, `boss encounter`). Do not ask the user here; output the guidance directly.

When this skill is invoked with an argument, orchestrate the audio team through a structured pipeline.

**Decision Points:** At each step transition, present
the specialist review's proposals as selectable options. Write the agent's
full analysis in conversation, then capture the decision with concise labels.
The user must approve before moving to the next step.

1. **Read the argument** for the target feature or area (e.g., `combat`,
   `main menu`, `forest biome`, `boss encounter`).

2. **Gather context**:
   - Read relevant design docs in `design/gdd/` for the feature
   - Read the sound bible at `design/gdd/sound-bible.md` if it exists
   - Read existing audio asset lists in `assets/audio/`
   - Read any existing sound design docs for this area

## How to Apply Specialist Profiles

Apply each listed specialist profile as a separate review pass in the current MAIN run:
- `specialist profile: audio-director` — Sonic identity, emotional tone, audio palette
- `specialist profile: sound-designer` — SFX specifications, audio events, mixing groups
- `specialist profile: technical-artist` — Audio middleware, bus structure, memory budgets
- `specialist profile: [primary engine specialist]` — Validate audio integration patterns for the engine
- `specialist profile: gameplay-programmer` — Audio manager, gameplay triggers, adaptive music

Always provide full context in each agent's prompt (feature description, existing audio assets, design doc references).

3. **Orchestrate the audio team** in sequence:

### Step 1: Audio Direction (audio-director)
Apply the `audio-director` agent to:
- Define the sonic identity for this feature/area
- Specify the emotional tone and audio palette
- Set music direction (adaptive layers, stems, transitions)
- Define audio priorities and mix targets
- Establish any adaptive audio rules (combat intensity, exploration, tension)

### Step 2: Sound Design and Audio Accessibility (parallel)
Apply the `sound-designer` agent to:
- Create detailed SFX specifications for every audio event
- Define sound categories (ambient, UI, gameplay, music, dialogue)
- Specify per-sound parameters (volume range, pitch variation, attenuation)
- Plan audio event list with trigger conditions
- Define mixing groups and ducking rules

Apply the `accessibility-specialist` profile as a separate review pass to:
- Identify which audio events carry critical gameplay information (damage received, enemy nearby, objective complete) and require visual alternatives for hearing-impaired players
- Specify subtitle requirements: which audio events need captions, what text format, on-screen duration
- Check that no gameplay state is communicated by audio alone (all must have a visual fallback)
- Review the audio event list for any that could cause issues for players with auditory sensitivities (high-frequency alerts, sudden loud events)
- Output: audio accessibility requirements list integrated into the audio event spec

### Step 3: Technical Implementation (parallel)
Apply the `technical-artist` agent to:
- Design the audio middleware integration (Wwise/FMOD/native)
- Define audio bus structure and routing
- Specify memory budgets for audio assets per platform
- Plan streaming vs preloaded asset strategy
- Design any audio-reactive visual effects

Apply the **primary engine specialist** as a separate review pass (from `.protocols/game-studio/docs/technical-preferences.md` Engine Specialists) to validate the integration approach:
- Is the proposed audio middleware integration idiomatic for the engine? (e.g., Godot's built-in AudioStreamPlayer vs FMOD, Unity's Audio Mixer vs Wwise, Unreal's MetaSounds vs FMOD)
- Any engine-specific audio node/component patterns that should be used?
- Known audio system changes in the pinned engine version that affect the integration plan?
- Output: engine audio integration notes to merge with the technical-artist's plan

If no engine is configured, skip the specialist apply.

### Step 4: Code Integration (gameplay-programmer)
Apply the `gameplay-programmer` agent to:
- Implement audio manager system or review existing
- Wire up audio events to gameplay triggers
- Implement adaptive music system (if specified)
- Set up audio occlusion/reverb zones
- Write unit tests for audio event triggers

4. **Compile the audio design document** combining all team outputs.

5. **Save to** `design/gdd/audio-[feature].md`.

6. **Output a summary** with: audio event count, estimated asset count,
   implementation tasks, and any open questions between team members.

Verdict: **COMPLETE** — audio design document produced and team pipeline finished.

If the pipeline stops because a dependency is unresolved (e.g., critical accessibility gap or missing GDD not resolved by the user):

Verdict: **BLOCKED** — [reason]

## File Write Protocol

The current MAIN run owns all file writes (audio design docs, SFX specs, implementation files). Specialist review passes only produce analysis and verdicts. Before each write, the main run lists the target path and requests approval.

## Next Steps

- Review the audio design doc with the audio-director before implementation begins.
- Use `/dev-story` to implement the audio manager and event system once the design is approved.
- Run `/asset-audit` after audio assets are created to verify naming and format compliance.

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
