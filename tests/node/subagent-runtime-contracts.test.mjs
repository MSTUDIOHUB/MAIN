import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
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

const subagents = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagents.ts"),
);
const subagentRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagentRuntime.ts"),
);
const toolCallPlanning = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"),
);
const toolCallPartitioning = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"),
);
const toolActivityTracking = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolActivityTracking.ts"),
);

function tool(name, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties, required },
    },
  };
}

function exactFileScope(overrides = {}) {
  return {
    subagentId: "subagent-exact",
    parentSessionKey: "thread-parent",
    scopeKey: "exact-front-end-files",
    workspace: "/workspace",
    allowedPaths: ["src/main.js", "src/components/editor.js"],
    allowedFilePaths: ["src/main.js", "src/components/editor.js"],
    allowedDirectoryPaths: [],
    scopeKind: "exact_files",
    blockedToolNames: [],
    ...overrides,
  };
}

test("subagent scope path resolution keeps exact files separate from directories", async () => {
  const resolved = await subagentRuntime.resolveSubagentExecutionScopePaths({
    allowedPaths: ["src/main.js", "src/components"],
    workspace: "/workspace",
  });
  assert.deepEqual(resolved.allowedFilePaths, ["src/main.js"]);
  assert.deepEqual(resolved.allowedDirectoryPaths, ["src/components"]);
  assert.equal(resolved.scopeKind, "directory_or_mixed");
});

test("path coverage audit requires every leased root and lets a successful retry resolve failure", () => {
  const partial = subagents.resolveSubagentPathCoverage({
    requiredPaths: ["src/main.js", "src/components/editor.js"],
    observedPaths: ["src/main.js"],
    failedPaths: ["src/components/editor.js"],
  });
  assert.deepEqual(partial, {
    requiredPaths: ["src/main.js", "src/components/editor.js"],
    coveredPaths: ["src/main.js"],
    failedPaths: ["src/components/editor.js"],
    uncoveredPaths: ["src/components/editor.js"],
  });

  const retried = subagents.resolveSubagentPathCoverage({
    requiredPaths: ["src/main.js", "src/components/editor.js"],
    observedPaths: ["src/main.js", "src/components/editor.js"],
    failedPaths: ["src/components/editor.js"],
  });
  assert.deepEqual(retried.failedPaths, []);
  assert.deepEqual(retried.uncoveredPaths, []);
  assert.deepEqual(retried.coveredPaths, retried.requiredPaths);
});

test("exact-file subagent scope exposes only executable search parameters", () => {
  const scope = exactFileScope();
  const tools = [
    tool("read_file", { path: { type: "string" } }, ["path"]),
    tool("grep_search", {
      query: { type: "string" },
      path: { type: "string", description: "defaults to ." },
    }, ["query"]),
    tool("find_symbol_references", {
      symbol: { type: "string" },
      path: { type: "string" },
    }, ["symbol"]),
    tool("git_diff", { path: { type: "string" } }),
    tool("list_directory", { path: { type: "string" } }, ["path"]),
    tool("glob_search", { pattern: { type: "string" } }, ["pattern"]),
    tool("get_project_skeleton"),
    tool("repo_map_search", { query: { type: "string" } }, ["query"]),
  ];

  const scoped = toolCallPlanning.scopeSubagentToolDefinitions({ tools, scope });
  const names = scoped.map((entry) => entry.function.name);
  assert.deepEqual(names, ["read_file", "grep_search", "find_symbol_references", "git_diff"]);

  for (const name of ["read_file", "grep_search", "find_symbol_references", "git_diff"]) {
    const definition = scoped.find((entry) => entry.function.name === name);
    assert.deepEqual(definition.function.parameters.properties.path.enum, scope.allowedPaths);
    assert.ok(definition.function.parameters.required.includes("path"));
  }
  assert.equal(subagents.validateSubagentScopeTarget(scope, "src/main.js"), true);
  assert.equal(subagents.validateSubagentScopeTarget(scope, "."), false);
  assert.equal(subagents.validateSubagentScopeTarget(scope, "src"), false);
});

test("the first exact-file scope block quarantines that tool for later iterations", () => {
  const scope = exactFileScope();
  const grep = tool("grep_search", {
    query: { type: "string" },
    path: { type: "string" },
  }, ["query"]);

  assert.equal(subagents.recordSubagentScopeBlockedTool(scope, "grep_search"), true);
  assert.equal(subagents.recordSubagentScopeBlockedTool(scope, "grep_search"), false);
  assert.deepEqual(scope.blockedToolNames, ["grep_search"]);
  assert.deepEqual(
    toolCallPlanning.scopeSubagentToolDefinitions({ tools: [grep], scope }),
    [],
  );
});

test("a scheduling reservation immediately defers overlapping parent and child scopes", () => {
  subagents.resetSubagentRuntimeForTests();
  subagents.reserveSubagentScope({
    threadId: "thread-parent",
    parentTurnId: "turn-parent",
    subagentId: "subagent-reserved",
    scopeKey: "main-file",
    workspace: "/workspace",
    allowedPaths: ["src/main.js"],
    createdAt: Date.now(),
  });

  const parentConflict = subagents.findSubagentScopeConflict({
    threadId: "thread-parent",
    targetPath: "src/main.js",
  });
  assert.equal(parentConflict?.subagentId, "subagent-reserved");

  const overlappingChild = subagents.findSubagentLeaseOverlap({
    threadId: "thread-parent",
    workspace: "/workspace",
    allowedPaths: ["src"],
  });
  assert.equal(overlappingChild?.subagentId, "subagent-reserved");
  subagents.resetSubagentRuntimeForTests();
});

test("delegated read provenance carries content hash into the parent ledger", () => {
  const promoted = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "wait-child",
    name: "wait_subagents",
    target: "subagent-evidence",
    isError: false,
    content: JSON.stringify({
      pendingIds: [],
      results: [{
        subagentId: "subagent-evidence",
        name: "Evidence",
        scopeKey: "main",
        status: "completed",
        summary: "hypothesis",
        summaryTrust: "unverified_hypothesis",
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "versioned source",
          provenance: {
            source: "tool_observation",
            owner: { agentKind: "subagent", subagentId: "subagent-evidence" },
            sourceToolCallId: "child-read-main",
            sourceObservation: {
              key: "read-main::version=120:2::content=abc",
              versionToken: "120:2",
              contentHash: "abc",
            },
            sourceVersion: "120:2",
            sourceContentHash: "abc",
            sourceContentChars: 17,
            sourceRange: { startLine: 1, endLine: 20, totalLines: 40, truncated: true },
          },
        }],
      }],
    }),
  });

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].delegatedObservation.sourceToolCallId, "child-read-main");
  assert.equal(promoted[0].delegatedObservation.sourceVersion, "120:2");
  assert.equal(promoted[0].delegatedObservation.sourceContentHash, "abc");
  assert.equal(promoted[0].delegatedObservation.sourceContentChars, 17);
});

test("incomplete child closure creates exact parent reread obligations without promoting partial evidence", () => {
  const waitResult = {
    toolCallId: "wait-degraded",
    name: "wait_subagents",
    target: "child-degraded",
    isError: false,
    content: JSON.stringify({
      pendingIds: [],
      results: [{
        subagentId: "child-degraded",
        status: "degraded",
        closureAudit: {
          state: "partial",
          requiredPaths: ["src/a.ts", "src/b.ts"],
          coveredPaths: [],
          failedPaths: ["src/a.ts", "outside.ts"],
          uncoveredPaths: ["src/a.ts", "src/b.ts"],
        },
        evidence: [],
      }],
    }),
  };

  assert.deepEqual(toolActivityTracking.extractDelegatedSubagentActivities(waitResult), []);
  const obligations = toolActivityTracking.extractSubagentParentRereadObligations(waitResult);
  assert.deepEqual(obligations.map((item) => item.target), ["src/a.ts", "src/b.ts"]);
  assert.ok(obligations.every((item) => item.status === "failed"));
  assert.ok(obligations.every((item) => item.delegatedObservation.requiresParentReread === true));
  assert.ok(obligations.every((item) => !item.delegatedObservation.sourceToolCallId));
});

test("structured child closure and observation quality gate parent join promotion", () => {
  const promoted = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "wait-child-closure",
    name: "wait_subagents",
    target: "subagent-evidence",
    isError: false,
    content: JSON.stringify({
      pendingIds: [],
      results: [{
        subagentId: "subagent-evidence",
        status: "completed",
        closureAudit: {
          state: "satisfied",
          observationCount: 2,
          substantiveEvidenceCount: 1,
          acceptedEvidenceToolCallIds: ["child-read-main"],
          reason: "The requested source was inspected.",
        },
        evidence: [{
          tool: "get_file_outline",
          target: "src/main.js",
          detail: "No symbols found.",
          observation: {
            kind: "structure",
            sourcePath: "src/main.js",
            contentChars: 17,
            negative: true,
            substantive: false,
          },
          provenance: {
            source: "tool_observation",
            owner: { agentKind: "subagent", subagentId: "subagent-evidence" },
            sourceToolCallId: "child-outline-main",
          },
        }, {
          tool: "read_file",
          target: "src/main.js",
          detail: "versioned source",
          observation: {
            kind: "source",
            sourcePath: "src/main.js",
            contentChars: 17,
            negative: false,
            substantive: true,
          },
          provenance: {
            source: "tool_observation",
            owner: { agentKind: "subagent", subagentId: "subagent-evidence" },
            sourceToolCallId: "child-read-main",
          },
        }],
      }],
    }),
  });

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].name, "read_file");
  assert.equal(promoted[0].delegatedObservation.sourceToolCallId, "child-read-main");

  const rejected = toolActivityTracking.extractDelegatedSubagentActivities({
    toolCallId: "wait-child-inconsistent",
    name: "wait_subagents",
    target: "subagent-evidence",
    isError: false,
    content: JSON.stringify({
      pendingIds: [],
      results: [{
        subagentId: "subagent-evidence",
        status: "completed",
        closureAudit: {
          state: "blocked",
          observationCount: 1,
          substantiveEvidenceCount: 1,
          acceptedEvidenceToolCallIds: ["child-read-main"],
          reason: "The requested task was not closed.",
        },
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "versioned source",
          observation: {
            kind: "source",
            sourcePath: "src/main.js",
            contentChars: 17,
            negative: false,
            substantive: true,
          },
          provenance: {
            source: "tool_observation",
            owner: { agentKind: "subagent", subagentId: "subagent-evidence" },
            sourceToolCallId: "child-read-main",
          },
        }],
      }],
    }),
  });

  assert.deepEqual(rejected, []);
});

test("only current versioned child evidence can back a self-verifying mutation", () => {
  const activity = {
    name: "read_file",
    target: "src/main.js",
    status: "succeeded",
    delegatedObservation: {
      owner: { agentKind: "subagent", subagentId: "subagent-evidence" },
      sourceToolCallId: "child-read-main",
      sourceObservationKey: "read-main::version=120:2::content=abc",
      sourceVersion: "120:2",
      sourceContentHash: "abc",
      sourceContentChars: 16,
      sourceRange: { startLine: 1, endLine: 20, totalLines: 40, truncated: true },
      parentContextState: "reference_only",
      requiresParentReread: true,
    },
  };

  assert.deepEqual(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "replace_in_file",
    mutationArgs: { search_text: "old exact source", replace_text: "new exact source" },
    currentVersion: "120:2",
    currentContentHash: "abc",
    currentSourceContent: "old exact source",
  }), { reusable: true, reason: "versioned_exact_mutation" });

  assert.equal(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "apply_patch",
    mutationArgs: { patch: "*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch" },
    currentVersion: "121:3",
    currentContentHash: "abc",
    currentSourceContent: "old exact source",
  }).reason, "source_version_changed");

  assert.equal(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "apply_patch",
    mutationArgs: { patch: "*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch" },
    currentVersion: "120:2",
    currentContentHash: "abc",
    currentSourceContent: "old exact source",
  }).reason, "insufficient_source_coverage");

  assert.equal(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "replace_in_file",
    mutationArgs: { search_text: "old exact source", replace_text: "new exact source" },
    currentVersion: "120:2",
    currentContentHash: "changed-hash",
    currentSourceContent: "changed source txt",
  }).reason, "source_content_changed", "same size:mtime cannot hide changed source content");

  assert.equal(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "write_file",
    mutationArgs: { content: "whole file" },
    currentVersion: "120:2",
    currentContentHash: "abc",
    currentSourceContent: "old exact source",
  }).reason, "mutation_not_self_verifying");

  assert.equal(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "apply_patch",
    mutationArgs: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/main.js",
        "@@",
        "-old",
        "+new",
        "*** Delete File: src/legacy.js",
        "*** End Patch",
      ].join("\n"),
    },
    currentVersion: "120:2",
    currentContentHash: "abc",
    currentSourceContent: "old exact source",
  }).reason, "mutation_not_self_verifying", "mixed Update+Delete cannot reuse child-only evidence");

  assert.equal(toolCallPartitioning.resolveVersionedDelegatedObservationReuse({
    activity,
    mutationToolName: "apply_patch",
    mutationArgs: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/main.js",
        "@@",
        "-old",
        "+new",
        "*** Update File: src/other.js",
        "@@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n"),
    },
    currentVersion: "120:2",
    currentContentHash: "abc",
    currentSourceContent: "old exact source",
  }).reason, "mutation_not_self_verifying", "multi-target apply_patch requires a parent reread");
});
