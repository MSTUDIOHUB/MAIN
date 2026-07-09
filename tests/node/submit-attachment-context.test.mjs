import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

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
  moduleCache.set(normalizedPath, module.exports);
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildSubmitAttachmentContext,
  shouldUseDocumentReader,
  shouldUseTabularAnalyzer,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitAttachmentContext.ts"),
);

function createDeps(overrides = {}) {
  const calls = {
    failed: [],
    ingested: [],
    readFiles: [],
    readDocuments: [],
    analyzed: [],
  };
  const deps = {
    calls,
    markUserContextItemFailed(path) {
      calls.failed.push(path);
    },
    async ingestAttachmentFile(sessionKey, sourcePath) {
      calls.ingested.push({ sessionKey, sourcePath });
      return {
        path: `.MAIN/attachments/${path.basename(sourcePath)}`,
        workspace: "/repo",
        originalPath: sourcePath,
        displayName: path.basename(sourcePath),
        sizeBytes: 12,
      };
    },
    async readFile(filePath, workspace) {
      calls.readFiles.push({ path: filePath, workspace });
      return `RAW:${filePath}`;
    },
    async readDocument(filePath, maxChars, maxBlocks, rowOffset, maxRows, sheet, workspace) {
      calls.readDocuments.push({ path: filePath, maxChars, maxBlocks, rowOffset, maxRows, sheet, workspace });
      return {
        path: filePath,
        documentType: filePath.endsWith(".csv") ? "csv" : "pdf",
        title: "Doc Title",
        content: `DOC:${filePath}`,
        charCount: 10,
        truncated: false,
        metadata: { fallback: true },
        blocks: [],
      };
    },
    async analyzeTabularDocument(filePath, sheet, maxColumns, sampleRows, focusColumns, workspace) {
      calls.analyzed.push({ path: filePath, sheet, maxColumns, sampleRows, focusColumns, workspace });
      return {
        path: filePath,
        documentType: "csv",
        sourceName: path.basename(filePath),
        metadata: {
          rowCount: 2,
          columnCount: 2,
          columns: ["name", "score"],
          numericColumns: ["score"],
          categoricalColumns: ["name"],
          datetimeColumns: [],
        },
        columns: [],
        sampleRows: {
          head: [{ name: "A", score: "1" }],
          tail: [{ name: "B", score: "2" }],
        },
      };
    },
    ...overrides,
  };
  return deps;
}

function baseInput(deps, overrides = {}) {
  return {
    text: "hello",
    mentions: [],
    files: [],
    runSessionKey: "/repo:1",
    runWorkspace: "/repo",
    preferredLanguage: "zh",
    markUserContextItemFailed: deps.markUserContextItemFailed.bind(deps),
    ingestAttachmentFile: deps.ingestAttachmentFile.bind(deps),
    readFile: deps.readFile.bind(deps),
    readDocument: deps.readDocument.bind(deps),
    analyzeTabularDocument: deps.analyzeTabularDocument.bind(deps),
    ...overrides,
  };
}

test("submit attachment context keeps plain text when no supplemental files exist", async () => {
  const deps = createDeps();

  const result = await buildSubmitAttachmentContext(baseInput(deps));

  assert.equal(result.userContent, "hello");
  assert.deepEqual(result.attachmentRefs, []);
  assert.equal(result.failedAttachmentCount, 0);
  assert.deepEqual(deps.calls.readFiles, []);
});

test("submit attachment context adds mentioned files and dedupes readable attachment refs", async () => {
  const deps = createDeps();

  const result = await buildSubmitAttachmentContext(baseInput(deps, {
    preferredLanguage: "en",
    mentions: ["src/App.tsx"],
    files: [
      {
        id: "app",
        path: "src/App.tsx",
        sourcePath: "src/App.tsx",
        displayName: "App.tsx",
        kind: "text",
        workspace: "/repo",
        readable: true,
      },
    ],
  }));

  assert.equal(result.attachmentRefs.length, 1);
  assert.match(result.userContent, /\[user_mentioned_files\]/);
  assert.match(result.userContent, /path: src\/App\.tsx/);
  assert.match(result.userContent, /\[attached_file\]/);
  assert.equal(deps.calls.readFiles.length, 1);
  assert.deepEqual(deps.calls.ingested, []);
});

test("submit attachment context formats tabular attachments through analyzer previews", async () => {
  const deps = createDeps();

  const result = await buildSubmitAttachmentContext(baseInput(deps, {
    files: [
      {
        id: "data",
        path: "data/report.csv",
        sourcePath: "data/report.csv",
        displayName: "report.csv",
        kind: "tabular",
        workspace: "/repo",
        readable: true,
      },
    ],
  }));

  assert.match(result.userContent, /\[attached_tabular_file\]/);
  assert.match(result.userContent, /sourceName: report\.csv/);
  assert.match(result.userContent, /"rowCount": 2/);
  assert.equal(deps.calls.analyzed.length, 1);
  assert.equal(deps.calls.readDocuments.length, 1);
  assert.deepEqual(deps.calls.readFiles, []);
});

test("submit attachment context marks failed document reads", async () => {
  const deps = createDeps({
    async readDocument() {
      throw new Error("offline");
    },
  });

  const result = await buildSubmitAttachmentContext(baseInput(deps, {
    files: [
      {
        id: "doc",
        path: "docs/brief.pdf",
        sourcePath: "/outside/brief.pdf",
        displayName: "brief.pdf",
        kind: "document",
        workspace: "/repo",
        readable: true,
      },
    ],
  }));

  assert.match(result.userContent, /\[无法读取文件：brief\.pdf\]/);
  assert.deepEqual(deps.calls.failed, ["/outside/brief.pdf", "docs/brief.pdf"]);
});

test("submit attachment context extension routing matches document and tabular sets", () => {
  assert.equal(shouldUseDocumentReader("brief.PDF"), true);
  assert.equal(shouldUseDocumentReader("notes.md"), false);
  assert.equal(shouldUseTabularAnalyzer("sheet.XLSX"), true);
  assert.equal(shouldUseTabularAnalyzer("brief.pdf"), false);
});
