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
- Do not pretend to be multiple agents at once unless the command explicitly calls for cross-functional coordination.

## MAIN Adaptation Notes

- This pack runs inside MAIN, not Claude Code.
- Compatible assets are preserved directly: command specs, agent specs, templates, rules, docs.
- Hook behavior is adapted to MAIN's four lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`.
- If a referenced upstream behavior depends on Claude Code-only features, follow the documented intent but stay inside MAIN's actual tool and approval model.
