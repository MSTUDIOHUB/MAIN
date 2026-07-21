import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }
  const source = fs.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fs.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { buildToolCatalog } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolCatalog.ts"),
);
const {
  canRecordPlanExecutionEvidenceForTool,
  hasVerifiedWorkspaceMutationEffect,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolResultEffect.ts"),
);

function definition(name) {
  return {
    type: "function",
    function: {
      name,
      description: `Built-in ${name}`,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

function mcpTool(serverName, serverUrl, name, description = name) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {}, required: [] },
    _mainMcpOrigin: { serverName, serverUrl, remoteName: name },
  };
}

function toolSkill({
  id,
  name = "Deploy",
  desc = name,
  packagePath,
  entryPoint,
  toolParameters,
}) {
  return {
    id,
    name,
    desc,
    content: "",
    active: true,
    type: "tool",
    ...(packagePath ? { packagePath } : {}),
    ...(entryPoint ? { entryPoint } : {}),
    ...(toolParameters ? { toolParameters } : {}),
  };
}

function skillSnapshot(catalog) {
  return catalog.entries
    .filter((entry) => entry.source === "skill")
    .map((entry) => ({
      skillId: entry.skillId,
      packagePath: entry.packagePath,
      entryPoint: entry.entryPoint,
      canonicalName: entry.canonicalName,
      exposedName: entry.exposedName,
      executionName: entry.executionName,
      description: entry.definition.function.description,
    }))
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function catalogSnapshot(catalog) {
  return {
    definitions: catalog.toolDefinitions.map((tool) => tool.function.name),
    mcp: catalog.entries
      .filter((entry) => entry.source === "mcp")
      .map((entry) => ({
        canonicalName: entry.canonicalName,
        exposedName: entry.exposedName,
        executionName: entry.executionName,
        serverUrl: entry.serverUrl,
      })),
    diagnostics: catalog.diagnostics,
  };
}

test("built-ins retain bare-name ownership when an MCP server registers the same name", () => {
  const catalog = buildToolCatalog({
    builtInDefinitions: [definition("read_file")],
    mcpTools: [mcpTool("Files", "http://files.example/mcp", "read_file")],
  });

  const bare = catalog.lookup("read_file");
  assert.equal(bare.status, "resolved");
  assert.equal(bare.entry.source, "built_in");

  const mcpEntry = catalog.entries.find((entry) => entry.source === "mcp");
  assert.ok(mcpEntry);
  assert.notEqual(mcpEntry.exposedName, "read_file");
  assert.equal(catalog.lookup(mcpEntry.canonicalName).entry.source, "mcp");
  assert.equal(catalog.lookup(mcpEntry.canonicalName).entry.executionName, "read_file");
  assert.equal(catalog.mcpToolServerMap.read_file, undefined);
  assert.equal(catalog.mcpToolServerMap[mcpEntry.canonicalName], "http://files.example/mcp");

  const diagnostic = catalog.diagnostics.find((item) =>
    item.code === "reserved_name" && item.requestedName === "read_file"
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.winner.source, "built_in");
});

test("same-name external editors cannot inherit built-in mutation trust", () => {
  const catalog = buildToolCatalog({
    builtInDefinitions: [definition("replace_in_file")],
    mcpTools: [mcpTool("Files", "http://files.example/mcp", "replace_in_file")],
    skills: [toolSkill({
      id: "skill-replace-in-file",
      name: "replace in file",
      desc: "External replacement implementation",
      packagePath: ".protocols/replace-in-file",
      entryPoint: "SKILL.md",
    })],
  });
  const builtIn = catalog.lookup("replace_in_file").entry;
  const mcp = catalog.entries.find((entry) => entry.source === "mcp");
  const skill = catalog.entries.find((entry) => entry.source === "skill");
  assert.ok(mcp);
  assert.ok(skill);
  assert.equal(mcp.executionName, "replace_in_file");
  assert.equal(skill.executionName, "replace_in_file");

  const resultFor = (entry, workspaceMutationEvidence) => ({
    toolCallId: `call-${entry.source}`,
    name: entry.exposedName,
    executionName: entry.executionName,
    catalogIdentity: {
      source: entry.source,
      canonicalName: entry.canonicalName,
    },
    executedArgs: {
      path: "src/example.ts",
      old_string: "before",
      new_string: "after",
    },
    target: "src/example.ts",
    content: "replacement completed",
    isError: false,
    lifecycleState: "completed",
    ...(workspaceMutationEvidence ? { workspaceMutationEvidence } : {}),
  });

  assert.equal(hasVerifiedWorkspaceMutationEffect(resultFor(builtIn)), true);
  assert.equal(hasVerifiedWorkspaceMutationEffect(resultFor(mcp)), false);
  assert.equal(hasVerifiedWorkspaceMutationEffect(resultFor(skill)), false);
  assert.equal(hasVerifiedWorkspaceMutationEffect({
    ...resultFor(builtIn),
    catalogIdentity: undefined,
  }), false, "missing provenance is fail-closed");

  const observed = { changedPaths: ["src/example.ts"] };
  assert.equal(hasVerifiedWorkspaceMutationEffect(resultFor(mcp, observed)), true);
  assert.equal(hasVerifiedWorkspaceMutationEffect(resultFor(skill, observed)), true);

  assert.equal(canRecordPlanExecutionEvidenceForTool({
    executionName: builtIn.executionName,
    catalogIdentity: resultFor(builtIn).catalogIdentity,
    hasObservedDiff: false,
  }), true);
  assert.equal(canRecordPlanExecutionEvidenceForTool({
    executionName: mcp.executionName,
    catalogIdentity: resultFor(mcp).catalogIdentity,
    hasObservedDiff: false,
  }), false);
  assert.equal(canRecordPlanExecutionEvidenceForTool({
    executionName: skill.executionName,
    catalogIdentity: resultFor(skill).catalogIdentity,
    hasObservedDiff: false,
  }), false);
  assert.equal(canRecordPlanExecutionEvidenceForTool({
    executionName: mcp.executionName,
    catalogIdentity: resultFor(mcp).catalogIdentity,
    hasObservedDiff: true,
  }), true);
});

test("tool lifecycle gates built-in mutation fallback on catalog provenance", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const lifecycle = source.slice(
    source.indexOf("async function executeToolCallWithLifecycle"),
    source.indexOf("export async function autoMaterializePlanArtifactFromVisibleText"),
  );

  assert.match(
    lifecycle,
    /const catalogIdentity: ToolCatalogIdentity = catalogResolution\?\.status === "resolved"[\s\S]*source: catalogResolution\.entry\.source/,
  );
  assert.match(
    lifecycle,
    /const trustedBuiltInMutation =[\s\S]*catalogIdentity\.source === "built_in"[\s\S]*BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES\.has\(executionName\)/,
  );
  assert.match(
    lifecycle,
    /const completedDiffPreview = observedMutationDiffPreview \|\|[\s\S]*trustedBuiltInMutation \? diffPreview : undefined/,
  );
  assert.doesNotMatch(
    lifecycle,
    /: BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES\.has\(executionName\)[\s\S]{0,160}\? resolveWorkspaceMutationTargets/,
  );
});

test("a skill conflicting with a built-in keeps a distinct execution source", () => {
  const catalog = buildToolCatalog({
    builtInDefinitions: [definition("read_file")],
    skills: [toolSkill({
      id: "skill-read-file",
      name: "read file",
      desc: "Custom skill implementation",
      packagePath: ".protocols/read-file",
      entryPoint: "SKILL.md",
    })],
  });

  assert.equal(catalog.lookup("read_file").entry.source, "built_in");
  const skillEntry = catalog.entries.find((entry) => entry.source === "skill");
  assert.ok(skillEntry);
  assert.notEqual(skillEntry.exposedName, "read_file");
  assert.equal(catalog.lookup(skillEntry.exposedName).entry.source, "skill");
  assert.equal(skillEntry.executionName, "read_file");
  assert.equal(skillEntry.skillId, "skill-read-file");
  assert.equal(skillEntry.packagePath, ".protocols/read-file");
  assert.equal(skillEntry.entryPoint, "SKILL.md");
});

test("same-name Skills receive unique stable identities and bare lookup stays ambiguous", () => {
  const alpha = toolSkill({
    id: "skill-alpha",
    name: "Deploy",
    packagePath: ".protocols/alpha",
    entryPoint: "commands/deploy.md",
  });
  const beta = toolSkill({
    id: "skill-beta",
    name: "Deploy",
    packagePath: ".protocols/beta",
    entryPoint: "SKILL.md",
  });
  const first = buildToolCatalog({ builtInDefinitions: [], skills: [alpha, beta] });
  const second = buildToolCatalog({ builtInDefinitions: [], skills: [beta, alpha] });
  const skillEntries = first.entries.filter((entry) => entry.source === "skill");

  assert.equal(skillEntries.length, 2);
  assert.equal(new Set(skillEntries.map((entry) => entry.canonicalName)).size, 2);
  assert.equal(new Set(first.toolDefinitions.map((tool) => tool.function.name)).size, 2);
  for (const entry of skillEntries) {
    assert.match(entry.canonicalName, /^skill__deploy__/);
    assert.equal(entry.exposedName, entry.canonicalName);
    const exact = first.lookup(entry.canonicalName);
    assert.equal(exact.status, "resolved");
    assert.equal(exact.entry.skillId, entry.skillId);
    assert.equal(exact.entry.packagePath, entry.packagePath);
    assert.equal(exact.entry.entryPoint, entry.entryPoint);
  }

  const bare = first.lookup("deploy");
  assert.equal(bare.status, "ambiguous");
  assert.deepEqual(
    bare.candidates.map((entry) => entry.skillId).sort(),
    ["skill-alpha", "skill-beta"],
  );
  assert.deepEqual(skillSnapshot(first), skillSnapshot(second));
});

test("an exact Skill runtime identity is deduplicated deterministically", () => {
  const identity = {
    id: "skill-deploy",
    name: "Deploy",
    packagePath: ".protocols/deploy",
    entryPoint: "SKILL.md",
  };
  const alpha = toolSkill({ ...identity, desc: "Alpha definition" });
  const zulu = toolSkill({ ...identity, desc: "Zulu definition" });
  const first = buildToolCatalog({ builtInDefinitions: [], skills: [zulu, alpha] });
  const second = buildToolCatalog({ builtInDefinitions: [], skills: [alpha, zulu] });
  const skillEntries = first.entries.filter((entry) => entry.source === "skill");

  assert.equal(skillEntries.length, 1);
  assert.equal(skillEntries[0].skillId, identity.id);
  assert.equal(skillEntries[0].packagePath, identity.packagePath);
  assert.equal(skillEntries[0].entryPoint, identity.entryPoint);
  assert.equal(skillEntries[0].definition.function.description, "Alpha definition");
  assert.deepEqual(skillSnapshot(first), skillSnapshot(second));
  assert.ok(first.diagnostics.some((item) =>
    item.code === "duplicate_registration" && item.requestedName === "deploy"
  ));
});

test("MCP conflicts produce the same canonical catalog regardless of discovery order", () => {
  const alpha = mcpTool("Alpha", "http://alpha.example/mcp", "search", "Alpha search");
  const beta = mcpTool("Beta", "http://beta.example/mcp", "search", "Beta search");
  const first = buildToolCatalog({ builtInDefinitions: [], mcpTools: [alpha, beta] });
  const second = buildToolCatalog({ builtInDefinitions: [], mcpTools: [beta, alpha] });

  assert.deepEqual(catalogSnapshot(first), catalogSnapshot(second));
  assert.equal(first.lookup("search").status, "ambiguous");
  assert.equal(first.lookup("search").candidates.length, 2);
  assert.equal(new Set(first.toolDefinitions.map((tool) => tool.function.name)).size, 2);
  assert.ok(first.diagnostics.some((item) =>
    item.code === "duplicate_name" && item.requestedName === "search" && item.candidates.length === 2
  ));
});

test("canonical and legacy aliases resolve to the same MCP execution target", () => {
  const catalog = buildToolCatalog({
    builtInDefinitions: [],
    mcpTools: [mcpTool("Odd Server", "http://odd.example/mcp", "browser:take screenshot")],
  });
  const entry = catalog.entries[0];

  assert.match(entry.canonicalName, /^mcp__/);
  assert.equal(entry.exposedName, entry.canonicalName);

  const canonical = catalog.lookup(entry.canonicalName);
  const alias = catalog.lookup("browser:take screenshot");
  assert.equal(canonical.status, "resolved");
  assert.equal(canonical.entry.serverUrl, "http://odd.example/mcp");
  assert.equal(alias.status, "resolved");
  assert.equal(alias.via, "alias");
  assert.equal(alias.entry.executionName, "browser:take screenshot");
});

test("unknown tool names fail closed instead of falling through to another source", () => {
  const catalog = buildToolCatalog({
    builtInDefinitions: [definition("read_file")],
    mcpTools: [mcpTool("Browser", "http://browser.example/mcp", "browser_capture")],
  });

  assert.deepEqual(catalog.lookup("does_not_exist"), {
    status: "unknown",
    requestedName: "does_not_exist",
  });
});

test("the production registry and executor both use the same catalog lookup", () => {
  const registrySource = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolRegistrySetup.ts"),
    "utf8",
  );
  const executorSource = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/toolExecutor.ts"),
    "utf8",
  );
  const executionPhaseSource = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallExecutionPhase.ts"),
    "utf8",
  );

  assert.match(registrySource, /buildToolCatalog\(/);
  assert.match(registrySource, /toolCatalog\.toolDefinitions/);
  assert.match(executorSource, /options\.toolCatalog\.lookup\(name\)/);
  assert.match(executorSource, /resolution\.entry\.executionName/);
  assert.match(executorSource, /resolution\.entry\.source === "skill"/);
  assert.match(executorSource, /invoke<string>\("execute_skill"/);
  assert.match(executorSource, /skillId:\s*resolution\.entry\.skillId/);
  assert.match(executorSource, /packagePath:\s*resolution\.entry\.packagePath\s*\?\?\s*null/);
  assert.match(executorSource, /entryPoint:\s*resolution\.entry\.entryPoint\s*\?\?\s*null/);
  assert.match(executorSource, /SKILL_IDENTITY_REQUIRED/);
  assert.doesNotMatch(
    executorSource,
    /invoke<string>\("execute_skill",\s*\{\s*name,\s*args\s*\}\)/s,
  );
  assert.match(executorSource, /UNKNOWN_TOOL/);
  assert.match(executionPhaseSource, /input\.toolCatalog\.lookup\(call\.name\)/);
  assert.match(executionPhaseSource, /resolution\.entry\.exposedName/);
});
