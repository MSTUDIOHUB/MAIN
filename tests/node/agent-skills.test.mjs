import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();

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
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "yaml") return createRequire(import.meta.url)(specifier);
    if (specifier === "./ipc") return ipcStubs;
    if (specifier === "./protocolPackages") return protocolModule.exports;
    throw new Error(`Unexpected require in test: ${specifier}`);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    localRequire,
  );
  return module.exports;
}

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
  const snapshot = await loadSkillCatalog({ workspace: "", skills: [] });
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
  const snapshot = await loadSkillCatalog({ workspace: "", skills: [] });
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
  assert.equal(loaded.content, lines.slice(0, 4).join("\r\n") + "\r\n");
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
  const snapshot = await api.loadSkillCatalog({ workspace: "", skills: [], userPrompt: "Use $path-workflow" });
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
