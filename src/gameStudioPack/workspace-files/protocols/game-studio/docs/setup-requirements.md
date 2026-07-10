# Setup Requirements

Game Studio is initialized by MAIN for each workspace. It does not require a
separate agent CLI or a second agent-specific configuration directory.

## Required

- A workspace opened in MAIN.
- A model/provider configuration that can run normal MAIN tasks.

## Optional Tools

- Git, when the project uses version control.
- A POSIX-compatible `sh` for the bundled lifecycle checks.
- Python 3 for JSON asset validation in `posttool-asset-check.sh`.

All bundled hooks fail gracefully when an optional executable is unavailable.
The active hook registration is stored in `.MAIN/hooks.json`; Studio state is
stored in `.MAIN/game-studio/studio.config.json`.
