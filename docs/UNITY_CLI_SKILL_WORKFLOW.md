# Unity CLI and Skill integration

Checked against public Unity sources on 2026-10-22. This documents the integration
contract, not a claim that game acceptance has passed.

## Official workflow

Unity's [Skills repository](https://github.com/Unity-Technologies/skills) recommends
installing Skills directly for agents without its platform-specific plugin.
The agent selects relevant instructions, then uses the
[CLI and project Pipeline package](https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package)
to operate a running Editor. Installing instructions alone does not install
the executable, Editor package, or a permission grant.

The [Pipeline Skill](https://github.com/Unity-Technologies/skills/blob/9d282100540601cfddc4bbd69f36a239d7a6f55c/skills/unity-pipeline/SKILL.md)
describes an incremental edit, compile, and test workflow. For bulk construction,
it recommends a project builder script executed through Pipeline. This avoids
encoding each scene operation as a separate discovery and execution round.
Command spellings and timeout units still require verification against the
installed package version.

## Observed distribution gap

The checked Skills repository commit
`9d282100540601cfddc4bbd69f36a239d7a6f55c` contains 34 Skills. The checked
[official plugin](https://github.com/Unity-Technologies/unity-agent-plugin/tree/d95425b6c0055e1473566476d90e116645999878)
contains 32. Its collection omits `unity-pipeline` and `project-auditor-fixes`.
MAIN imported all 32 entries in that plugin ZIP; this was not an extraction loss.

Installed Pipeline 0.9.0-exp.1 says its agent Skill moved from the package into
the repository root. The public CLI Skill still describes copying it from the
package. The public Pipeline Skill uses several older command names; the
installed 0.9 package exposes grouped names such as `script run` and
`editor set_auto_tick`. Do not describe the public Skill as a version-matched
0.9 command adapter or blindly reinstall the package to recover its missing file.

Use one explicitly registered global collection from a pinned official source.
Keep its original bytes and provenance. Resolve version-dependent command
details from the installed package and bounded live discovery. Repository-local
Skills remain supported for actual project-specific instructions.

## MAIN boundaries

- Installation scope and execution authority are independent. Global Skills
  remain guidance; ordinary path, approval, source-version, and tool checks own
  effects.
- Skill bodies and references have independent versions. Every read receipt
  must identify its actual document and provide reusable address parameters.
  A resource continuation must retain its resource path; version mismatch never
  authorizes guessing another target.
- CLI results are tool evidence, not editable project source. A result that fits
  the Run's allocated window should remain complete. A larger result must state
  its exact partial range and original size. Parallel output shares one window.
- Receiving instructions, discovering commands, compiling code, advancing
  frames, and passing game interactions are distinct facts. A development run
  cannot use discovery receipts as proof that the requested game exists.
- Pressure selection must retain actually read Skill guidance separately from
  editable source evidence. Deduplicate exact document/version windows instead
  of expanding catalog bodies. If the shared input budget evicts guidance,
  disclose that its text is absent and preserve exact document-local reread
  targets and ranges. An evicted read must remain recoverable through the normal
  authorized tool path; a duplicate-read guard must not make that pointer unusable.
- Same-Run recovery uses the exact bounded Skill receipt in the canonical
  checkpoint, including its document revision and source range. A display prefix
  cannot reconstruct missing instructions. Restoring guidance does not restore
  a source lease, approval, or an old mutation request; pending Skill reads still
  pass through the ordinary tool execution and authorization path.
- Existing-file source leases and new-file creation are different preconditions.
  Reading project metadata does not select that file as an implementation
  target. Ordinary creation uses the advertised file tool and its path/existence
  checks; commands and Editor operations keep their own authorization checks.
  Model instructions must not apply an existing-file edit lease to all of these
  actions or imply that a new artifact needs nonexistent old source text.

R21 demonstrated excessive up-front discovery and four document-target/version
mistakes before cancellation, with no game mutation. A separate production
function regression demonstrated fixed 12,000-character clipping of JSON that
fit the Run's 64,000-character window. Those are separate evidence classes:
the saved R21 UI projections do not reconstruct its complete raw CLI stdout,
so the clipping regression does not prove the cause of every R21 query.

R26 loaded both CLI and Pipeline guidance successfully. At its first pressure
boundary, the production decision selector retained one source read and the
latest four shell results but dropped all ten Skill receipts, including the
bulk-builder section. This was confirmed by call-identity selection replay and
matching 30-to-10 message telemetry, not a reconstruction of the missing full
outbound HTTP body. The operator canceled at a pending discovery approval;
no game was implemented or accepted. Loss of guidance is a confirmed harness
defect, but it does not establish that every preceding discovery call was caused
by compression.

R27 verified that the first real pressure boundary retained all ten loaded
Skill windows, including the bulk-builder section. It still performed extensive
capability discovery before any artifact mutation. Inspection identified an
instruction/executor mismatch: ordinary Execute guidance said to use only
visible source for a mutation or validation, while the executor allows ordinary
new-file creation without an existing-source lease. This mismatch is a concrete
contract defect; it does not prove the cause of every model query. The operator
canceled the last in-flight request after 196 ms to audit an approval setting
change, later confirmed as the user's action. Its next decision was not observed,
so this is not evidence of a natural infinite loop or failed game conclusion.
