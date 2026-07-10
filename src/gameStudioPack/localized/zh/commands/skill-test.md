---
name: skill-test
description: "按 MAIN 实际运行时语义检查已安装的 Game Studio 命令文档。"
argument-hint: "static [skill-name | all] | audit"
user-invocable: true
---

# Skill Test

Validate the command documents installed under
`.protocols/game-studio/commands/`. This workflow uses only MAIN's current
workspace tools and does not depend on an external testing framework.

## Phase 1: Parse Arguments

Supported modes:

- `static [name]` - validate one command document.
- `static all` - validate every installed command document.
- `audit` - summarize command, specialist, and compatibility coverage.

If the mode or command name is missing, show usage and stop.

## Phase 2: Locate Assets

Use `glob_search` to find command files under
`.protocols/game-studio/commands/*.md`. For a named command, verify the exact
file exists before reading it. Use `read_file` for the selected documents and
`grep_search` for targeted compatibility checks.

## Phase 3: Static Checks

Run these checks for each selected command:

1. **Frontmatter**: require `name`, `description`, `argument-hint`, and
   `user-invocable`.
2. **Unsupported metadata**: fail if frontmatter contains `allowed-tools`,
   `model`, `agent`, `context`, or `isolation`; these fields do not grant
   MAIN capabilities.
3. **Workspace paths**: fail on `.claude/` or `CLAUDE.md`; installed paths
   must use `.MAIN/` or `.protocols/game-studio/`.
4. **Tool semantics**: fail on named upstream tools such as
   `AskUserQuestion`, `WebSearch`, `WebFetch`, or `Task`. MAIN tool names
   must match the active tool surface, such as `read_file`, `glob_search`,
   `grep_search`, `web_search`, `write_file`, `apply_patch`, and
   `run_command`.
5. **Specialist semantics**: fail when a document claims that independent
   agents, subagents, or parallel model processes ran. Specialist files are
   review profiles applied within the current MAIN run.
6. **Choice protocol**: fail on function-call or tabbed choice syntax.
   Interactive choices must use normal Markdown followed by one flat
   `<user_options>` block, then stop and wait for the user.
7. **Write safety**: when a workflow writes files, require explicit approval
   language before the write and a clear path for the proposed change.

Classify each check as PASS, WARN, or FAIL and cite the relevant line.

## Phase 4: Report

For one command, show the seven checks and an aggregate verdict. For
`static all`, show a compact table with one row per failing or warning command,
then totals for PASS, WARN, and FAIL.

For `audit`, also report:

- Number of command documents.
- Number of specialist profile documents.
- Missing command or specialist files referenced by the catalog.
- Remaining legacy paths, unsupported tool names, model-tier labels, or fake
  parallel-agent language.

Do not modify files during `/skill-test`.

## Phase 5: Next Step

If issues exist, recommend `/skill-improve [name]` for one command at a time.
If no issues exist, report COMPLETE.
