import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const localRequire = createRequire(normalized);
  const loaded = { exports: {} };
  moduleCache.set(normalized, loaded.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(loaded.exports, loaded, runtimeRequire);
  moduleCache.set(normalized, loaded.exports);
  return loaded.exports;
}

const projectInit = loadTs(path.join(workspaceRoot, "src/lib/projectInit.ts"));

function makeBaseline(overrides = {}) {
  const fingerprint = overrides.fingerprint || "project-baseline-sha256-one";
  const workspaceIdentity = overrides.workspaceIdentity || "project-workspace-sha256-fixture";
  return {
    kind: "project_baseline_context",
    schemaVersion: 1,
    parserVersion: 1,
    workspace: {
      canonicalPath: "/fixture/repo",
      identity: workspaceIdentity,
      vcs: null,
    },
    limits: {},
    anchors: overrides.anchors || [
      { path: "package.json", kind: "manifest", contentHash: "sha256-package", byteSize: 100, provenance: "workspace_file" },
      { path: "tsconfig.json", kind: "config", contentHash: "sha256-tsconfig", byteSize: 40, provenance: "workspace_file" },
    ],
    topology: overrides.topology || [
      { path: "docs", kind: "directory" },
      { path: "src", kind: "directory" },
      { path: "src/lib", kind: "directory" },
      { path: "src/main.ts", kind: "file" },
    ],
    facts: {
      languages: [{ name: "TypeScript", provenance: { path: "tsconfig.json", selector: "config", contentHash: "sha256-tsconfig" } }],
      packageManagers: [{ name: "pnpm", version: "9.15.0", provenance: { path: "package.json", selector: "$.packageManager", contentHash: "sha256-package" } }],
      runtimes: [{ name: "node", constraint: ">=20", provenance: { path: "package.json", selector: "$.engines.node", contentHash: "sha256-package" } }],
      scripts: overrides.scripts || [
        { name: "build", invocation: "pnpm run build", provenance: { path: "package.json", selector: "$.scripts.build", contentHash: "sha256-package" } },
        { name: "test", invocation: "pnpm run test", provenance: { path: "package.json", selector: "$.scripts.test", contentHash: "sha256-package" } },
      ],
    },
    omissions: [],
    diagnostics: [],
    truncated: { anchors: false, topology: false, scripts: false },
    fingerprints: {
      anchors: "project-baseline-anchors-sha256-one",
      topology: "project-baseline-topology-sha256-one",
      facts: "project-baseline-facts-sha256-one",
      overall: fingerprint,
    },
  };
}

function createIo(options = {}) {
  const calls = { inspect: [], buildBaseline: [], commit: [] };
  const baseline = options.baseline || makeBaseline();
  return {
    calls,
    async inspect(input) {
      calls.inspect.push(input);
      const exists = options.exists ?? false;
      return {
        canonicalWorkspace: "/fixture/repo",
        workspaceIdentity: baseline.workspace.identity,
        targetPath: "/fixture/repo/AGENTS.md",
        exists,
        content: options.content || "",
        baseVersion: exists ? (options.baseVersion || "sha256-base") : null,
      };
    },
    async buildBaseline(input) {
      calls.buildBaseline.push(input);
      return baseline;
    },
    async commit(input) {
      calls.commit.push(input);
      return options.commitResult || { status: "committed", version: "sha256-committed" };
    },
  };
}

test("automatic rules refresh preserves human bytes and requires review after a hand edit", async () => {
  const original = projectInit.renderProjectInitManagedBlock(makeBaseline());
  const human = "# Human rules\n\nKeep this.\n\n";
  const preference = { blockDigest: projectInit.projectInitManagedBlockDigest(original), locale: "en" };
  const same = createIo({ exists: true, content: human + original });
  const refresh = (io, isCurrent = () => true) =>
    projectInit.refreshApprovedProjectInitBlock({ workspace: "/fixture/repo", preference, io, isCurrent });
  assert.equal(await refresh(same), null);
  assert.equal(same.calls.commit.length, 0);
  const changed = createIo({ exists: true, content: human + original, baseline: makeBaseline({ fingerprint: "project-baseline-sha256-two" }) });
  const updated = await refresh(changed);
  assert.notEqual(updated.blockDigest, preference.blockDigest);
  assert.ok(changed.calls.commit[0].proposedContent.startsWith(human));
  const edited = createIo({ exists: true, content: human + original.replace("Runtimes", "Edited runtimes") });
  assert.equal(await refresh(edited), "needs_review");
  assert.equal(edited.calls.commit.length, 0);
  assert.equal(await refresh(changed, () => false), null);
  assert.equal(changed.calls.commit.length, 1);
});

test("rules command accepts a request and keeps init as a hidden alias", () => {
  for (const command of ["/规则", "/rules", "/init", "/INIT"]) {
    assert.deepEqual(projectInit.parseProjectInitCommand(command), { kind: "project_init", refresh: false });
    assert.deepEqual(projectInit.parseProjectInitCommand(`${command} preserve human rules`), { kind: "project_init", refresh: false, request: "preserve human rules" });
  }
  assert.deepEqual(projectInit.parseProjectInitCommand("  /init   --refresh  "), { kind: "project_init", refresh: true });
  assert.deepEqual(projectInit.parseProjectInitCommand("/规则 --refresh 更新项目规范"), { kind: "project_init", refresh: true, request: "更新项目规范" });
  assert.deepEqual(projectInit.parseProjectInitCommand("/rules\nPreserve this exact instruction"), { kind: "project_init", refresh: false, request: "Preserve this exact instruction" });
  for (const invalid of ["/initial", "/init-more", "/rules-extra", "please /init", ""]) assert.equal(projectInit.parseProjectInitCommand(invalid), null, invalid);
});

test("new initialization builds a deterministic bilingual managed block and commits exact CAS identities", async () => {
  const io = createIo();
  const preview = await projectInit.prepareProjectInitPreview({
    command: "/init",
    workspace: "/requested/repo",
    locale: "zh",
    io,
  });

  assert.equal(preview.status, "ready_create");
  assert.equal(preview.refresh, false);
  assert.equal(preview.canonicalWorkspace, "/fixture/repo");
  assert.equal(preview.workspaceIdentity, "project-workspace-sha256-fixture");
  assert.equal(preview.targetPath, "/fixture/repo/AGENTS.md");
  assert.equal(preview.baseVersion, null);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.command), true);
  assert.equal(preview.existing, "");
  assert.match(preview.proposed, /^<!-- MAIN:PROJECT_INIT:START v1 -->/);
  assert.match(preview.proposed, /MAIN 项目快速参考/);
  assert.match(preview.proposed, /`pnpm run build`/);
  assert.match(preview.proposed, /`src\/`/);
  assert.match(preview.proposed, /project-baseline-sha256-one/);
  assert.equal(preview.proposed.match(/MAIN:PROJECT_INIT:START/g)?.length, 1);
  assert.match(preview.unifiedDiff, /^--- \/fixture\/repo\/AGENTS\.md/m);
  assert.match(preview.unifiedDiff, /^\+<!-- MAIN:PROJECT_INIT:START v1 -->/m);
  assert.deepEqual(io.calls.inspect, [{ workspace: "/requested/repo", targetPath: "AGENTS.md" }]);
  assert.equal(io.calls.buildBaseline.length, 1);

  const result = await projectInit.commitProjectInitPreview({
    preview,
    currentWorkspaceIdentity: "project-workspace-sha256-fixture",
    io,
  });
  assert.deepEqual(result, { status: "committed", version: "sha256-committed" });
  assert.deepEqual(io.calls.commit, [{
    expectedCanonicalWorkspace: "/fixture/repo",
    expectedWorkspaceIdentity: "project-workspace-sha256-fixture",
    expectedTargetPath: "/fixture/repo/AGENTS.md",
    expectedBaseVersion: null,
    proposedContent: preview.proposed,
  }]);
});

test("existing human content is preserved and ordinary reruns are already_initialized no-ops", async () => {
  const original = "# Human rules\n\nNever overwrite this paragraph.\n";
  const firstIo = createIo({ exists: true, content: original });
  const first = await projectInit.prepareProjectInitPreview({ command: "/init", workspace: "/fixture/repo", io: firstIo });
  assert.equal(first.status, "ready_update");
  assert.ok(first.proposed.startsWith(original));
  assert.equal(first.proposed.slice(0, original.length), original);

  const repeatIo = createIo({ exists: true, content: first.proposed, baseVersion: "sha256-after-init" });
  const repeat = await projectInit.prepareProjectInitPreview({ command: "/init", workspace: "/fixture/repo", io: repeatIo });
  assert.equal(repeat.status, "already_initialized");
  assert.equal(repeat.proposed, first.proposed);
  assert.equal(repeat.unifiedDiff, "");
  assert.equal(repeatIo.calls.buildBaseline.length, 0, "an ordinary rerun does not rescan the project");

  const commitResult = await projectInit.commitProjectInitPreview({
    preview: repeat,
    currentWorkspaceIdentity: repeat.workspaceIdentity,
    io: repeatIo,
  });
  assert.deepEqual(commitResult, { status: "no_op", reason: "already_initialized" });
  assert.equal(repeatIo.calls.commit.length, 0);

  const refreshIo = createIo({ exists: true, content: first.proposed, baseVersion: "sha256-after-init" });
  const refresh = await projectInit.prepareProjectInitPreview({ command: "/init --refresh", workspace: "/fixture/repo", io: refreshIo });
  assert.equal(refresh.status, "no_changes");
  assert.equal(refresh.proposed, first.proposed);
  assert.equal(refresh.unifiedDiff, "");
});

test("refresh replaces exactly one managed block while preserving surrounding human bytes", async () => {
  const oldBlock = projectInit.renderProjectInitManagedBlock(makeBaseline({ fingerprint: "project-baseline-sha256-old" }), { locale: "en" });
  const existing = `# Rules\r\n\r\nHuman prefix.\r\n\r\n${oldBlock.replaceAll("\n", "\r\n")}\r\n\r\nHuman suffix.\r\n`;
  const updatedBaseline = makeBaseline({
    fingerprint: "project-baseline-sha256-new",
    scripts: [{ name: "verify", invocation: "pnpm run verify", provenance: { path: "package.json", selector: "$.scripts.verify", contentHash: "sha256-new" } }],
  });
  const io = createIo({ exists: true, content: existing, baseline: updatedBaseline });
  const preview = await projectInit.prepareProjectInitPreview({ command: "/init --refresh", workspace: "/fixture/repo", locale: "en", io });

  assert.equal(preview.status, "ready_update");
  assert.equal(preview.refresh, true);
  assert.ok(preview.proposed.startsWith("# Rules\r\n\r\nHuman prefix."));
  assert.ok(preview.proposed.endsWith("\r\n\r\nHuman suffix.\r\n"));
  assert.equal(preview.proposed.match(/MAIN:PROJECT_INIT:START/g)?.length, 1);
  assert.equal(preview.proposed.match(/MAIN:PROJECT_INIT:END/g)?.length, 1);
  assert.match(preview.proposed, /`pnpm run verify`/);
  assert.doesNotMatch(preview.proposed, /project-baseline-sha256-old/);
  assert.match(preview.unifiedDiff, /^-<!-- baseline-fingerprint: project-baseline-sha256-old -->/m);
  assert.match(preview.unifiedDiff, /^\+<!-- baseline-fingerprint: project-baseline-sha256-new -->/m);
});

test("malformed, variant, reversed, or duplicate marker sets fail closed", async () => {
  const start = projectInit.PROJECT_INIT_BLOCK_START;
  const end = projectInit.PROJECT_INIT_BLOCK_END;
  const cases = [
    `${start}\nmissing end\n`,
    `${end}\n${start}`,
    `${start}\none\n${end}\n${start}\ntwo\n${end}`,
    "<!-- MAIN:PROJECT_INIT:START v2 -->\nold\n<!-- MAIN:PROJECT_INIT:END -->",
    "MAIN:PROJECT_INIT:START is mentioned without a marker",
  ];
  for (const content of cases) {
    const io = createIo({ exists: true, content });
    const preview = await projectInit.prepareProjectInitPreview({ command: "/init --refresh", workspace: "/fixture/repo", io });
    assert.equal(preview.status, "invalid_managed_block");
    assert.equal(preview.proposed, content);
    assert.equal(preview.unifiedDiff, "");
    assert.equal(io.calls.buildBaseline.length, 0);
    const result = await projectInit.commitProjectInitPreview({ preview, currentWorkspaceIdentity: preview.workspaceIdentity, io });
    assert.deepEqual(result, { status: "no_op", reason: "invalid_managed_block" });
    assert.equal(io.calls.commit.length, 0);
  }
});

test("workspace/baseline mismatch and late workspace switches cannot cross the approved boundary", async () => {
  const mismatchedIo = createIo({ baseline: makeBaseline({ workspaceIdentity: "project-workspace-sha256-other" }) });
  mismatchedIo.inspect = async (input) => {
    mismatchedIo.calls.inspect.push(input);
    return {
      canonicalWorkspace: "/fixture/repo",
      workspaceIdentity: "project-workspace-sha256-approved",
      targetPath: "/fixture/repo/AGENTS.md",
      exists: false,
      content: "",
      baseVersion: null,
    };
  };
  await assert.rejects(
    projectInit.prepareProjectInitPreview({ command: "/init", workspace: "/fixture/repo", io: mismatchedIo }),
    /PROJECT_INIT_BASELINE_WORKSPACE_MISMATCH/,
  );

  const io = createIo();
  const preview = await projectInit.prepareProjectInitPreview({ command: "/init", workspace: "/fixture/repo", io });
  const result = await projectInit.commitProjectInitPreview({
    preview,
    currentWorkspaceIdentity: "project-workspace-sha256-switched",
    io,
  });
  assert.deepEqual(result, { status: "stale", reason: "workspace_identity" });
  assert.equal(io.calls.commit.length, 0);
});

test("CAS stale results propagate and cancellation is a pure no-op", async () => {
  const io = createIo({ commitResult: { status: "stale", reason: "base_version" } });
  const preview = await projectInit.prepareProjectInitPreview({ command: "/init", workspace: "/fixture/repo", io });
  const before = structuredClone(io.calls);
  assert.deepEqual(projectInit.cancelProjectInitPreview(preview), { status: "canceled" });
  assert.deepEqual(io.calls, before);

  const committed = await projectInit.commitProjectInitPreview({
    preview,
    currentWorkspaceIdentity: preview.workspaceIdentity,
    io,
  });
  assert.deepEqual(committed, { status: "stale", reason: "base_version" });
  assert.equal(io.calls.commit.length, 1);
});

test("invalid commands fail before inspect and managed output never includes raw anchor content", async () => {
  const io = createIo();
  await assert.rejects(
    projectInit.prepareProjectInitPreview({ command: "/initial", workspace: "/fixture/repo", io }),
    /PROJECT_INIT_INVALID_COMMAND/,
  );
  assert.equal(io.calls.inspect.length, 0);

  const block = projectInit.renderProjectInitManagedBlock(makeBaseline(), { locale: "en" });
  assert.match(block, /MAIN project quick reference/);
  assert.doesNotMatch(block, /vite build|must-not-leak|Human rules/);
});

test("inspection rejects target escape, stale metadata, and oversized AGENTS content", async () => {
  const cases = [
    { targetPath: "/outside/AGENTS.md", exists: false, content: "", baseVersion: null },
    { targetPath: "/fixture/repo/AGENTS.md", exists: false, content: "unexpected", baseVersion: null },
    { targetPath: "/fixture/repo/AGENTS.md", exists: true, content: "rules", baseVersion: null },
    { targetPath: "/fixture/repo/AGENTS.md", exists: true, content: "x".repeat(projectInit.PROJECT_INIT_MAX_EXISTING_BYTES + 1), baseVersion: "sha256-base" },
  ];
  for (const inspection of cases) {
    const io = createIo();
    io.inspect = async () => ({
      canonicalWorkspace: "/fixture/repo",
      workspaceIdentity: "project-workspace-sha256-fixture",
      ...inspection,
    });
    await assert.rejects(
      projectInit.prepareProjectInitPreview({ command: "/init", workspace: "/fixture/repo", io }),
      /PROJECT_INIT_INVALID_INSPECTION/,
    );
    assert.equal(io.calls.buildBaseline.length, 0);
    assert.equal(io.calls.commit.length, 0);
  }
});

test("a proposed managed block cannot exceed the shared write ceiling", async () => {
  const io = createIo({
    exists: true,
    content: "x".repeat(projectInit.PROJECT_INIT_MAX_CONTENT_BYTES - 8),
    baseVersion: "sha256-near-limit",
  });
  await assert.rejects(
    projectInit.prepareProjectInitPreview({
      command: "/init",
      workspace: "/fixture/repo",
      io,
    }),
    /PROJECT_INIT_CONTENT_TOO_LARGE/,
  );
  assert.equal(io.calls.commit.length, 0);
});

test("investigated rules drafts and editable diffs retain the original file CAS through empty and subsequent edits", async () => {
  const io = createIo({ exists: true, content: "# Human rules\nPreserve public API.\n", baseVersion: "sha256-before-interview" });
  const inspection = await io.inspect({ workspace: "/fixture/repo", targetPath: "AGENTS.md" });
  const draft = projectInit.buildProjectRulesPreview(inspection, "# Human rules\nPreserve public API.\nUse offline tests.\n");
  assert.equal(draft.editableDraft, true);
  assert.match(draft.unifiedDiff, /\+Use offline tests/);
  assert.equal(io.calls.buildBaseline.length, 0, "AI-drafted rules are not replaced with a deterministic snapshot");
  const empty = projectInit.updateProjectRulesPreview(draft, "");
  assert.equal(empty.proposed, "", "Ctrl+A deletion must remain editable");
  await assert.rejects(projectInit.commitProjectInitPreview({ preview: empty, currentWorkspaceIdentity: draft.workspaceIdentity, io }), /PROJECT_RULES_DRAFT_EMPTY/);
  const edited = projectInit.updateProjectRulesPreview(empty, "# Human rules\nPreserve public API.\nReview accessibility.\n");
  assert.equal(edited.baseVersion, inspection.baseVersion);
  assert.equal(edited.existing, inspection.content);
  await projectInit.commitProjectInitPreview({ preview: edited, currentWorkspaceIdentity: edited.workspaceIdentity, io });
  assert.equal(io.calls.commit.length, 1);
  assert.equal(io.calls.commit[0].expectedBaseVersion, "sha256-before-interview");
  assert.equal(io.calls.commit[0].proposedContent, edited.proposed);
  const staleIo = createIo({ commitResult: { status: "stale", reason: "base_version" } });
  assert.deepEqual(await projectInit.commitProjectInitPreview({ preview: edited, currentWorkspaceIdentity: edited.workspaceIdentity, io: staleIo }), { status: "stale", reason: "base_version" });
});
