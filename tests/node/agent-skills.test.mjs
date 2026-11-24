import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const externalSelection = (entryPath, mode = "auto", workspaceScope = null) => ({ entryPath, workspaceScope, mode });

async function loadAgentSkillsModule(ipcStubs) {
  const sourcePath = path.join(workspaceRoot, "src/lib/agentSkills.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const protocolPath = path.join(workspaceRoot, "src/lib/protocolPackages.ts");
  const protocolOutput = ts.transpileModule(await fs.readFile(protocolPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: protocolPath,
  }).outputText;
  const protocolModule = { exports: {} };
  new Function("exports", "module", protocolOutput)(protocolModule.exports, protocolModule);
  const selectionSource = await fs.readFile(path.join(workspaceRoot, "src/lib/externalSkillSelections.ts"), "utf8");
  const selectionOutput = ts.transpileModule(selectionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const selectionModule = { exports: {} };
  new Function("exports", "module", selectionOutput)(selectionModule.exports, selectionModule);
  const sourcesSource = await fs.readFile(path.join(workspaceRoot, "src/lib/externalSkillSources.ts"), "utf8");
  const sourcesOutput = ts.transpileModule(sourcesSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const sourcesModule = { exports: {} };
  new Function("exports", "module", sourcesOutput)(sourcesModule.exports, sourcesModule);
  const engineModule = { exports: {} };
  const engineSource = await fs.readFile(path.join(workspaceRoot, "src/lib/engineManualSkills.ts"), "utf8");
  const engineOutput = ts.transpileModule(engineSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function("exports", "module", engineOutput)(engineModule.exports, engineModule);
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "yaml") return createRequire(import.meta.url)(specifier);
    if (specifier === "./ipc") return ipcStubs;
    if (specifier === "./protocolPackages") return protocolModule.exports;
    if (specifier === "./externalSkillSelections") return selectionModule.exports;
    if (specifier === "./externalSkillSources") return sourcesModule.exports;
    if (specifier === "./engineManualSkills") return engineModule.exports;
    throw new Error(`Unexpected require in test: ${specifier}`);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    localRequire,
  );
  return module.exports;
}

const GLOBAL_PACKAGE_ID = "a".repeat(64);
function globalPackageRecord(overrides = {}) {
  return { id: "global-record", name: "Global bundle", desc: "Reusable workflow", content: "", active: true, type: "package",
    packageStorage: { kind: "global", packageId: GLOBAL_PACKAGE_ID }, ...overrides };
}
function globalPackageIpc(overrides = {}) {
  return {
    globSearch: async () => [], readFile: async () => { throw new Error("Global package must not use project IO"); },
    inspectGlobalSkillPackage: async (id) => ({ packageId: id, name: "bundle", entryPoint: "skills/workflow/SKILL.md", entryPoints: ["skills/workflow/SKILL.md"], files: ["skills/workflow/SKILL.md", "skills/workflow/references/check.md"], reused: true }),
    readGlobalSkillPackageFile: async (_id, file) => file.endsWith("SKILL.md") ? "---\nname: global-workflow\ndescription: Read the shared reference\n---\nBODY_ONLY_ON_LOAD\n" : "# Reference\r\nEXACT_RESOURCE\r\n",
    ...overrides,
  };
}

test("registered global packages load once across project and global Turns without project IO", async () => {
  const inspections = [];
  const ipc = globalPackageIpc();
  const inspect = ipc.inspectGlobalSkillPackage;
  ipc.inspectGlobalSkillPackage = async (id) => { inspections.push(id); return inspect(id); };
  const api = await loadAgentSkillsModule(ipc);
  const records = [globalPackageRecord(), globalPackageRecord({ id: "duplicate-record" }), globalPackageRecord({ id: "disabled", active: false, packageStorage: { kind: "global", packageId: "b".repeat(64) } })];
  for (const workspace of ["/project/A", "/project/B", ""]) {
    const snapshot = await api.loadSkillCatalog({ workspace, skills: records });
    assert.equal(snapshot.entries.length, 1);
    const entry = snapshot.entries[0];
    assert.equal(entry.id, `global:${GLOBAL_PACKAGE_ID}:skills/workflow/SKILL.md`);
    assert.equal(entry.packageName, "Global bundle");
    assert.equal(entry.entryPath, `main-skill://${GLOBAL_PACKAGE_ID}/skills/workflow/SKILL.md`);
    assert.equal(entry.basePath, `main-skill://${GLOBAL_PACKAGE_ID}/skills/workflow`);
    assert.doesNotMatch(api.renderSkillCatalogContext(snapshot), /BODY_ONLY_ON_LOAD/);
    assert.match(api.loadSkillContent(snapshot, entry.id).content, /BODY_ONLY_ON_LOAD/);
    assert.match(api.loadSkillContent(snapshot, entry.id).hostGuidance, /resource/);
    assert.ok(Object.isFrozen(entry.globalResourcePaths));
  }
  assert.deepEqual(inspections, [GLOBAL_PACKAGE_ID, GLOBAL_PACKAGE_ID, GLOBAL_PACKAGE_ID], "same payload UI rows cannot duplicate discovery");
});

test("global resources use captured package identity, exact lossless windows and no root escapes", async () => {
  const reads = [];
  let resource = "# Reference\r\n" + "x".repeat(130) + "\r\nEND\r\n";
  const ipc = globalPackageIpc({ readGlobalSkillPackageFile: async (id, file) => {
    reads.push([id, file]);
    return file.endsWith("SKILL.md") ? "---\nname: global-workflow\n---\nBODY" : resource;
  } });
  const api = await loadAgentSkillsModule(ipc);
  const record = globalPackageRecord();
  const snapshot = await api.loadSkillCatalog({ workspace: "/project", skills: [record] });
  const entry = snapshot.entries[0];
  record.packageStorage.packageId = "b".repeat(64);
  const first = await api.loadSkillResourceContent(snapshot, entry.id, "references/check.md", { maxChars: 19 });
  assert.equal(first.resource, "references/check.md");
  assert.equal(first.complete, false);
  assert.equal(first.id, entry.id);
  assert.ok(first.entryPath.startsWith(`main-skill://${GLOBAL_PACKAGE_ID}/`));
  let source = first.content;
  let page = first;
  while (page.nextStartLine !== null) {
    page = await api.loadSkillResourceContent(snapshot, entry.id, "references/check.md", { maxChars: 19, startLine: page.nextStartLine, startChar: page.nextStartChar, expectedVersion: first.version });
    source += page.content;
  }
  assert.equal(source, resource);
  assert.ok(reads.every(([id, file]) => id === GLOBAL_PACKAGE_ID && file.startsWith("skills/workflow/")));
  const before = reads.length;
  for (const path of ["../outside", "/outside", "file:///outside", "C:\\outside", "references/../../outside", "references//check.md", "references/check.md\0", "missing.md"]) {
    await assert.rejects(() => api.loadSkillResourceContent(snapshot, entry.id, path), /RESOURCE|PATH/);
  }
  await assert.rejects(() => api.loadSkillResourceContent(snapshot, "global:" + "b".repeat(64), "references/check.md"), /ADMITTED|AUTHORIZED/);
  for (const patch of [{ globalPackageId: "../outside" }, { globalResourceBase: undefined }, { globalResourceBase: "../other" }, { entryPath: "/outside" }]) {
    await assert.rejects(() => api.loadSkillResourceContent({ ...snapshot, entries: [{ ...entry, ...patch }] }, entry.id, "references/check.md"), /RESOURCE/);
  }
  assert.equal(reads.length, before, "unknown IDs and paths cannot reach native IO");
  resource = "CHANGED";
  await assert.rejects(() => api.loadSkillResourceContent(snapshot, entry.id, "references/check.md", { expectedVersion: first.version }), /VERSION/);
  resource = "";
  const empty = await api.loadSkillResourceContent(snapshot, entry.id, "references/check.md");
  assert.equal(empty.content, "");
  assert.equal(empty.complete, true);
  assert.equal(empty.totalLines, 0);
  assert.deepEqual(empty.returnedRange, { startLine: 0, endLine: 0, startChar: 0, endChar: 0 });
});

test("global package identity never aliases a new payload, malformed record or same-name workflow", async () => {
  const ipc = globalPackageIpc();
  let inspections = 0;
  const inspect = ipc.inspectGlobalSkillPackage;
  ipc.inspectGlobalSkillPackage = async (id) => { inspections++; return inspect(id); };
  const api = await loadAgentSkillsModule(ipc);
  const first = await api.loadSkillCatalog({ workspace: "/A", skills: [globalPackageRecord()] });
  const old = api.listSkillCatalog(first).entries[0];
  const secondId = "b".repeat(64);
  const second = await api.loadSkillCatalog({ workspace: "/B", skills: [globalPackageRecord({ packageStorage: { kind: "global", packageId: secondId } })] });
  assert.equal(api.resolveSkillId(second, old.id), null);
  assert.equal(api.resolveSkillId(second, old.ref), null);
  await assert.rejects(() => api.loadSkillResourceContent(second, old.id, "references/check.md"), /ADMITTED/);
  const both = await api.loadSkillCatalog({ workspace: "", userPrompt: "Use $global-workflow", skills: [globalPackageRecord(), globalPackageRecord({ id: "different-payload", packageStorage: { kind: "global", packageId: secondId } })] });
  assert.equal(both.entries.length, 2);
  assert.deepEqual(both.explicitSkillIds, [], "same display name does not merge different resources or guess which workflow was selected");
  const selectedId = both.entries[1].id;
  const selectedRef = api.skillReference(both, selectedId);
  const selected = await api.loadSkillCatalog({ workspace: "", userPrompt: `Use $${selectedRef}`, skills: [globalPackageRecord(), globalPackageRecord({ id: "different-payload", packageStorage: { kind: "global", packageId: secondId } })] });
  assert.deepEqual(selected.explicitSkillIds, [selectedId], "a short ref selects exactly one same-name installed package");
  const before = inspections;
  const malformed = await api.loadSkillCatalog({ workspace: "/A", skills: [globalPackageRecord({ packagePath: ".protocols/legacy", workspaceScope: "/A", packageStorage: { kind: "global", packageId: "../outside" } })] });
  assert.equal(malformed.entries.length, 0);
  assert.equal(inspections, before);
  ipc.inspectGlobalSkillPackage = async () => ({ ...(await inspect(GLOBAL_PACKAGE_ID)), packageId: secondId });
  const mismatched = await api.loadSkillCatalog({ workspace: "", skills: [globalPackageRecord()] });
  assert.equal(mismatched.entries.length, 0);
  assert.match(mismatched.warnings.join(" "), /ID_MISMATCH/);
});

test("Skill admission exposes metadata first and loads exact content on demand", async () => {
  const files = {
    ".agents/skills/release/SKILL.md": [
      "---",
      "name: release-check",
      "description: Validate a release before publishing.",
      "---",
      "REPO_SKILL_BODY_SENTINEL",
    ].join("\n"),
    ".agents/skills/release/agents/openai.yaml":
      "policy:\n  allow_implicit_invocation: false\n",
    ".protocols/reviewer/SKILL.md": [
      "---",
      "name: package-review",
      "description: Review a package safely.",
      "---",
      "PACKAGE_SKILL_BODY_SENTINEL",
    ].join("\n"),
  };
  const { loadSkillCatalog, renderSkillCatalogContext, loadSkillContent } =
    await loadAgentSkillsModule({
      globSearch: async (pattern) =>
        pattern === ".agents/skills/**/SKILL.md"
          ? [".agents/skills/release/SKILL.md"]
          : [],
      readFile: async (target) => {
        if (!(target in files)) throw new Error(`missing ${target}`);
        return files[target];
      },
    });

  const snapshot = await loadSkillCatalog({
    workspace: "/repo",
    userPrompt: "Please use $personal-review for this task",
    externalSkillSelections: [externalSelection("/repo/.agents/skills/release/SKILL.md", "auto", "/repo")],
    skills: [
      {
        id: "personal-1",
        name: "personal-review",
        desc: "Review a change with the personal checklist.",
        content: "PERSONAL_SKILL_BODY_SENTINEL",
        active: true,
        type: "instruction",
      },
      {
        id: "disabled-1",
        name: "disabled-skill",
        desc: "Must stay hidden.",
        content: "DISABLED_SKILL_BODY_SENTINEL",
        active: false,
        type: "instruction",
      },
      {
        id: "package-1",
        name: "package-review",
        desc: "Fallback package description.",
        content: "",
        active: true,
        type: "package",
        packagePath: ".protocols/reviewer",
        entryPoint: "SKILL.md",
        workspaceScope: "/repo",
      },
    ],
  });

  assert.deepEqual(
    snapshot.entries.map((entry) => entry.name).sort(),
    ["package-review", "personal-review", "release-check"],
  );
  assert.deepEqual(snapshot.explicitSkillIds, ["panel:personal-1"]);
  assert.equal(
    snapshot.entries.find((entry) => entry.name === "release-check")
      .allowImplicitInvocation,
    false,
  );

  const catalogContext = renderSkillCatalogContext(snapshot);
  assert.match(catalogContext, /personal-review/);
  assert.doesNotMatch(
    catalogContext,
    /release-check/,
    "manual-only Skills stay out of model-driven discovery",
  );
  assert.doesNotMatch(catalogContext, /PERSONAL_SKILL_BODY_SENTINEL/);
  assert.doesNotMatch(catalogContext, /REPO_SKILL_BODY_SENTINEL/);
  assert.doesNotMatch(catalogContext, /PACKAGE_SKILL_BODY_SENTINEL/);

  const loaded = loadSkillContent(snapshot, "workspace:.agents/skills/release/SKILL.md");
  assert.equal(loaded.name, "release-check");
  assert.match(loaded.content, /REPO_SKILL_BODY_SENTINEL/);
  assert.equal(loaded.basePath, ".agents/skills/release");
  assert.match(loaded.version, /^[a-f0-9]{8}$/);
  assert.match(loaded.hostGuidance, /partial index/);
  assert.match(loaded.hostGuidance, /advertised/);
});

test("Skill snapshots are immutable and reject unknown or ambiguous explicit names", async () => {
  const { loadSkillCatalog, loadSkillContent } = await loadAgentSkillsModule({
    globSearch: async () => [],
    readFile: async () => "",
  });
  const skills = [{
    id: "one",
    name: "review",
    desc: "First review workflow.",
    content: "ORIGINAL",
    active: true,
    type: "instruction",
  }];
  const snapshot = await loadSkillCatalog({
    workspace: "/repo",
    userPrompt: "Use $review",
    skills,
  });

  skills[0].content = "MUTATED_AFTER_ADMISSION";
  assert.match(loadSkillContent(snapshot, "panel:one").content, /ORIGINAL/);
  assert.doesNotMatch(
    loadSkillContent(snapshot, "panel:one").content,
    /MUTATED_AFTER_ADMISSION/,
  );
  assert.throws(
    () => loadSkillContent(snapshot, "panel:missing"),
    /SKILL_NOT_ADMITTED/,
  );
});

test("manual-only Skills are hidden from implicit discovery and deterministically activated by $name", async () => {
  const {
    loadSkillCatalog,
    renderExplicitSkillActivationContext,
    renderSkillCatalogContext,
  } = await loadAgentSkillsModule({
    globSearch: async () => [],
    readFile: async () => "",
  });
  const skill = {
    id: "manual",
    name: "manual-check",
    desc: "Only use when selected.",
    content: "MANUAL_SKILL_BODY_SENTINEL",
    active: true,
    type: "instruction",
    allowImplicitInvocation: false,
  };

  const hidden = await loadSkillCatalog({
    workspace: "",
    skills: [skill],
    userPrompt: "Please check this.",
  });
  assert.equal(renderSkillCatalogContext(hidden), "");
  assert.equal(renderExplicitSkillActivationContext(hidden), "");

  const explicit = await loadSkillCatalog({
    workspace: "",
    skills: [skill],
    userPrompt: "Please use $manual-check for this.",
  });
  assert.deepEqual(explicit.explicitSkillIds, ["panel:manual"]);
  assert.match(renderSkillCatalogContext(explicit), /manual-check/);
  assert.match(
    renderExplicitSkillActivationContext(explicit),
    /MANUAL_SKILL_BODY_SENTINEL/,
  );
});

test("personal $HOME/.agents/skills documents are admitted in global and workspace Turns", async () => {
  const { loadSkillCatalog, renderSkillCatalogContext } =
    await loadAgentSkillsModule({
      discoverPersonalAgentSkills: async () => [{
        entryPath: "/Users/test/.agents/skills/personal/SKILL.md",
        basePath: "/Users/test/.agents/skills/personal",
        content: [
          "---",
          "name: personal-agent-skill",
          "description: Personal reusable workflow.",
          "---",
          "PERSONAL_HOME_BODY_SENTINEL",
        ].join("\n"),
        openaiYaml: null,
        supportingFiles: [
          "/Users/test/.agents/skills/personal/references/checklist.md",
        ],
      }],
      globSearch: async () => [],
      readFile: async () => "",
    });

  const globalSnapshot = await loadSkillCatalog({
    workspace: "",
    skills: [],
    externalSkillSelections: [externalSelection("/Users/test/.agents/skills/personal/SKILL.md")],
  });
  assert.deepEqual(
    globalSnapshot.entries.map((entry) => entry.name),
    ["personal-agent-skill"],
  );
  assert.match(renderSkillCatalogContext(globalSnapshot), /personal-agent-skill/);
  assert.doesNotMatch(
    renderSkillCatalogContext(globalSnapshot),
    /PERSONAL_HOME_BODY_SENTINEL/,
  );
  assert.deepEqual(globalSnapshot.entries[0].supportingFiles, [
    "/Users/test/.agents/skills/personal/references/checklist.md",
  ]);
});

test("Skill YAML scalars preserve folded paragraphs, literal lines, quoting and exact document bytes", async () => {
  const cases = [
    ["folded", ">-\n  First line\n  continues here.\n\n  Another paragraph.", "First line continues here.\nAnother paragraph."],
    ["literal", "|-\n  First line\n  second line\n\n  Last line", "First line\nsecond line\n\nLast line"],
    ["indented", ">2- # scalar indicator comment\n  Intro\n    code line\n  Back", "Intro\n  code line\nBack"],
    ["quoted", '"Keep # hashes and \\"quotes\\"." # comment', 'Keep # hashes and "quotes".'],
    ["single-quoted", "'It''s # literal.' # comment", "It's # literal."],
    ["plain", "First line\n  continues with details.", "First line continues with details."],
  ];
  const documents = cases.map(([name, scalar]) => ({
    entryPath: `/skills/${name}/SKILL.md`,
    basePath: `/skills/${name}`,
    content: `---\r\nname: ${name}\r\ndescription: ${scalar.replace(/\n/g, "\r\n")}\r\nmetadata:\r\n  description: Must not override the root description\r\n---\r\n# Body\r\n\r\n`,
    supportingFiles: [],
  }));
  const { loadSkillCatalog, loadSkillContent } = await loadAgentSkillsModule({
    discoverPersonalAgentSkills: async () => documents,
  });
  const snapshot = await loadSkillCatalog({ workspace: "", skills: [], externalSkillSelections: documents.map((document) => externalSelection(document.entryPath)) });
  for (const [index, [name, , expected]] of cases.entries()) {
    const entry = snapshot.entries.find((candidate) => candidate.name === name);
    assert.equal(entry.description, expected, name);
    assert.equal(loadSkillContent(snapshot, entry.id).content, documents[index].content);
  }
});

test("Skill frontmatter accepts BOM and reports invalid YAML or non-scalar metadata without expanding aliases", async () => {
  const { parseSkillDocument, loadSkillCatalog } = await loadAgentSkillsModule({
    discoverPersonalAgentSkills: async () => [{
      entryPath: "/skills/invalid/SKILL.md", basePath: "/skills/invalid",
      content: "---\nname: [broken\n---\nUNCHANGED\n", supportingFiles: [],
    }],
  });
  const source = '\uFEFF---\r\nname: "escape-\\u006eame"\r\ndescription: "quoted # value" # comment\r\n---\r\nBody\r\n';
  const parsed = parseSkillDocument(source, "fallback", "fallback description");
  assert.equal(parsed.name, "escape-name");
  assert.equal(parsed.description, "quoted # value");
  assert.equal(parsed.body, source);
  assert.deepEqual(parsed.warnings, []);
  for (const frontmatter of ["- list instead of mapping", "name: first\nname: duplicate", "name: {nested: value}"]) {
    const invalid = parseSkillDocument(`---\n${frontmatter}\n---\nBODY\n`, "fallback", "fallback description");
    assert.equal(invalid.name, "fallback");
    assert.ok(invalid.warnings.length > 0);
  }
  const aliases = parseSkillDocument("---\nname: &label scalar\ndescription: *label\n---\nBODY\n", "fallback", "fallback description");
  assert.equal(aliases.description, "fallback description");
  assert.ok(aliases.warnings.length > 0);
  const snapshot = await loadSkillCatalog({ workspace: "", skills: [], externalSkillSelections: [externalSelection("/skills/invalid/SKILL.md")] });
  assert.equal(snapshot.entries[0].name, "invalid");
  assert.match(snapshot.warnings[0], /Invalid YAML frontmatter/);
  assert.equal(snapshot.entries[0].content, "---\nname: [broken\n---\nUNCHANGED\n");
});

test("Skill catalog listing pages every visible entry without exposing bodies or manual-only Skills", async () => {
  const { loadSkillCatalog, listSkillCatalog, renderSkillCatalogContext, buildLoadSkillToolDefinition } =
    await loadAgentSkillsModule({});
  const skills = Array.from({ length: 37 }, (_, index) => ({
    id: `entry-${index}`, name: `unity-workflow-${index}`,
    desc: `Unity workflow ${index}: ${"long description ".repeat(50)}`,
    content: `SECRET_BODY_${index}`, active: true, type: "instruction",
  }));
  skills.push({ id: "manual", name: "hidden-manual", desc: "Secret workflow", content: "HIDDEN_BODY", active: true, allowImplicitInvocation: false });
  const snapshot = await loadSkillCatalog({ workspace: "", skills });
  const seen = [];
  let cursor;
  do {
    const page = listSkillCatalog(snapshot, { limit: 7, cursor });
    assert.equal(page.type, "skill.catalog");
    assert.equal(page.total, 37);
    assert.ok(page.entries.length <= 7);
    assert.doesNotMatch(JSON.stringify(page), /SECRET_BODY|HIDDEN_BODY|hidden-manual/);
    seen.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, skills.slice(0, 37).map((skill) => `panel:${skill.id}`));
  assert.equal(listSkillCatalog(snapshot, { query: "hidden-manual" }).total, 0);
  assert.deepEqual(listSkillCatalog(snapshot, { query: "unity-workflow-36" }).entries.map((entry) => entry.name), ["unity-workflow-36"]);
  const firstPage = listSkillCatalog(snapshot, { limit: 1 });
  assert.throws(() => listSkillCatalog(snapshot, { cursor: firstPage.nextCursor, query: "other" }), /SKILL_CATALOG_CURSOR_INVALID/);
  assert.throws(() => listSkillCatalog(snapshot, { cursor: "bad-cursor" }), /SKILL_CATALOG_CURSOR_INVALID/);
  const changed = await loadSkillCatalog({ workspace: "", skills: skills.map((skill, index) => index === 0 ? { ...skill, content: "REVISED_BODY" } : skill) });
  assert.throws(() => listSkillCatalog(changed, { cursor: firstPage.nextCursor }), /SKILL_CATALOG_CURSOR_INVALID/);

  const context = renderSkillCatalogContext(snapshot, 8_000);
  assert.match(context, /unity-workflow-36/);
  assert.match(context, /load_skill/);
  assert.match(context, /operation.*list/);
  assert.doesNotMatch(context, /SECRET_BODY|hidden-manual/);
  assert.ok(context.length <= 8_000);
  const smallContext = renderSkillCatalogContext(snapshot, 512);
  assert.ok(smallContext.length <= 512);
  assert.match(smallContext, /operation.*list/);
  assert.match(smallContext, /37/);
  const schema = buildLoadSkillToolDefinition(snapshot).function.parameters;
  assert.deepEqual(schema.properties.operation.enum, ["load", "list"]);
  assert.ok(!schema.required?.includes("skill_id"), "list does not need an entry id");

  const explicit = await loadSkillCatalog({ workspace: "", skills, userPrompt: "Use $hidden-manual" });
  assert.equal(listSkillCatalog(explicit, { query: "hidden-manual" }).entries[0].explicitlyRequested, true);
});

test("one protocol package admits every safe entry with per-entry bases and combined invocation policy", async () => {
  const files = {
    ".protocols/unity/skills/one/SKILL.md": "---\nname: unity-one\ndescription: First Unity workflow\n---\nONE\n",
    ".protocols/unity/skills/two/SKILL.md": "---\nname: unity-two\ndescription: Second Unity workflow\n---\nTWO\n",
    ".protocols/unity/skills/two/agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
  };
  const reads = [];
  const { loadSkillCatalog, listSkillCatalog, loadSkillContent } = await loadAgentSkillsModule({
    globSearch: async () => [],
    readFile: async (target) => {
      reads.push(target);
      if (!(target in files)) throw new Error("missing");
      return files[target];
    },
  });
  const skill = {
    id: "unity", name: "Unity bundle", desc: "fallback", content: "", active: true, type: "package",
    packagePath: ".protocols/unity", entryPoint: "skills/one/SKILL.md",
    entryPoints: ["skills/one/SKILL.md", "skills/two/SKILL.md", "../escape/SKILL.md", "/escape/SKILL.md", "skills/one/../../../escape/SKILL.md", ""],
    workspaceScope: "/repo",
  };
  const snapshot = await loadSkillCatalog({ workspace: "/repo", skills: [skill] });
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), [
    "package:unity:skills/one/SKILL.md", "package:unity:skills/two/SKILL.md",
  ]);
  assert.equal(snapshot.entries[1].basePath, ".protocols/unity/skills/two");
  assert.equal(loadSkillContent(snapshot, snapshot.entries[1].id).content, files[".protocols/unity/skills/two/SKILL.md"]);
  assert.deepEqual(listSkillCatalog(snapshot).entries.map((entry) => entry.name), ["unity-one"]);
  assert.ok(snapshot.warnings.some((warning) => /unsafe/.test(warning)));
  assert.ok(!reads.some((target) => target.includes("escape")));

  const disabled = await loadSkillCatalog({ workspace: "/repo", skills: [{ ...skill, allowImplicitInvocation: false }] });
  assert.equal(listSkillCatalog(disabled).total, 0);
  const explicit = await loadSkillCatalog({ workspace: "/repo", skills: [{ ...skill, allowImplicitInvocation: false }], userPrompt: "Use $unity-two" });
  assert.deepEqual(explicit.explicitSkillIds, ["package:unity:skills/two/SKILL.md"]);
  const single = await loadSkillCatalog({ workspace: "/repo", skills: [{ ...skill, entryPoints: ["skills/one/SKILL.md"] }] });
  assert.equal(single.entries[0].id, "package:unity");
});

test("explicit long Skills disclose their exact preface and section index without claiming a full load", async () => {
  const api = await loadAgentSkillsModule({});
  const lines = Array.from({ length: 632 }, (_, index) => `Original instruction ${index + 1}.`);
  lines[0] = "# Reference workflow";
  lines[4] = "## Inspect";
  lines[9] = "```csharp";
  lines[10] = "## THIS_IS_CODE_NOT_A_SECTION";
  lines[11] = "```";
  lines[299] = "## Modify";
  lines[599] = "## Verify";
  const content = `${lines.join("\r\n")}\r\n`;
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [{
    id: "long", name: "reference-workflow", desc: "Inspect and modify a project.",
    content, active: true,
  }], userPrompt: "Please use $reference-workflow" });
  const selected = api.renderExplicitSkillActivationContext(snapshot, { maxChars: 300 });
  assert.match(selected, /selected-not-fully-loaded/);
  assert.match(selected, /Sections|section_cursor/);
  assert.doesNotMatch(selected, /THIS_IS_CODE_NOT_A_SECTION|Original instruction 632/);
  assert.ok(selected.length < content.length / 4);
  const loaded = api.loadSkillContent(snapshot, snapshot.entries[0].id, { maxChars: 300 });
  assert.equal(loaded.disclosure, "overview");
  assert.equal(loaded.complete, false);
  assert.equal(loaded.partial, true);
  assert.equal(loaded.totalLines, 632);
  assert.equal(loaded.content, content.slice(0, loaded.returnedRange.endChar));
  assert.ok(loaded.content.includes("## Inspect"), "explicit loading uses the available window beyond the preface");
  assert.ok(loaded.content.length + JSON.stringify(loaded.sections).length <= 300);
  assert.ok(!loaded.sections.some((section) => section.title.includes("THIS_IS_CODE")));
  const indexed = [...loaded.sections];
  let sectionCursor = loaded.nextSectionCursor;
  while (sectionCursor) {
    const page = api.loadSkillContent(snapshot, snapshot.entries[0].id, { maxChars: 300, sectionCursor });
    assert.equal(page.content, "", "index continuation must not repeat the source preface");
    indexed.push(...page.sections);
    sectionCursor = page.nextSectionCursor;
  }
  assert.ok(indexed.some((section) => section.id === "L300" && section.title === "Modify"));
  assert.equal(api.loadSkillContent(snapshot, snapshot.entries[0].id).content, content,
    "an unbudgeted legacy full read remains lossless");
});

test("budgeted Skill windows reconstruct CRLF source and long lines without loss, with revision checks", async () => {
  const api = await loadAgentSkillsModule({});
  const content = `# Workflow\r\n${"超长行🙂".repeat(180)}\r\n## Verify\r\nKeep final newline.\r\n`;
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [{
    id: "crlf", name: "crlf", desc: "Lossless source.", content, active: true,
  }] });
  const entry = snapshot.entries[0];
  let startLine = 1;
  let startChar;
  let reconstructed = "";
  let reads = 0;
  do {
    const part = api.loadSkillContent(snapshot, entry.id, {
      maxChars: 137, startLine, startChar, expectedVersion: entry.version,
    });
    assert.equal(part.version, entry.version);
    assert.ok(part.content.length <= 137);
    assert.equal(part.content, content.slice(part.returnedRange.startChar, part.returnedRange.endChar));
    assert.equal(part.returnedRange.startChar, reconstructed.length);
    reconstructed += part.content;
    startLine = part.nextStartLine;
    startChar = part.nextStartChar;
    assert.ok(++reads < 40, "continuation must make forward progress");
  } while (startChar !== null);
  assert.equal(reconstructed, content);
  assert.throws(() => api.loadSkillContent(snapshot, entry.id, {
    maxChars: 137, startLine: 1, expectedVersion: "stale-revision",
  }), /SKILL_VERSION_MISMATCH/);
  assert.throws(() => api.loadSkillContent(snapshot, entry.id, { section: "L999" }), /SKILL_SECTION_NOT_FOUND/);
  const section = api.loadSkillContent(snapshot, entry.id, { section: "L3", maxChars: 137 });
  assert.equal(section.content, "## Verify\r\nKeep final newline.\r\n");
  assert.equal(section.requestedRangeComplete, true);
  assert.equal(section.complete, false);
});

test("oversized Skill prefaces report exact continuation and small Skills remain fully activated", async () => {
  const api = await loadAgentSkillsModule({});
  const long = `${"PREFACE ".repeat(150)}\n## Reference\nTAIL\n`;
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [
    { id: "preface", name: "preface", desc: "Large preface.", content: long, active: true },
    { id: "small", name: "small", desc: "Small workflow.", content: "EXACT_SMALL_BODY\r\n", active: true },
  ], userPrompt: "Use $small and $preface" });
  const overview = api.loadSkillContent(snapshot, "panel:preface", { maxChars: 100 });
  assert.equal(overview.content, long.slice(0, overview.returnedRange.endChar));
  assert.ok(overview.content.length > 0 && overview.content.length <= 100);
  assert.equal(overview.nextStartChar, overview.content.length);
  assert.equal(overview.nextStartLine, 1);
  assert.equal(overview.requestedRangeComplete, false);
  const activation = api.renderExplicitSkillActivationContext(snapshot, { maxChars: 100 });
  assert.match(activation, /fully-loaded/);
  assert.equal(activation.split("EXACT_SMALL_BODY").length - 1, 1);
});

test("compact Skill references preserve canonical identity and do not expose hidden skills or expand permissions", async () => {
  const api = await loadAgentSkillsModule({});
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [
    { id: "a".repeat(180), name: "duplicate", desc: "First.", content: "FIRST", active: true },
    { id: "b".repeat(180), name: "duplicate", desc: "Second.", content: "SECOND", active: true },
    { id: "hidden", name: "hidden", desc: "Manual.", content: "HIDDEN", active: true, allowImplicitInvocation: false },
  ], userPrompt: "Use $duplicate" });
  assert.deepEqual(snapshot.explicitSkillIds, [], "duplicate names are never guessed");
  const page = api.listSkillCatalog(snapshot);
  assert.equal(new Set(page.entries.map((entry) => entry.ref)).size, 2);
  for (const listed of page.entries) {
    assert.ok(listed.ref.length < 24);
    assert.equal(api.loadSkillContent(snapshot, listed.ref).id, listed.id);
    assert.equal(api.isSkillVisibleToModel(snapshot, listed.ref), true);
  }
  assert.equal(api.isSkillVisibleToModel(snapshot, "panel:hidden"), false);
  assert.equal(api.isSkillVisibleToModel(snapshot, "s:unknown"), false);
  const context = api.renderSkillCatalogContext(snapshot);
  assert.doesNotMatch(context, /a{100}|b{100}|HIDDEN|Names:|model_discoverable/);
  assert.match(context, /No additional permissions|not permissions/);
  const schema = api.buildLoadSkillToolDefinition(snapshot).function.parameters;
  assert.equal(schema.properties.skill_id.enum, undefined);
  assert.ok(schema.properties.section && schema.properties.start_line && schema.properties.expected_version);
});

test("Skill model projections show supporting paths relative to their declared base", async () => {
  const api = await loadAgentSkillsModule({
    discoverPersonalAgentSkills: async () => [{
      entryPath: "/personal/workflow/SKILL.md", basePath: "/personal/workflow",
      content: "---\nname: path-workflow\ndescription: Test paths\n---\nBODY",
      supportingFiles: ["/personal/workflow/references/deep.md", "/personal/workflow/scripts/check.js"],
    }],
  });
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [], userPrompt: "Use $path-workflow", externalSkillSelections: [externalSelection("/personal/workflow/SKILL.md")] });
  const activation = api.renderExplicitSkillActivationContext(snapshot);
  assert.match(activation, /Base directory: \/personal\/workflow/);
  assert.match(activation, /references\/deep.md/);
  assert.equal(activation.split("/personal/workflow").length - 1, 1);
  assert.deepEqual(snapshot.entries[0].supportingFiles,
    ["/personal/workflow/references/deep.md", "/personal/workflow/scripts/check.js"],
    "canonical supporting paths remain unchanged in the frozen catalog");
});

test("large Skill section indexes are budgeted and paginated without hiding source", async () => {
  const api = await loadAgentSkillsModule({});
  const content = `# Workflow\nPreface\n${Array.from({ length: 300 }, (_, index) => `## Section ${index}: ${"title ".repeat(30)}\nExact body ${index}\n`).join("")}`;
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [{ id: "many", name: "many", desc: "Many sections.", content, active: true }], userPrompt: "Use $many" });
  const overview = api.loadSkillContent(snapshot, "panel:many", { maxChars: 800 });
  assert.ok(JSON.stringify(overview.sections).length + overview.content.length <= 800);
  assert.equal(overview.sectionCount, 301);
  assert.ok(overview.nextSectionCursor);
  assert.ok(api.renderExplicitSkillActivationContext(snapshot, { maxChars: 800 }).length < 3000);
  const seen = [...overview.sections];
  let cursor = overview.nextSectionCursor;
  while (cursor) {
    const page = api.loadSkillContent(snapshot, "panel:many", { maxChars: 800, sectionCursor: cursor });
    assert.ok(JSON.stringify(page.sections).length <= 800);
    seen.push(...page.sections);
    cursor = page.nextSectionCursor;
    assert.ok(seen.length <= 301);
  }
  assert.equal(new Set(seen.map((section) => section.id)).size, 301);
  assert.equal(api.loadSkillContent(snapshot, "panel:many", { section: seen.at(-1).id, maxChars: 800 }).content,
    content.slice(content.indexOf("## Section 299:")));
  assert.throws(() => api.loadSkillContent(snapshot, "panel:many", { sectionCursor: "ffffffff:2", maxChars: 800 }), /SKILL_SECTION_CURSOR_INVALID/);
});

test("short Skill reference collisions resolve deterministically and explicit selections share one source budget", async () => {
  const api = await loadAgentSkillsModule({});
  const skills = ["1t9y1uh", "1jton3x"].map((id, index) => ({
    id, name: `selected-${index}`, desc: "Selected.", content: "Z".repeat(200), active: true,
  }));
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: "Use $selected-0 and $selected-1" });
  const refs = api.listSkillCatalog(snapshot).entries.map((entry) => entry.ref);
  assert.notEqual(refs[0], refs[1]);
  assert.ok(refs.every((ref) => ref.startsWith("s:507f6898:")));
  const reordered = await api.loadSkillCatalog({ workspace: "", skills: [...skills].reverse() });
  for (const entry of snapshot.entries) {
    assert.equal(api.skillReference(snapshot, entry.id), api.skillReference(reordered, entry.id));
  }
  const activation = api.renderExplicitSkillActivationContext(snapshot, { maxChars: 50 });
  assert.equal((activation.match(/Z/g) || []).length, 50);
  const tiny = api.renderExplicitSkillActivationContext(snapshot, { maxChars: 1 });
  assert.equal((tiny.match(/Z/g) || []).length, 1);
});

test("a budgeted explicit load uses available source space after a short preface", async () => {
  const api = await loadAgentSkillsModule({});
  const content = "# Workflow\nShort preface.\n\n## Inspect\n" + "Exact instructions.\n".repeat(100);
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [{ id: "window", name: "window", content, active: true }] });
  const loaded = api.loadSkillContent(snapshot, "panel:window", { maxChars: 600 });
  assert.ok(loaded.content.length > 400, "short prefaces cannot strand the rest of the Run-owned window");
  assert.equal(loaded.content, content.slice(0, loaded.returnedRange.endChar));
  assert.ok(loaded.content.length + JSON.stringify(loaded.sections).length <= 600);
  assert.equal(loaded.complete, false);
});

test("discovered Skill resources keep their captured identity, independent versions and exact bytes", async () => {
  const reads = [];
  let resource = "# Reference\r\n" + "x".repeat(300) + "\r\nEND\r\n";
  const api = await loadAgentSkillsModule({
    globSearch: async () => [],
    discoverPersonalAgentSkills: async (workspace) => {
      assert.equal(workspace, "/project");
      return [{ entryPath: "/home/.claude/skills/review/SKILL.md", basePath: "/home/.claude/skills/review", platformSource: "claude", content: "# Review\nRead references/check.md", supportingFiles: [] }];
    },
    readAgentSkillResource: async (entryPath, path) => { reads.push([entryPath, path]); return resource; },
  });
  const catalog = await api.loadSkillCatalog({ workspace: "/project", skills: [], externalSkillSelections: [externalSelection("/home/.claude/skills/review/SKILL.md")] });
  const entry = catalog.entries[0];
  assert.equal(entry.platformSource, "claude");
  assert.equal(entry.realBasePath, entry.basePath);
  let loaded = await api.loadSkillResourceContent(catalog, entry.id, "references/check.md", { maxChars: 67 });
  let reconstructed = loaded.content;
  while (loaded.nextRead) {
    loaded = await api.loadSkillResourceContent(catalog, entry.id, "references/check.md", {
      maxChars: 67, expectedVersion: loaded.version, startLine: loaded.nextStartLine, startChar: loaded.nextStartChar,
    });
    reconstructed += loaded.content;
  }
  assert.equal(reconstructed, resource);
  assert.deepEqual(reads[0], [entry.entryPath, "references/check.md"]);
  for (const path of ["../outside", "/outside", "file:///outside", "references//check.md", "C:\\outside", "x\0"]) {
    await assert.rejects(() => api.loadSkillResourceContent(catalog, entry.id, path), /PATH/);
  }
  await assert.rejects(() => api.loadSkillResourceContent(catalog, entry.id, "references/check.md", { expectedVersion: entry.version }), /VERSION.*first resource read.*omit/i);
  resource = "Changed";
  await assert.rejects(() => api.loadSkillResourceContent(catalog, entry.id, "references/check.md", { expectedVersion: loaded.version }), /VERSION/);
});

test("cross-platform duplicates prefer workspace, packages and Codex while same-priority ambiguity stays explicit", async () => {
  const docs = [
    { platformSource: "gemini", basePath: "/home/.gemini/plugin/skills/review" },
    { platformSource: "claude", basePath: "/home/.claude/skills/review" },
    { platformSource: "codex", basePath: "/home/.agents/skills/review" },
  ].map((entry) => ({ ...entry, entryPath: `${entry.basePath}/SKILL.md`, content: "---\nname: review\n---\nReview.", supportingFiles: [] }));
  const api = await loadAgentSkillsModule({ globSearch: async () => [], discoverPersonalAgentSkills: async () => docs });
  const catalog = await api.loadSkillCatalog({ workspace: "/project", skills: [], userPrompt: "Use $review", externalSkillSelections: docs.map((document) => externalSelection(document.entryPath)) });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].platformSource, "codex");
  assert.deepEqual(catalog.explicitSkillIds, [catalog.entries[0].id]);
});

test("global catalog admission consumes one verified batch instead of revalidating each document", async () => {
  let requests = 0;
  const meta = { packageId: GLOBAL_PACKAGE_ID, name: "bundle", entryPoint: "a/SKILL.md", entryPoints: ["a/SKILL.md", "b/SKILL.md"], files: ["a/SKILL.md", "b/SKILL.md", "b/agents/openai.yaml"], payloadDir: "/app/skill-packages/payload" };
  const api = await loadAgentSkillsModule({
    globSearch: async () => [],
    inspectGlobalSkillPackage: async () => { throw new Error("redundant package verification"); },
    readGlobalSkillPackageFile: async () => { throw new Error("redundant document verification"); },
    loadGlobalSkillPackageCatalog: async (id) => {
      assert.equal(id, GLOBAL_PACKAGE_ID);
      requests++;
      return { meta, documents: [
        { relativePath: "a/SKILL.md", content: "---\nname: one\n---\n# One\n" },
        { relativePath: "b/SKILL.md", content: "---\nname: two\n---\n# Two\n" },
        { relativePath: "b/agents/openai.yaml", content: "policy:\n  allow_implicit_invocation: false\n" },
      ] };
    },
  });
  const catalog = await api.loadSkillCatalog({ workspace: "/repo", skills: [globalPackageRecord()] });
  assert.equal(requests, 1);
  assert.deepEqual(catalog.entries.map((entry) => entry.name), ["one", "two"]);
  assert.deepEqual(api.listSkillCatalog(catalog).entries.map((entry) => entry.name), ["one"]);
});

test("native workspace discovery overrides home copies without duplicate frontend admission", async () => {
  const api = await loadAgentSkillsModule({
    discoverPersonalAgentSkills: async () => [
      { entryPath: "/repo/.claude/skills/review/SKILL.md", basePath: "/repo/.claude/skills/review", content: "---\nname: review\n---\nWorkspace", scope: "workspace", platformSource: "claude", supportingFiles: [] },
      { entryPath: "/home/.agents/skills/review/SKILL.md", basePath: "/home/.agents/skills/review", content: "---\nname: review\n---\nHome", scope: "personal", platformSource: "codex", supportingFiles: [] },
    ],
    globSearch: async (pattern) => pattern === ".claude/skills/**/SKILL.md" ? [".claude/skills/review/SKILL.md"] : [],
    readFile: async () => { throw new Error("already admitted by native discovery"); },
  });
  const catalog = await api.loadSkillCatalog({ workspace: "/repo", skills: [], userPrompt: "Use $review", externalSkillSelections: [
    externalSelection("/repo/.claude/skills/review/SKILL.md", "auto", "/repo"), externalSelection("/home/.agents/skills/review/SKILL.md"),
  ] });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].source, "workspace");
  assert.equal(catalog.entries[0].content, "---\nname: review\n---\nWorkspace");
  assert.equal(catalog.entries[0].resourceEntryPath, "/repo/.claude/skills/review/SKILL.md");
  assert.deepEqual(catalog.explicitSkillIds, [catalog.entries[0].id]);
});

test("external discovery is not admission and explicit names cannot bypass missing or disabled selections", async () => {
  const entryPath = "/home/.codex/skills/review/SKILL.md";
  const api = await loadAgentSkillsModule({
    globSearch: async () => [],
    discoverPersonalAgentSkills: async () => [{ entryPath, basePath: "/home/.codex/skills/review", content: "---\nname: review\n---\nBODY", supportingFiles: [] }],
  });
  for (const externalSkillSelections of [undefined, [], [{ entryPath, workspaceScope: null, mode: "disabled" }]]) {
    const catalog = await api.loadSkillCatalog({ workspace: "/repo", skills: [], userPrompt: "Use $review", externalSkillSelections });
    assert.equal(catalog.entries.length, 0);
    assert.deepEqual(catalog.explicitSkillIds, []);
    assert.equal(api.buildLoadSkillToolDefinition(catalog), null);
    await assert.rejects(() => api.loadSkillResourceContent(catalog, "review", "references/check.md"), /NOT_ADMITTED/);
  }
});

test("external manual selections require explicit use and auto preserves source invocation policy", async () => {
  const docs = [
    { entryPath: "/skills/manual/SKILL.md", basePath: "/skills/manual", content: "---\nname: manual\n---\nMANUAL", supportingFiles: [] },
    { entryPath: "/skills/source-manual/SKILL.md", basePath: "/skills/source-manual", content: "---\nname: source-manual\n---\nSOURCE", openaiYaml: "policy:\n  allow_implicit_invocation: false\n", supportingFiles: [] },
  ];
  const api = await loadAgentSkillsModule({ globSearch: async () => [], discoverPersonalAgentSkills: async () => docs });
  const externalSkillSelections = [
    { entryPath: docs[0].entryPath, workspaceScope: null, mode: "manual" },
    { entryPath: docs[1].entryPath, workspaceScope: null, mode: "auto" },
  ];
  const hidden = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections });
  assert.equal(api.listSkillCatalog(hidden).total, 0);
  assert.equal(hidden.entries.length, 2);
  const explicit = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections, userPrompt: "Use $manual and $source-manual" });
  assert.equal(api.listSkillCatalog(explicit).total, 2);
});

test("workspace fallback cannot admit unselected files or override an admitted same-name package", async () => {
  const api = await loadAgentSkillsModule({
    globSearch: async (pattern) => pattern === ".agents/skills/**/SKILL.md" ? [".agents/skills/review/SKILL.md"] : [],
    readFile: async () => { throw new Error("unselected external files must not be loaded"); },
  });
  const catalog = await api.loadSkillCatalog({ workspace: "/repo", skills: [{ id: "panel", name: "review", content: "PANEL", active: true }], userPrompt: "Use $review" });
  assert.deepEqual(catalog.entries.map((entry) => entry.id), ["panel:panel"]);
  assert.deepEqual(catalog.warnings, []);
});

test("project selection overrides global admission before same-name precedence is evaluated", async () => {
  const documents = [
    { entryPath: "/repo/.claude/skills/review/SKILL.md", basePath: "/repo/.claude/skills/review", scope: "workspace", platformSource: "claude" },
    { entryPath: "/home/.codex/skills/review/SKILL.md", basePath: "/home/.codex/skills/review", scope: "personal", platformSource: "codex" },
  ].map((entry) => ({ ...entry, content: "---\nname: review\n---\nBODY", supportingFiles: [] }));
  const api = await loadAgentSkillsModule({ globSearch: async () => [], discoverPersonalAgentSkills: async () => documents });
  const externalSkillSelections = [
    externalSelection(documents[0].entryPath, "disabled", "/repo"),
    externalSelection(documents[1].entryPath),
    externalSelection(documents[1].entryPath, "manual", "/repo"),
  ];
  const hidden = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections });
  assert.equal(hidden.entries.length, 1);
  assert.equal(hidden.entries[0].source, "personal", "a disabled workspace copy cannot suppress an admitted personal copy");
  assert.equal(api.listSkillCatalog(hidden).total, 0, "the project's manual override wins over global auto");
  const explicit = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections, userPrompt: "Use $review" });
  assert.equal(api.listSkillCatalog(explicit).total, 1);
  const other = await api.loadSkillCatalog({ workspace: "/other", skills: [], externalSkillSelections });
  assert.equal(api.listSkillCatalog(other).total, 1);
  assert.equal(other.entries[0].source, "personal");
});

test("workspace fallback applies manual selections through its absolute entry identity", async () => {
  const entryPath = "/repo/.claude/skills/check/SKILL.md";
  const api = await loadAgentSkillsModule({
    globSearch: async (pattern) => pattern === ".claude/skills/**/SKILL.md" ? [".claude/skills/check/SKILL.md"] : [],
    readFile: async (target) => target.endsWith("SKILL.md") ? "---\nname: check\n---\nCHECK" : "",
  });
  const externalSkillSelections = [externalSelection(entryPath, "manual", "/repo")];
  const hidden = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections });
  assert.equal(hidden.entries.length, 1);
  assert.equal(api.listSkillCatalog(hidden).total, 0);
  const explicit = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections, userPrompt: "Use $check" });
  assert.equal(api.listSkillCatalog(explicit).total, 1);
  assert.deepEqual(explicit.explicitSkillIds, ["workspace:.claude/skills/check/SKILL.md"]);
  const relative = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections: [externalSelection(".claude/skills/check/SKILL.md")], userPrompt: "Use $check" });
  assert.equal(relative.entries.length, 0, "a relative selection cannot invent an absolute identity");
});

test("project-discovered Skills ignore global selections on native and fallback discovery paths", async () => {
  const entryPath = "/repo/.claude/skills/check/SKILL.md";
  const document = { entryPath, basePath: "/repo/.claude/skills/check", scope: "workspace", content: "---\nname: check\n---\nCHECK", supportingFiles: [] };
  for (const surface of ["native", "fallback"]) {
    const api = await loadAgentSkillsModule({
      discoverPersonalAgentSkills: async () => surface === "native" ? [document] : [],
      globSearch: async (pattern) => pattern === ".claude/skills/**/SKILL.md" ? [".claude/skills/check/SKILL.md"] : [],
      readFile: async (path) => path.endsWith("SKILL.md") ? document.content : "",
    });
    for (const mode of ["auto", "manual"]) {
      const hidden = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections: [externalSelection(entryPath, mode)], userPrompt: "Use $check" });
      assert.equal(hidden.entries.length, 0, `${surface} must require exact project-scope admission`);
    }
    const admitted = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections: [externalSelection(entryPath, "auto", "/repo")], userPrompt: "Use $check" });
    assert.equal(admitted.entries.length, 1);
  }
});

test("explicit short references select one admitted manual Skill despite an ambiguous display name", async () => {
  const api = await loadAgentSkillsModule({});
  const skills = [
    { id: "one", name: "duplicate", content: "FIRST", active: true, allowImplicitInvocation: false },
    { id: "two", name: "duplicate", content: "SECOND", active: true, allowImplicitInvocation: false },
  ];
  const before = await api.loadSkillCatalog({ workspace: "", skills });
  const ref = api.skillReference(before, "panel:two");
  const selected = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: `Use $${ref} for this task.` });
  assert.deepEqual(selected.explicitSkillIds, ["panel:two"]);
  assert.deepEqual(api.listSkillCatalog(selected).entries.map((entry) => entry.id), ["panel:two"]);
  assert.equal(api.loadSkillContent(selected, ref).content, "SECOND");
  const byName = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: "Use $duplicate" });
  assert.deepEqual(byName.explicitSkillIds, []);
  assert.match(byName.warnings.join(" "), /ambiguous/);
  for (const userPrompt of [`Use $${ref}:99`, `Use $${ref}tail`]) {
    assert.deepEqual((await api.loadSkillCatalog({ workspace: "", skills, userPrompt })).explicitSkillIds, []);
  }
});

test("an explicit external short reference cannot resurrect a missing or disabled selection", async () => {
  const entryPath = "/home/.codex/skills/review/SKILL.md";
  const api = await loadAgentSkillsModule({
    discoverPersonalAgentSkills: async () => [{ entryPath, basePath: "/home/.codex/skills/review", content: "---\nname: review\n---\nBODY", supportingFiles: [] }],
  });
  const skills = [];
  const admitted = await api.loadSkillCatalog({ workspace: "", skills, externalSkillSelections: [externalSelection(entryPath, "manual")] });
  const ref = api.skillReference(admitted, admitted.entries[0].id);
  for (const externalSkillSelections of [[], [externalSelection(entryPath, "disabled")]]) {
    const hidden = await api.loadSkillCatalog({ workspace: "", skills, externalSkillSelections, userPrompt: `Use $${ref}` });
    assert.equal(hidden.entries.length, 0);
    assert.deepEqual(hidden.explicitSkillIds, []);
  }
  const selected = await api.loadSkillCatalog({ workspace: "", skills, externalSkillSelections: [externalSelection(entryPath, "manual")], userPrompt: `Use $${ref}` });
  assert.deepEqual(selected.explicitSkillIds, [admitted.entries[0].id]);
});

test("collision-suffixed explicit references select the same identity after catalog reordering", async () => {
  const api = await loadAgentSkillsModule({});
  const skills = ["1t9y1uh", "1jton3x"].map((id) => ({ id, name: "duplicate", content: id, active: true, allowImplicitInvocation: false }));
  const before = await api.loadSkillCatalog({ workspace: "", skills });
  const id = before.entries[1].id;
  const ref = api.skillReference(before, id);
  assert.match(ref, /^s:507f6898:[12]$/);
  for (const ordered of [skills, [...skills].reverse()]) {
    const selected = await api.loadSkillCatalog({ workspace: "", skills: ordered, userPrompt: `Use $${ref}.` });
    assert.deepEqual(selected.explicitSkillIds, [id]);
    assert.equal(api.listSkillCatalog(selected).entries.length, 1);
  }
  for (const token of ["s:507f6898", "s:507f6898:3", `${ref}:2`, `${ref}extra`]) {
    const invalid = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: `Use $${token}` });
    assert.deepEqual(invalid.explicitSkillIds, []);
  }
});

test("the short-reference namespace cannot also activate a different Skill's display name", async () => {
  const api = await loadAgentSkillsModule({});
  const first = { id: "first", name: "original", content: "FIRST", active: true, allowImplicitInvocation: false };
  const before = await api.loadSkillCatalog({ workspace: "", skills: [first] });
  const ref = api.skillReference(before, "panel:first");
  const other = { id: "other", name: ref, content: "OTHER", active: true, allowImplicitInvocation: false };
  const selected = await api.loadSkillCatalog({ workspace: "", skills: [first, other], userPrompt: `Use $${ref}` });
  assert.deepEqual(selected.explicitSkillIds, ["panel:first"]);
  const otherRef = api.skillReference(selected, "panel:other");
  const selectedOther = await api.loadSkillCatalog({ workspace: "", skills: [first, other], userPrompt: `Use $${otherRef}` });
  assert.deepEqual(selectedOther.explicitSkillIds, ["panel:other"]);
});

test("short-reference tokens cannot also activate a Skill named s through its colon boundary", async () => {
  const api = await loadAgentSkillsModule({});
  const skills = [
    { id: "plain-s", name: "s", content: "PLAIN", active: true, allowImplicitInvocation: false },
    { id: "chosen", name: "chosen", content: "CHOSEN", active: true, allowImplicitInvocation: false },
  ];
  const before = await api.loadSkillCatalog({ workspace: "", skills });
  const ref = api.skillReference(before, "panel:chosen");
  const selected = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: `Use $${ref}` });
  assert.deepEqual(selected.explicitSkillIds, ["panel:chosen"]);
  const invalid = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: "Use $s:00000000:99" });
  assert.deepEqual(invalid.explicitSkillIds, [], "an unknown ref is not an invocation of the name s");
  const plain = await api.loadSkillCatalog({ workspace: "", skills, userPrompt: "Use $s" });
  assert.deepEqual(plain.explicitSkillIds, ["panel:plain-s"]);
});

test("source switches gate discovery before per-Skill selection and retain selections for re-enabling", async () => {
  const sources = ["codex", "claude", "gemini", "custom"];
  const documents = sources.map((platformSource) => ({ platformSource, entryPath: `/home/${platformSource}/review/SKILL.md`, basePath: `/home/${platformSource}/review`, content: `---\nname: ${platformSource}-review\n---\nBODY`, supportingFiles: [] }));
  const requests = [];
  const api = await loadAgentSkillsModule({
    globSearch: async () => [],
    discoverPersonalAgentSkills: async (_workspace, enabledSources) => { requests.push(enabledSources); return documents; },
  });
  const externalSkillSelections = documents.map((document) => externalSelection(document.entryPath));
  const savedSelections = JSON.stringify(externalSkillSelections);
  const onlyCodex = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections, externalSkillSources: { codex: true, claude: false, gemini: false, custom: false } });
  assert.deepEqual(onlyCodex.entries.map((entry) => entry.platformSource), ["codex"]);
  assert.deepEqual(requests[0], ["codex"], "disabled roots must be excluded before native discovery");
  assert.equal(JSON.stringify(externalSkillSelections), savedSelections);
  const restored = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections });
  assert.equal(restored.entries.length, 4, "re-enabling a source reuses the preserved per-Skill selections");
});

test("disabled source cannot be reactivated by an explicit name or short reference", async () => {
  const document = { platformSource: "claude", entryPath: "/home/.claude/skills/review/SKILL.md", basePath: "/home/.claude/skills/review", content: "---\nname: review\n---\nBODY", supportingFiles: [] };
  const api = await loadAgentSkillsModule({ discoverPersonalAgentSkills: async () => [document] });
  const externalSkillSelections = [externalSelection(document.entryPath, "manual")];
  const before = await api.loadSkillCatalog({ workspace: "", skills: [], externalSkillSelections });
  const ref = api.skillReference(before, before.entries[0].id);
  const disabled = await api.loadSkillCatalog({ workspace: "", skills: [], externalSkillSelections, externalSkillSources: { claude: false }, userPrompt: `Use $review and $${ref}` });
  assert.deepEqual(disabled.entries, []);
  assert.deepEqual(disabled.explicitSkillIds, []);
});

test("workspace fallback respects source switches before glob and file reads", async () => {
  const searches = [];
  const api = await loadAgentSkillsModule({
    globSearch: async (pattern) => { searches.push(pattern); return [pattern.replace("**/SKILL.md", "review/SKILL.md")]; },
    readFile: async (target) => target.endsWith("SKILL.md") ? "---\nname: review\n---\nBODY" : "",
  });
  const externalSkillSelections = [
    externalSelection("/repo/.agents/skills/review/SKILL.md", "auto", "/repo"),
    externalSelection("/repo/.claude/skills/review/SKILL.md", "auto", "/repo"),
  ];
  const catalog = await api.loadSkillCatalog({ workspace: "/repo", skills: [], externalSkillSelections, externalSkillSources: { claude: false, gemini: false } });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].entryPath, ".agents/skills/review/SKILL.md");
  assert.equal(catalog.entries[0].platformSource, "codex");
  assert.ok(!searches.some((pattern) => pattern.startsWith(".claude/")));
});

test("local source switches leave registered global packages and panel rules active", async () => {
  const requests = [];
  const api = await loadAgentSkillsModule(globalPackageIpc({ discoverPersonalAgentSkills: async (_workspace, enabled) => { requests.push(enabled); return []; } }));
  const catalog = await api.loadSkillCatalog({ workspace: "", skills: [globalPackageRecord(), { id: "panel", name: "panel", content: "PANEL", active: true }], externalSkillSources: { codex: false, claude: false, gemini: false, custom: false } });
  assert.deepEqual(catalog.entries.map((entry) => entry.source), ["package", "panel"]);
  assert.deepEqual(requests, [[]]);
});

test("a disabled higher-priority source cannot hide an admitted same-name enabled source", async () => {
  const documents = ["codex", "claude"].map((platformSource) => ({ platformSource, entryPath: `/home/${platformSource}/review/SKILL.md`, basePath: `/home/${platformSource}/review`, content: "---\nname: review\n---\nBODY", supportingFiles: [] }));
  const api = await loadAgentSkillsModule({ discoverPersonalAgentSkills: async () => documents });
  const catalog = await api.loadSkillCatalog({ workspace: "", skills: [], externalSkillSelections: documents.map((document) => externalSelection(document.entryPath)), externalSkillSources: { codex: false }, userPrompt: "Use $review" });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].platformSource, "claude");
  assert.deepEqual(catalog.explicitSkillIds, [catalog.entries[0].id]);
});
