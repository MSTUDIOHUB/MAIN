---
inclusion: fileMatch
fileMatchPattern: ["**/*.asmdef", "**/*.asmref", "**/*.cs"]
---

# Assembly Definition Standards — Module Physical Isolation

## Philosophy
Every `.asmdef` file defines a **compilation island** — a self-contained module that can be built and tested independently. This is the primary mechanism for enforcing architectural boundaries in Unity.

## Naming Convention
- Format: `{Company}.{Project}.{Module}.Runtime.asmdef`
- Test assembly: `{Company}.{Project}.{Module}.Tests.asmdef`
- Editor assembly: `{Company}.{Project}.{Module}.Editor.asmdef`

## Dependency Rules
- Dependencies must form a **DAG** (Directed Acyclic Graph). Circular references are forbidden.
- A module may only reference assemblies in its `.asmdef` `references` list.
- **Runtime assemblies** MUST NOT reference **Editor assemblies**.
- **Domain assemblies** (e.g., `Gameplay`) MUST NOT reference **infrastructure assemblies** (e.g., `Networking`, `Analytics`) directly — invert the dependency via interfaces/events.
- Prefer **interface-based decoupling**: define contracts in a shared `Contracts` or `Interfaces` assembly that both sides reference.

## Structural Template
```
Assets/
├── 01_Foundation/           ← No dependencies (utils, extensions, interfaces)
│   └── Company.Project.Foundation.asmdef
├── 02_Core/                 ← Depends on Foundation only
│   └── Company.Project.Core.asmdef
├── 03_Gameplay/             ← Depends on Core + Foundation
│   └── Company.Project.Gameplay.asmdef
├── 04_Infrastructure/       ← Depends on Core + Foundation (NOT Gameplay)
│   └── Company.Project.Infrastructure.asmdef
└── 05_Presentation/         ← Depends on Gameplay + Infrastructure
    └── Company.Project.Presentation.asmdef
```

## Validation
- Run `Assembly Definition Audit` in CI: verify no circular dependencies, no runtime→editor references.
- Use `TypeCache` in editor scripts to scan for cross-assembly violations.
- When in doubt, extract a shared interface into a thin `Contracts` assembly.

## Platform Filtering
- Set `includePlatforms` for Editor assemblies (prevents accidental runtime inclusion).
- Use `versionDefines` to conditionally compile platform-specific code (e.g., `#if UNITY_ANDROID`).
- Keep `anyPlatform = true` only for truly platform-agnostic modules.
