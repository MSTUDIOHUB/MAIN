import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const coreRoot = path.join(process.cwd(), "src/lib/runtime-v2");
const forbiddenImport = /from\s+["'](?:react|zustand|@tauri-apps\/|\.\.\/store\/|\.\.\/orchestrator(?:\/|["']))/;
const importPattern = /from\s+["']([^"']+)["']/g;

function localModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test("Runtime v2 core has no Store/UI/legacy imports and no local dependency cycle", () => {
  const files = fs.readdirSync(coreRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(coreRoot, name));
  const graph = new Map(files.map((file) => [file, []]));

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, forbiddenImport, `forbidden runtime dependency in ${path.basename(file)}`);
    for (const match of source.matchAll(importPattern)) {
      const target = localModule(file, match[1]);
      if (target && graph.has(target)) graph.get(file).push(target);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (file, trail = []) => {
    if (visiting.has(file)) {
      assert.fail(`Runtime v2 local import cycle: ${[...trail, file].map(path.basename).join(" -> ")}`);
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency, [...trail, file]);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);
});

test("Runtime v2 execution adapter has no provider/model-name or prose-lifecycle branches", () => {
  const adapterRoot = path.join(process.cwd(), "src/store/runtimeV2");
  const entrySource = fs.readFileSync(
    path.join(adapterRoot, "executionPorts.ts"),
    "utf8",
  );
  const adapterFiles = [
    "executionContext.ts",
    "executionProviderPort.ts",
    "executionSchedulerPort.ts",
    "executionToolPort.ts",
  ];
  const adapterSources = adapterFiles.map((name) => ({
    name,
    source: fs.readFileSync(path.join(adapterRoot, name), "utf8"),
  }));
  const source = adapterSources.map((entry) => entry.source).join("\n");
  for (const entry of adapterSources) {
    assert.ok(
      entry.source.split("\n").length <= 1_000,
      `${entry.name} must stay below the Runtime v2 adapter super-module boundary`,
    );
  }
  assert.ok(
    entrySource.split("\n").length <= 24,
    "executionPorts must remain a small composition barrel instead of regaining runtime policy",
  );
  assert.doesNotMatch(entrySource, /\b(?:async\s+)?function\b|\bclass\b/);
  assert.match(entrySource, /from "\.\/executionProviderPort"/);
  assert.match(entrySource, /from "\.\/executionContext"/);
  assert.match(entrySource, /from "\.\/executionSchedulerPort"/);
  assert.match(entrySource, /from "\.\/executionToolPort"/);
  assert.equal(
    (source.match(/export function createRuntimeV2ProviderPort\b/g) || []).length,
    1,
    "the production execution adapter must have exactly one provider-port implementation",
  );
  assert.doesNotMatch(source, /\b(?:Qwen|OMLX|Ollama|LM\s*Studio|OpenAI|Anthropic)\b/i);
  assert.doesNotMatch(source, /looksLikeUnexecutedAction|missingToolCallReprompt|toolUnavailableClaim/i);
  assert.doesNotMatch(
    source,
    /visibleText\.(?:includes|match|search|startsWith)|RegExp\([^)]*visibleText/,
    "provider prose must never select a lifecycle transition",
  );
  assert.match(source, /resolveRuntimeV2PlanMutationScope/);
  assert.match(source, /resolveRuntimeV2PlanValidationScope/);
  assert.match(source, /providerToolDefinitionsForCommand/);
  assert.match(source, /compactTextEnvelopeCatalog/);
});

test("Runtime v2 store adapters do not import either legacy execution owner", () => {
  const adapterRoot = path.join(process.cwd(), "src/store/runtimeV2");
  const files = fs.readdirSync(adapterRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(adapterRoot, name));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:orchestrator|workflowEngine)[^"']*["']/,
      `legacy execution owner imported by ${path.basename(file)}`,
    );
  }
});

test("Runtime v2 Execute accepts only a durable conclude response as final provider text", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/store/runtimeV2/executeRunner.ts"),
    "utf8",
  );
  assert.match(source, /latestDurableProviderConclusion/);
  assert.match(source, /payload\.mode/);
  assert.match(source, /=== "conclude"/);
  assert.doesNotMatch(source, /hasFinalProviderConclusion|latestVisibleText\s*\?\s*\{\s*finalMarkdown/);
});

test("Runtime v2 Plan keeps one bounded discovery and synthesis path", () => {
  const adapterRoot = path.join(process.cwd(), "src/store/runtimeV2");
  const runner = fs.readFileSync(path.join(adapterRoot, "planRunner.ts"), "utf8");
  const protocol = fs.readFileSync(
    path.join(adapterRoot, "planModelProtocol.ts"),
    "utf8",
  );
  const provider = fs.readFileSync(
    path.join(adapterRoot, "planProviderPort.ts"),
    "utf8",
  );
  const source = `${runner}\n${protocol}\n${provider}`;

  assert.ok(
    runner.split("\n").length <= 850,
    "planRunner must stay below the Runtime v2 Plan super-module boundary",
  );
  assert.doesNotMatch(
    source,
    /audit_discovery|audit_synthesis|mandatory evidence audit|PLAN_AUDIT_/i,
  );
  assert.doesNotMatch(
    source,
    /initial placeholder state|programmatic UI updates|serialized argument names/i,
    "Plan orchestration must not encode one incident's likely diagnosis",
  );
  assert.match(protocol, /type PlanModelStage = "discovery" \| "synthesis"/);
  assert.match(runner, /PLAN_DISCOVERY_ACTION_BUDGET/);
  assert.match(runner, /runtime_v2_plan_synthesis_boundary/);
});
