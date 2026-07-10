# Active Hooks

Game Studio hooks are registered in `.MAIN/hooks.json` and run through MAIN's
supported lifecycle events.

| Hook | Event | Purpose |
| ---- | ----- | ------- |
| `session-start.sh` | `SessionStart` | Reports the configured engine, review mode, and sticky specialist. |
| `detect-gaps.sh` | `SessionStart` | Suggests an appropriate first workflow for fresh or lightly documented projects. |
| `pretool-command-guard.sh` | `PreToolUse` | Blocks destructive Git commands and reminds users about milestone checks. |
| `posttool-asset-check.sh` | `PostToolUse` | Validates JSON assets when a Python runtime is available. |
| `posttool-workflow-reminder.sh` | `PostToolUse` | Recommends focused review after changing Game Studio protocol assets. |

Hooks receive MAIN's runtime event payload on standard input. A hook must fail
gracefully when an optional shell utility is unavailable.
