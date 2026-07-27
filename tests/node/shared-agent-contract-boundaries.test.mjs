import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const sourceRoot = path.join(process.cwd(), "src/lib");
const sharedModules = [
  "agentMessages.ts",
  "providerLaneSettings.ts",
  "toolTarget.ts",
];

test("shared agent contracts do not depend on the legacy orchestrator", () => {
  for (const name of sharedModules) {
    const source = fs.readFileSync(path.join(sourceRoot, name), "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*orchestrator(?:\/[^"']*)?["']/,
      `${name} must remain usable without loading the legacy orchestrator`,
    );
  }
});

test("legacy orchestrator facades have been removed", () => {
  assert.equal(fs.existsSync(path.join(sourceRoot, "orchestrator.ts")), false);
  assert.equal(
    fs.readdirSync(path.join(sourceRoot, "orchestrator"), {
      recursive: true,
      withFileTypes: true,
    }).some((entry) => entry.isFile()),
    false,
  );
});

test("Runtime v2 consumers bypass the legacy orchestrator facade", () => {
  for (const name of [
    "executionPorts.ts",
    "planRunner.ts",
    "projectionPort.ts",
  ]) {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/store/runtimeV2", name),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /from\s+["']\.\.\/\.\.\/lib\/orchestrator["']/,
      `${name} must import shared contracts directly`,
    );
  }
});
