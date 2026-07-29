import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(fs.readFileSync(normalized, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  cache.set(normalized, module.exports);
  return module.exports;
}

const surface = loadTs(path.join(
  process.cwd(),
  "src/store/runtimeV2/providerToolSurface.ts",
));

const definition = (name) => ({ function: { name } });
const call = (name) => ({ id: `call-${name}`, name, arguments: {} });

test("provider results cannot widen the current Runtime v2 phase tool surface", () => {
  assert.deepEqual(
    surface.unexpectedRuntimeV2ProviderToolNames(
      [definition("apply_patch"), definition("replace_in_file")],
      [call("apply_patch")],
    ),
    [],
  );
  assert.deepEqual(
    surface.unexpectedRuntimeV2ProviderToolNames(
      [definition("apply_patch")],
      [call("read_file"), call("read_file"), call("run_command")],
    ),
    ["read_file", "run_command"],
  );
  assert.deepEqual(
    surface.unexpectedRuntimeV2ProviderToolNames([], [call("read_file")]),
    ["read_file"],
  );
});

test("provider tool batches execute one action before Runtime v2 decides again", () => {
  const bounded = surface.boundRuntimeV2ProviderToolCalls([
    call("read_file"),
    call("replace_in_file"),
    call("run_command"),
  ]);
  assert.deepEqual(bounded.accepted.map((item) => item.name), ["read_file"]);
  assert.deepEqual(
    bounded.discarded.map((item) => item.name),
    ["replace_in_file", "run_command"],
  );
  assert.equal(bounded.selection, "first");
});

test("provider tool batches skip a regenerated stale head for the first novel action", () => {
  const repeated = {
    id: "read-again",
    name: "read_file",
    arguments: { path: "src/main.js" },
  };
  const contract = {
    id: "contract",
    name: "submit_execution_contract",
    arguments: { targets: [{ path: "src/main.js", operation: "modify" }] },
  };
  const bounded = surface.boundRuntimeV2ProviderToolCalls(
    [repeated, contract],
    new Set([surface.runtimeV2ProviderToolCallIdentity(repeated)]),
  );
  assert.deepEqual(
    bounded.accepted.map((item) => item.name),
    ["submit_execution_contract"],
  );
  assert.deepEqual(
    bounded.discarded.map((item) => item.name),
    ["read_file"],
  );
  assert.equal(bounded.selection, "first_novel_after_attempt");
});

test("an exact action rejected by the runtime cannot re-enter the scheduler", () => {
  const rejected = {
    id: "read-rejected-again",
    name: "read_file",
    arguments: {
      path: "src/main.js",
      start_line: 1001,
    },
  };
  const rejectedIdentity =
    surface.runtimeV2ProviderToolCallIdentity(rejected);

  const blockedOnly = surface.boundRuntimeV2ProviderToolCalls(
    [rejected],
    new Set([rejectedIdentity]),
    new Set([rejectedIdentity]),
  );
  assert.deepEqual(blockedOnly.accepted, []);
  assert.deepEqual(blockedOnly.discarded, [rejected]);
  assert.equal(blockedOnly.selection, "all_rejected");

  const differentRange = {
    id: "read-different-range",
    name: "read_file",
    arguments: {
      path: "src/main.js",
      start_line: 260,
      end_line: 340,
    },
  };
  const withNovelSibling = surface.boundRuntimeV2ProviderToolCalls(
    [rejected, differentRange],
    new Set([rejectedIdentity]),
    new Set([rejectedIdentity]),
  );
  assert.deepEqual(withNovelSibling.accepted, [differentRange]);
  assert.deepEqual(withNovelSibling.discarded, [rejected]);
  assert.equal(
    withNovelSibling.selection,
    "first_novel_after_rejection",
  );
});

test("completed provider transcript pairs define attempted semantic actions", () => {
  const attempted =
    surface.completedRuntimeV2ProviderToolCallIdentities([{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "read-complete",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            start_line: 180,
            end_line: 250,
          }),
        },
      }, {
        id: "read-orphan",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/never-executed.js" }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "read-complete",
      content: "READ_FILE_RESULT",
    }]);

  assert.deepEqual([...attempted], [
    surface.runtimeV2ProviderToolCallIdentity({
      name: "read_file",
      arguments: {
        path: "src/main.js",
        start_line: 180,
        end_line: 250,
      },
    }),
  ]);
});

test("provider-local tool ids are scoped uniquely for every runtime response", () => {
  const allocated = ["runtime-call-1", "runtime-call-2"];
  const scoped = surface.scopeRuntimeV2ProviderToolCallIds([
    {
      id: "stream_call_1",
      name: "read_file",
      arguments: { path: "src/main.js" },
    },
    {
      id: "stream_call_2",
      name: "grep_search",
      arguments: { query: "handleSaveFile" },
    },
  ], () => allocated.shift());

  assert.deepEqual(scoped.map((item) => item.id), [
    "runtime-call-1",
    "runtime-call-2",
  ]);
  assert.deepEqual(scoped.map((item) => item.name), [
    "read_file",
    "grep_search",
  ]);
});

test("same-version transcript coverage rejects overlapping read windows but resets after mutation", () => {
  const firstRead = {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "main-1",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  };
  const firstResult = {
    role: "tool",
    tool_call_id: "main-1",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: sha-main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 1-1000",
      "returnedChars: 30000",
      "nextStartLine: 1001",
      "---CONTENT START---",
      "source",
      "---CONTENT END---",
    ].join("\n"),
  };
  const secondRead = {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "main-2",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 1001,
        }),
      },
    }],
  };
  const secondResult = {
    role: "tool",
    tool_call_id: "main-2",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: sha-main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 1001-1110",
      "returnedChars: 3519",
      "---CONTENT START---",
      "source",
      "---CONTENT END---",
    ].join("\n"),
  };
  const candidate = {
    id: "main-overlap",
    name: "read_file",
    arguments: {
      path: "src/main.js",
      start_line: 200,
      end_line: 350,
    },
  };
  const coveredTranscript = [
    firstRead,
    firstResult,
    secondRead,
    secondResult,
  ];

  assert.equal(
    surface.runtimeV2ProviderReadIsFullyCovered(
      candidate,
      coveredTranscript,
    ),
    true,
  );
  assert.equal(
    surface.runtimeV2ProviderReadIsFullyCovered({
      ...candidate,
      arguments: { path: "src/other.js" },
    }, coveredTranscript),
    false,
  );

  const afterMutation = [...coveredTranscript, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "patch-main",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({ patch: "fixture" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "patch-main",
    content: "PATCH_APPLIED",
  }];
  assert.equal(
    surface.runtimeV2ProviderReadIsFullyCovered(
      candidate,
      afterMutation,
    ),
    false,
  );
});

test("covered provider reads return a cached focused receipt instead of an indirect rejection", () => {
  const source = Array.from(
    { length: 12 },
    (_value, index) => `line-${index + 1}`,
  ).join("\n");
  const transcript = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-main",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: sha-main-v1",
      "truncated: true",
      "totalLines: 20",
      "totalChars: 151",
      "returnedLines: 1-12",
      `returnedChars: ${source.length}`,
      "nextStartLine: 13",
      "---CONTENT START---",
      source,
      "---CONTENT END---",
    ].join("\n"),
  }];
  const replay = surface.runtimeV2ProviderCoveredReadReceipt({
    id: "focused-read",
    name: "read_file",
    arguments: {
      path: "src/main.js",
      start_line: 4,
      end_line: 6,
    },
  }, transcript);

  assert.match(replay, /contentVersion: sha-main-v1/);
  assert.match(replay, /returnedLines: 4-6/);
  assert.match(replay, /line-4/);
  assert.doesNotMatch(replay, /line-3/);
  assert.doesNotMatch(replay, /line-7/);
});

test("Execute keeps safe reads available beside mutations after source freshness", () => {
  const available = [
    definition("read_file"),
    definition("grep_search"),
    definition("apply_patch"),
    definition("run_command"),
  ];
  const sourceToolNames = new Set(["read_file", "grep_search"]);
  const isMutationToolName = (name) => name === "apply_patch";
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames,
      isMutationToolName,
      requiresFreshSourceReads: true,
      requiresMutation: false,
    }).map((item) => item.function.name),
    ["read_file", "grep_search"],
  );
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames,
      isMutationToolName,
      requiresFreshSourceReads: false,
      requiresMutation: false,
    }).map((item) => item.function.name),
    ["read_file", "grep_search", "apply_patch"],
  );
});

test("Execute keeps safe reads beside leased mutations after its source-gap pass", () => {
  const available = [
    definition("read_file"),
    definition("grep_search"),
    definition("apply_patch"),
    definition("replace_in_file"),
    definition("write_file"),
    definition("run_command"),
  ];
  assert.deepEqual(
    surface.selectRuntimeV2ExecuteToolDefinitions({
      available,
      sourceToolNames: new Set(["read_file", "grep_search"]),
      isMutationToolName: (name) =>
        name === "apply_patch" ||
        name === "replace_in_file" ||
        name === "write_file",
      createOnlyMutationToolNames: new Set(["write_file"]),
      requiresFreshSourceReads: false,
      requiresMutation: true,
    }).map((item) => item.function.name),
    ["read_file", "grep_search", "apply_patch", "replace_in_file"],
  );
});
