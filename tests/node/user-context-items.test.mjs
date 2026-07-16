import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
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
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildUserContextItems,
  formatUserContextPathLabel,
  sanitizeUserContextItemsForPersist,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/userContextItems.ts"));
const {
  registerPersistedImageThumbnail,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/utils/imageUtils.ts"));

test("builds mention, attachment, and image pills for a sent user message", () => {
  registerPersistedImageThumbnail(
    "data:image/png;base64,abc",
    "data:image/jpeg;base64,thumbnail",
  );
  const items = buildUserContextItems({
    contextMentions: ["/repo/src/App.tsx"],
    attachedFiles: [{
      id: "report",
      path: "/repo/data/report.csv",
      sourcePath: "/repo/data/report.csv",
      displayName: "report.csv",
      kind: "tabular",
      readable: false,
    }],
    images: ["data:image/png;base64,abc"],
    workspace: "/repo",
    language: "zh",
  });

  assert.deepEqual(items.map((item) => item.kind), ["mention", "attachment", "image"]);
  assert.equal(items[0].label, "src/App.tsx");
  assert.equal(items[1].label, "report.csv");
  assert.equal(items[2].label, "截图 1");
  assert.equal(items[2].previewDataUrl, "data:image/png;base64,abc");
  assert.equal(items[2].thumbnailDataUrl, "data:image/jpeg;base64,thumbnail");
});

test("path labels prefer workspace-relative paths and compact outside paths", () => {
  assert.equal(formatUserContextPathLabel("/repo/src/lib/orchestrator.ts", "/repo"), "src/lib/orchestrator.ts");
  assert.equal(formatUserContextPathLabel("/Users/michael/Desktop/DataFiles/report.csv", "/repo"), ".../DataFiles/report.csv");
});

test("context item sanitizer keeps only a hard-capped generated thumbnail", () => {
  const thumbnailDataUrl = "data:image/jpeg;base64,thumb";
  const persistedItems = sanitizeUserContextItemsForPersist([
    {
      id: "image:0",
      kind: "image",
      label: "截图 1",
      status: "ready",
      previewDataUrl: "data:image/png;base64,abc",
      thumbnailDataUrl,
    },
    {
      id: "mention:/repo/src/App.tsx",
      kind: "mention",
      label: "src/App.tsx",
      path: "/repo/src/App.tsx",
      status: "ready",
    },
  ]);

  assert.equal(persistedItems.length, 2);
  assert.equal(persistedItems[0].previewDataUrl, undefined);
  assert.equal(persistedItems[0].thumbnailDataUrl, thumbnailDataUrl);
  assert.equal(persistedItems[0].label, "截图 1");
  assert.equal(persistedItems[1].path, "/repo/src/App.tsx");
});

test("context item sanitizer rejects original-size or oversized preview payloads", () => {
  const oversizedThumbnail = `data:image/jpeg;base64,${"x".repeat(24_000)}`;
  const persisted = sanitizeUserContextItemsForPersist([
    {
      id: "image:0",
      kind: "image",
      label: "Screenshot",
      previewDataUrl: "data:image/png;base64,original",
      thumbnailDataUrl: oversizedThumbnail,
    },
  ]);

  assert.equal(persisted[0].previewDataUrl, undefined);
  assert.equal(persisted[0].thumbnailDataUrl, undefined);

  const sourceReusedAsThumbnail = "data:image/png;base64,same-source";
  const reused = sanitizeUserContextItemsForPersist([{
    id: "image:1",
    kind: "image",
    label: "Screenshot 2",
    previewDataUrl: sourceReusedAsThumbnail,
    thumbnailDataUrl: sourceReusedAsThumbnail,
  }]);
  assert.equal(reused[0].thumbnailDataUrl, undefined);
});

test("context item sanitizer rejects invalid items", () => {
  assert.deepEqual(
    sanitizeUserContextItemsForPersist([
      { kind: "unknown", label: "bad" },
      { kind: "mention", label: "ok", path: "/repo/ok.md", previewDataUrl: "data:image/png;base64,nope" },
    ]),
    [{ id: "mention:1", kind: "mention", label: "ok", path: "/repo/ok.md" }],
  );
});
