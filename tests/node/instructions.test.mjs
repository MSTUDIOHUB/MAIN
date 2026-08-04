import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const workspaceRoot = process.cwd();

async function loadInstructionsModule(ipcStubs) {
  const sourcePath = path.join(workspaceRoot, "src/lib/instructions.ts");
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
    if (specifier === "./ipc") {
      return ipcStubs;
    }
    throw new Error(`Unexpected require in test: ${specifier}`);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

test("loadResolvedInstructions keeps normal MAIN templates but skips game-studio templates", async () => {
  const files = {
    ".MAIN/templates/plan/design.md": "---\npaths:\n  - src/**\n---\n# Design Template",
    ".MAIN/templates/game-studio/gdd.md": "# GDD Template",
  };
  const workspaceCalls = [];

  const { loadResolvedInstructions } = await loadInstructionsModule({
    globSearch: async (pattern, workspace) => {
      workspaceCalls.push(["glob", pattern, workspace]);
      if (pattern === ".MAIN/steering/*.md") return [];
      if (pattern === ".MAIN/rules/*.md") return [];
      if (pattern === ".MAIN/templates/**/*.md") return Object.keys(files);
      return [];
    },
    readFile: async (targetPath, workspace) => {
      workspaceCalls.push(["read", targetPath, workspace]);
      if (!(targetPath in files)) {
        throw new Error(`Unknown path: ${targetPath}`);
      }
      return files[targetPath];
    },
  });

  const resolved = await loadResolvedInstructions("/tmp/workspace", [], ["src/main.ts"]);

  assert.equal(resolved.templates.length, 1);
  assert.equal(resolved.templates[0].source.path, ".MAIN/templates/plan/design.md");
  assert.match(resolved.templates[0].content, /Design Template/);
  assert.equal(
    resolved.templates.some((template) => template.source.path === ".MAIN/templates/game-studio/gdd.md"),
    false,
  );
  assert.ok(workspaceCalls.length > 0);
  assert.equal(
    workspaceCalls.every(([, , workspace]) => workspace === "/tmp/workspace"),
    true,
    "every instruction read and glob must stay inside the immutable workspace",
  );
});

test("steering loads only explicit always and matching file rules", async () => {
  const files = {
    ".MAIN/steering/README.md": "# Documentation only",
    ".MAIN/steering/product.md":
      "---\ninclusion: always\n---\n# Product invariant",
    ".MAIN/steering/rust.md":
      "---\ninclusion: fileMatch\nfileMatchPattern: [\"src-tauri/**/*.rs\"]\n---\n# Rust invariant",
    ".MAIN/steering/manual.md":
      "---\ninclusion: manual\n---\n# Manual only",
    ".MAIN/steering/auto.md":
      "---\ninclusion: auto\n---\n# Model-selected only",
  };
  const { loadResolvedInstructions } = await loadInstructionsModule({
    globSearch: async (pattern) => {
      if (pattern === ".MAIN/steering/*.md") {
        return Object.keys(files);
      }
      return [];
    },
    readFile: async (targetPath) => {
      if (!(targetPath in files)) throw new Error("missing");
      return files[targetPath];
    },
  });

  const resolved = await loadResolvedInstructions(
    "/tmp/workspace",
    [],
    ["src-tauri/src/lib.rs"],
  );
  const paths = resolved.layers.map((layer) => layer.source.path);

  assert.deepEqual(paths, [
    ".MAIN/steering/product.md",
    ".MAIN/steering/rust.md",
  ]);
  assert.equal(
    resolved.layers.every((layer) => layer.source.kind === "steering"),
    true,
  );
});

test("resolved project instructions render with complete content and source provenance", async () => {
  const { renderResolvedInstructionContext } =
    await loadInstructionsModule({
      globSearch: async () => [],
      readFile: async () => "",
    });
  const longRule = `preserve-this-tail:${"x".repeat(12_000)}`;
  const rendered = renderResolvedInstructionContext({
    layers: [{
      id: "legacy:AGENTS.md:0",
      title: "AGENTS.md",
      content: longRule,
      order: 0,
      source: {
        id: "legacy:AGENTS.md:0",
        name: "AGENTS.md",
        kind: "legacy",
        path: "AGENTS.md",
        enabled: true,
        order: 0,
      },
    }],
    templates: [],
    sources: [],
    matchedRules: [],
    associatedPaths: [],
    loadedAt: 1,
    debugSummary: "",
  });

  assert.match(rendered, /^## AGENTS\.md/m);
  assert.match(rendered, /^Source: AGENTS\.md/m);
  assert.ok(rendered.endsWith(longRule));
  assert.doesNotMatch(rendered, /session_memory/i);
  assert.doesNotMatch(rendered, /TRUNCATED/);
});
