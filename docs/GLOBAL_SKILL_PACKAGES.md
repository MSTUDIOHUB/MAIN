# Global Skill packages

Imported Skill ZIPs are reusable user installations. Their storage identity is
separate from the workspace where a Turn executes. This follows the public
[Codex Skill scopes](https://developers.openai.com/codex/skills): user Skills
apply across repositories, while repository Skills retain a project scope.

## Owners

- The native package store owns bounded archive extraction, complete content
  identity, immutable payloads, manifests, and confined resource reads.
- The existing `skills` setting owns installation registration, enabled state,
  and implicit-invocation preference. Cached payloads are not independently
  discovered or enabled.
- The catalog captures the registered installation and its content for one
  Turn. The initial prompt contains names and descriptions; `load_skill`
  discloses selected instructions and references progressively.
- Existing workspace, Turn, tool, source-version, and approval owners continue
  to control effects. A Skill does not grant project, file, command, network,
  or Editor authority.

## Identity and migration

A global installation has an explicit `packageStorage` discriminator and a
verified package ID. An absent or empty legacy `workspaceScope` never means
global access. Legacy project packages retain their exact project boundary
until promotion succeeds.

Package identity covers the complete relative resource tree and file contents,
not its display name, ZIP packaging, or only `SKILL.md`. Identical imports reuse
one registration. Different resources or instructions retain different
identities even when names match. Reimport preserves the existing registration's
name, enabled state, and implicit-invocation preference.

Migration validates and copies before changing registration. It retains legacy
records on failure, preserves unrelated or concurrently changed settings, and
does not delete old project resources. Repeated migration and concurrent imports
of the same content are idempotent. Merging legacy duplicate preferences must
not reactivate a disabled or manually selected installation.

Immutable managed payloads remain cached when a preview is canceled or its
registration is removed. This avoids deleting shared content or resources held
by an admitted Turn. Removing registration excludes it from future catalogs;
cache presence does not reinstall it.

## Read authority

Global references use the selected Skill's captured package ID and relative
resource path through `load_skill`. The native reader derives its managed root;
the model cannot supply another filesystem root. Paths must remain within the
registered resource tree and refer to bounded regular files. Traversal,
absolute paths, symlink escapes, special files, and content-version drift fail
closed.

Reference text is guidance evidence, not project source authority. It cannot
create an editable-source lease, change the Run workspace, or enable generic
external reads. Reading a script does not execute it. Script execution and
Unity CLI operations still use normal tools and independent authorization.

Repository `.agents/skills`, personal `.agents/skills`, and Gemini extensions
keep their existing scopes. A Skill package import does not install or activate
the MCP, command, hook, or authentication settings of another extension format.

## Verification

Required checks cover cross-project and projectless discovery, identical and
different-content imports, disabled/manual preferences, strict legacy scope,
failed and late migration, immutable snapshots, resource confinement, guidance
evidence, and unchanged effect authorization. Native UI verification includes
light, dark, and black themes. Unity acceptance remains an independent actual
gameplay test in the user's TestCli project.
