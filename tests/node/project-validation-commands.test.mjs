import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const output = ts.transpileModule(fsSync.readFileSync(normalizedPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fsSync.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { resolveTrustedProjectValidationCommands } = loadTs(
  path.join(process.cwd(), "src/lib/projectValidationCommands.ts"),
);

test("trusted manifest resolver uses the declared test script instead of guessing from source files", () => {
  const result = resolveTrustedProjectValidationCommands(JSON.stringify({
    scripts: { test: "tsc --noEmit" },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.commands.map((entry) => entry.command), ["npm test"]);
  assert.equal(result.commands.some((entry) => entry.command === "npm run build"), false);
});

test("trusted manifest resolver fails closed without a finite declared validation script", () => {
  assert.deepEqual(
    resolveTrustedProjectValidationCommands(JSON.stringify({ scripts: { dev: "vite" } })),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands("{broken"),
    { ok: false, commands: [], reason: "invalid_package_manifest_json" },
  );
});

test("trusted manifest resolver rejects watch and development script bodies", () => {
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { test: "vitest --watch" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { build: "vite build --watch" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { check: "npm run dev" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { test: "vitest" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { test: "jest --watchAll" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { test: "npm run test:watch", "test:watch": "vitest" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { test: "vitest --ui" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
  assert.deepEqual(
    resolveTrustedProjectValidationCommands({ scripts: { test: "playwright test --ui" } }),
    { ok: false, commands: [], reason: "no_finite_validation_script" },
  );
});

test("trusted manifest resolver honors a supported packageManager identity", () => {
  const result = resolveTrustedProjectValidationCommands({
    packageManager: "pnpm@10.0.0",
    scripts: { test: "vitest run" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.commands[0].command, "pnpm run test");
});

test("trusted manifest resolver prefers a bounded check over an end-to-end suite", () => {
  const result = resolveTrustedProjectValidationCommands({
    scripts: {
      "test:e2e": "playwright test",
      check: "tsc --noEmit",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.commands[0].command, "npm run check");
});
