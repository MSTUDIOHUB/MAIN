import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

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

  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "./ipc") return ipcStubs;
    if (specifier === "./protocolPackages") {
      return {
        getApplicableProtocolPackagesForWorkspace: (skills, workspace) =>
          skills.filter((skill) =>
            skill.active && skill.type === "package" &&
            skill.workspaceScope === workspace
          ),
        getProtocolPackageEntryPath: (skill) =>
          `${skill.packagePath}/${skill.entryPoint || "SKILL.md"}`,
        isSafeProtocolPackagePath: (packagePath, entryPoint) =>
          packagePath.startsWith(".protocols/") &&
          !packagePath.includes("..") &&
          !String(entryPoint || "").includes(".."),
      };
    }
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
