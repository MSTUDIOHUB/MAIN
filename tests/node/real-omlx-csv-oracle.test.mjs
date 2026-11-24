import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const { verifyCsvCreatorMappingFixture: verify, verifyCsvDirectEditRepairFixture: verifyDirect,
  createCsvCreatorMappingOracle, useDefaultCsvBehaviorOracle } = createTsModuleLoader()("tests/e2e/realOmlxDirectEditFixture.ts");

const declaration = "export interface CsvOrder { creator?: string; creatorName?: string; }\n";
const shorthand = declaration + "export function normalizeCsvOrder(row: Record<string,string>): CsvOrder { const creatorName = row.creator || row['创建者'] || ''; return {creator: creatorName, creatorName}; }\n";
const wrong = declaration + "// creatorName: this comment must not satisfy acceptance\nexport function normalizeCsvOrder(row: Record<string,string>): CsvOrder { return {creator: row.creator || ''}; }\n";

async function fixture(t, source = shorthand) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "main-csv-oracle-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "src/hooks"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node -e 'process.exit(0)'" } }));
  const parser = path.join(workspace, "src/hooks/useCsvParser.ts");
  await fs.writeFile(parser, source);
  return { workspace, parser };
}

for (const [name, source] of [
  ["shorthand", shorthand],
  ["destructured equivalent", declaration + "export function normalizeCsvOrder(row: Record<string,string>): CsvOrder { const { creator, 创建者 } = row; const creatorName = creator || 创建者 || ''; return {creatorName}; }\n"],
]) test(`ordinary CSV accepts ${name} through five real behaviors and public TypeScript`, async t => {
  const f = await fixture(t, source);
  assert.equal(/creatorName\s*:/i.test(source), false, "reproduces the old oracle's legal-implementation false negative");
  const result = await verify(f.workspace);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.behavior.exitCode, 0);
  assert.equal(result.typecheck.exitCode, 0);
});

for (const [name, source] of [
  ["comment-only field", wrong],
  ["wrong precedence", declaration + "export function normalizeCsvOrder(row: Record<string,string>): CsvOrder { return {creatorName: row['创建者'] || row.creator || ''}; }\n"],
]) test(`ordinary CSV refuses ${name} despite a matching text pattern`, async t => {
  const f = await fixture(t, source);
  assert.equal(/creatorName\s*:/i.test(source), true);
  assert.equal((await verify(f.workspace)).passed, false);
});

test("runtime-correct output cannot hide a missing public creatorName interface", async t => {
  const f = await fixture(t, "export interface CsvOrder { creator?: string; }\nexport function normalizeCsvOrder(row: Record<string,string>): CsvOrder { const creatorName = row.creator || row['创建者'] || ''; const result = {creator: creatorName, creatorName}; return result; }\n");
  const result = await verify(f.workspace);
  assert.equal(result.behavior.exitCode, 0);
  assert.notEqual(result.typecheck.exitCode, 0);
  assert.equal(result.passed, false);
});

test("tampering npm test to exit zero cannot replace the trusted behavior check", async t => {
  const f = await fixture(t, wrong);
  execFileSync("npm", ["test"], { cwd: f.workspace, stdio: "pipe" });
  assert.equal((await verify(f.workspace)).passed, false);
});

test("ordinary CSV adds no Direct-only source requirement and Direct still enforces it", async t => {
  const f = await fixture(t);
  assert.equal((await verify(f.workspace)).passed, true);
  const direct = await verifyDirect(f.workspace);
  assert.equal(direct.passed, false);
  assert.match(direct.behavior.stderr, /CSV source provenance behavior/);
  assert.notEqual(direct.typecheck.exitCode, 0);
});

test("only the generated default CSV fixture replaces its default regex oracle", () => {
  const input = { fixture: "csv", mutationFile: "src/hooks/useCsvParser.ts" };
  assert.equal(useDefaultCsvBehaviorOracle(input), true);
  for (const override of [{ workspaceOverride: "/custom/project" }, { mutationExpectationOverride: "explicit-pattern" },
    { fixture: "md-viewer" }, { fixture: "snake" }, { mutationFile: "README.md" }]) {
    assert.equal(useDefaultCsvBehaviorOracle({ ...input, ...override }), false);
  }
});

test("unchanged source reuses checks, but a new hash cannot borrow an old success", async t => {
  const f = await fixture(t);
  let checked = 0;
  const inspect = createCsvCreatorMappingOracle(async root => { checked += 1; return await verify(root); });
  assert.equal((await inspect(f.workspace)).passed, true);
  const same = await inspect(f.workspace);
  assert.equal(same.passed, true);
  assert.equal(same.cacheHit, true);
  assert.equal(checked, 1, "500ms polls do not repeatedly spawn TypeScript for unchanged bytes");
  await fs.writeFile(f.parser, wrong);
  const changed = await inspect(f.workspace);
  assert.equal(changed.passed, false);
  assert.equal(changed.cacheHit, false);
  assert.equal(checked, 2);
});

for (const restoreOriginal of [false, true]) test(`source changed ${restoreOriginal ? "and restored to the same bytes" : "during validation"} cannot publish a cached success`, async t => {
  const f = await fixture(t);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const inspect = createCsvCreatorMappingOracle(async root => {
    const checked = await verify(root);
    started(); await gate; return checked;
  });
  const pending = inspect(f.workspace);
  await ready;
  await fs.writeFile(f.parser, wrong);
  if (restoreOriginal) await fs.writeFile(f.parser, shorthand);
  release();
  const result = await pending;
  assert.equal(result.passed, false);
  assert.equal(result.sourceChangedDuringCheck, true);
});

test("an imported implementation does not reuse a parser-only cache after dependency changes", async t => {
  const source = "import { mapCreator } from './mapping.ts';\n" + declaration + "export function normalizeCsvOrder(row: Record<string,string>): CsvOrder { return {creatorName: mapCreator(row)}; }\n";
  const f = await fixture(t, source);
  const dependency = path.join(f.workspace, "src/hooks/mapping.ts");
  await fs.writeFile(dependency, "export function mapCreator(row: Record<string,string>): string {return row.creator || row['创建者'] || '';}\n");
  const inspect = createCsvCreatorMappingOracle();
  assert.equal((await inspect(f.workspace)).passed, true);
  await fs.writeFile(dependency, "export function mapCreator(_row: Record<string,string>): string {return 'wrong';}\n");
  const result = await inspect(f.workspace);
  assert.equal(result.passed, false);
  assert.equal(result.cacheHit, false);
});
