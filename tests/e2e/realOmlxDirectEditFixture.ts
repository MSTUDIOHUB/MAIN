import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const typecheckArgs = ["--noEmit", "--strict", "--target", "ES2020", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--skipLibCheck"];
const creatorCases = [
  [{ creator: "alice" }, "alice"],
  [{ 创建者: "林" }, "林"],
  [{ creator: "alice", 创建者: "林" }, "alice"],
  [{ creator: "", 创建者: "林" }, "林"],
  [{}, ""],
];

function behaviorSource(moduleSpecifier: string, requireSource: boolean): string {
  return [
    "import assert from 'node:assert/strict';",
    `import { normalizeCsvOrder } from ${JSON.stringify(moduleSpecifier)};`,
    `for (const [row, expected] of ${JSON.stringify(creatorCases)}) {`,
    "  const result = normalizeCsvOrder(row);",
    "  assert.equal(result.creatorName, expected, 'CSV creatorName behavior');",
    ...(requireSource ? ["  assert.equal(result.source, 'csv', 'CSV source provenance behavior');"] : []),
    "}",
    "",
  ].join("\n");
}

function consumerTypeContract(moduleSpecifier: string, requireSource = true): string {
  return [
    `import { normalizeCsvOrder, type CsvOrder } from ${JSON.stringify(moduleSpecifier)};`,
    "const result: CsvOrder = normalizeCsvOrder({ creator: 'typecheck' });",
    "const creator: string | undefined = result.creatorName;",
    ...(requireSource ? ["const source: string | undefined = result.source;", "void source;"] : []),
    "void creator;",
    "",
  ].join("\n");
}

/** Visible fixture requirements are installed before admission. Diagnostics
 * come from actual behavior and TypeScript, never source-pattern matching. */
export async function prepareCsvDirectEditRepairFixture(workspace: string): Promise<void> {
  const tests = path.join(workspace, "tests");
  const testPath = path.join(tests, "creator-mapping.test.mjs");
  const original = await fs.readFile(testPath, "utf8");
  const marker = "// DIRECT_EDIT_SOURCE_BEHAVIOR_CONTRACT";
  if (!original.includes(marker)) {
    await fs.writeFile(testPath, `${original}\n${marker}\n` + [
      "for (const row of [{ creator: 'alice' }, { 创建者: '林' }, {}]) {",
      "  assert.equal(normalizeCsvOrder(row).source, 'csv', 'CSV source provenance behavior');",
      "}",
      "",
    ].join("\n"));
  }
  await fs.writeFile(path.join(tests, "direct-edit-parser-contract.ts"), consumerTypeContract("../src/hooks/useCsvParser.ts"));
  const compiler = path.resolve("node_modules/typescript/bin/tsc");
  await fs.writeFile(path.join(tests, "typecheck-parser.cjs"), [
    "const { spawnSync } = require('node:child_process');",
    `const result = spawnSync(process.execPath, ${JSON.stringify([compiler, ...typecheckArgs, "tests/direct-edit-parser-contract.ts"])}, { stdio: 'inherit' });`,
    "if (result.error) throw result.error;",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"));
  const packagePath = path.join(workspace, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  const typecheck = "node tests/typecheck-parser.cjs";
  const current = pkg.scripts?.test || "node tests/creator-mapping.test.mjs";
  pkg.scripts = { ...pkg.scripts, test: current.includes(typecheck) ? current : `${current} && ${typecheck}` };
  await fs.writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");
}

async function runProcess(workspace: string, args: string[]) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, timedOut }); });
  });
}

/** Independent trusted checks cannot be bypassed by editing package.json or
 * fixture test files. They import the actual current parser from the workspace. */
async function verifyCsvFixture(workspace: string, requireSource: boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-direct-edit-contract-"));
  try {
    const parser = path.join(path.resolve(workspace), "src/hooks/useCsvParser.ts");
    const contract = path.join(directory, "parser-contract.ts");
    await fs.writeFile(contract, consumerTypeContract(parser, requireSource));
    const behavior = await runProcess(workspace, ["--input-type=module", "--eval", behaviorSource(pathToFileURL(parser).href, requireSource)]);
    const typecheck = await runProcess(workspace, [path.resolve("node_modules/typescript/bin/tsc"), ...typecheckArgs, contract]);
    return { passed: behavior.exitCode === 0 && !behavior.timedOut && typecheck.exitCode === 0 && !typecheck.timedOut, behavior, typecheck };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export async function verifyCsvDirectEditRepairFixture(workspace: string) {
  return await verifyCsvFixture(workspace, true);
}

/** The ordinary CSV repair has no Direct Edit-only source provenance demand. */
export async function verifyCsvCreatorMappingFixture(workspace: string) {
  return await verifyCsvFixture(workspace, false);
}

export function useDefaultCsvBehaviorOracle(input: {
  fixture: string;
  workspaceOverride?: string;
  mutationExpectationOverride?: string;
  mutationFile: string;
}): boolean {
  return input.fixture === "csv" && !String(input.workspaceOverride || "").trim() &&
    !String(input.mutationExpectationOverride || "").trim() && input.mutationFile === "src/hooks/useCsvParser.ts";
}

type CsvVerification = Awaited<ReturnType<typeof verifyCsvCreatorMappingFixture>>;
type CachedCsvVerification = CsvVerification & { sourceHash: string; sourceChangedDuringCheck: boolean; cacheHit: boolean };

async function currentParserVersion(workspace: string) {
  const parser = path.join(workspace, "src/hooks/useCsvParser.ts");
  const stat = await fs.stat(parser, { bigint: true });
  const source = await fs.readFile(parser, "utf8");
  const after = await fs.stat(parser, { bigint: true });
  const stamp = (value: typeof stat) => `${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  return { sourceHash: createHash("sha256").update(source).digest("hex"), stamp: stamp(after),
    stable: stamp(stat) === stamp(after),
    // Imported implementations may depend on other files. They are checked
    // afresh rather than reusing a parser-only content cache.
    selfContained: !/\b(?:import|require)\b|\bexport\s*\{[^}]*\}\s*from\b/.test(source) };
}

export function createCsvCreatorMappingOracle(
  check: typeof verifyCsvCreatorMappingFixture = verifyCsvCreatorMappingFixture,
) {
  const cache = new Map<string, { stamp: string; pending: Promise<CachedCsvVerification> }>();
  return async (workspace: string): Promise<CachedCsvVerification> => {
    const root = await fs.realpath(workspace);
    const before = await currentParserVersion(root);
    const key = `${root}\0${before.sourceHash}`;
    const cached = before.stable && before.selfContained ? cache.get(key) : null;
    const hit = cached?.stamp === before.stamp;
    if (cached && !hit) cache.delete(key);
    let pending = hit ? cached!.pending : null;
    if (!pending) {
      pending = (async () => {
        const result = await check(root);
        const after = await currentParserVersion(root);
        const changed = !before.stable || !after.stable || before.sourceHash !== after.sourceHash || before.stamp !== after.stamp;
        return { ...result, passed: result.passed && !changed, sourceHash: before.sourceHash, sourceChangedDuringCheck: changed, cacheHit: false };
      })();
      if (before.stable && before.selfContained) cache.set(key, { stamp: before.stamp, pending });
    }
    try {
      const checked = await pending;
      const after = await currentParserVersion(root);
      const changed = checked.sourceChangedDuringCheck || before.sourceHash !== after.sourceHash || before.stamp !== after.stamp || !after.stable;
      if (changed) cache.delete(key);
      return { ...checked, passed: checked.passed && !changed, sourceChangedDuringCheck: changed, cacheHit: !!hit };
    } catch (error) { cache.delete(key); throw error; }
  };
}
