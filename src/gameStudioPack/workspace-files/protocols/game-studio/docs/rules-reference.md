# Path-Specific Rules

Rules in `.MAIN/rules/game-studio/` are loaded by MAIN when their path patterns
match files associated with the current turn.

| Rule File | Path Pattern | Enforces |
| ---- | ---- | ---- |
| `gameplay-code.md` | `src/gameplay/**` | Data-driven values, delta time, no UI references |
| `engine-code.md` | `src/core/**` | Zero allocations in hot paths, thread safety, API stability |
| `ai-code.md` | `src/ai/**` | Performance budgets, debuggability, data-driven parameters |
| `network-code.md` | `src/networking/**` | Server authority, versioned messages, security |
| `ui-code.md` | `src/ui/**` | Localization, accessibility, and state ownership boundaries |
| `design-docs.md` | `design/gdd/**` | Required sections, formulas, and edge cases |
| `narrative.md` | `design/narrative/**` | Lore consistency, character voice, canon levels |
| `data-files.md` | `assets/data/**` | JSON validity, naming conventions, schema rules |
| `test-standards.md` | `tests/**` | Test naming, coverage requirements, fixture patterns |
| `prototype-code.md` | `prototypes/**` | Isolated experiments with documented hypotheses |
| `shader-code.md` | `assets/shaders/**` | Naming, performance targets, cross-platform rules |
