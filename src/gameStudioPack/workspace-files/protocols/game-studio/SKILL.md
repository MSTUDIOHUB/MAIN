---
name: game-studio
description: "MAIN Game Studio protocol entry. Route slash commands and specialist-agent requests through the bundled CCGS-compatible workspace pack."
---

# MAIN Game Studio Protocol

You are operating inside MAIN's `游戏工作室 / Game Studio` focus.

This protocol pack adapts the public MIT-licensed project
`Claude-Code-Game-Studios` into MAIN's runtime model.

## Core Rules

1. Treat `.protocols/game-studio/commands/*.md` as the authoritative slash-command specs.
2. Treat `.protocols/game-studio/agents/*.md` as specialist profile documents.
3. Treat `.MAIN/rules/game-studio/*.md` as path-scoped editing rules for game projects.
4. Treat `.MAIN/templates/game-studio/*.md` as reusable document templates for design, production, UX, QA, and release work.
5. Respect `.MAIN/hooks.json` and `.MAIN/game-studio/hooks/*.sh` as the MAIN-native compatibility layer for Game Studio workflow checks.

## Slash Workflow

When the user message includes a `GAME_STUDIO_CONTEXT` block:

- Read `.protocols/game-studio/SKILL.md` first.
- If `commandPath` is present, read that command file before responding.
- If `agentPath` is present, read that agent file and adopt its domain viewpoint for the current task.
- If both appear, the command file defines the workflow and the agent file defines the expert stance.

## Specialist Routing

- `/agent <slug>` means the user wants that specialist lens to stay active across subsequent turns.
- `/auto` means clear the sticky specialist and return to automatic orchestration.
- A specialist profile is a domain viewpoint, not an independent model process.
- When a command requests several specialists, apply each profile as a clearly separated review pass in the current MAIN run. Do not claim that independent agents ran unless MAIN actually exposed and executed such a tool.

## MAIN Adaptation Notes

- `.MAIN/game-studio/studio.config.json` is the runtime source of truth for engine, review mode, and sticky specialist state.
- `AGENTS.md` remains optional project guidance; Game Studio initialization does not require it.
- Command frontmatter does not grant tools. Use only the tools currently exposed by MAIN and follow MAIN's approval model.
- Unsupported named-tool or independent-agent instructions describe workflow intent only. Perform equivalent specialist passes with the current MAIN tool surface instead of fabricating unsupported calls.
- Hook behavior is adapted to MAIN's four lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`.
- The installed pack owns only `.protocols/game-studio` and `.MAIN` workspace assets.
