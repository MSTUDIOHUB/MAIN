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
const providerLane = loadTs(path.join(
  process.cwd(),
  "src/lib/runtime-v2/providerLane.ts",
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

test("provider tool batches preserve every independent side-effect-free read", () => {
  const calls = [{
    id: "read-main",
    name: "read_file",
    arguments: { path: "src/main.js" },
  }, {
    id: "search-save",
    name: "grep_search",
    arguments: { query: "handleSaveFile", path: "src" },
  }, {
    id: "outline-toolbar",
    name: "get_file_outline",
    arguments: { path: "src/components/toolbar.js" },
  }];
  const bounded = surface.boundRuntimeV2ProviderToolCalls(calls);

  assert.deepEqual(bounded.accepted, calls);
  assert.deepEqual(bounded.discarded, []);
  assert.equal(bounded.selection, "safe_batch");
});

test("every cached safe observation can replay without another side effect", () => {
  for (const name of [
    "read_file",
    "grep_search",
    "get_file_outline",
    "repo_map_search",
  ]) {
    assert.equal(
      surface.runtimeV2ProviderCachedReadCanReplay({
        id: `cached-${name}`,
        name,
        arguments: { path: "src", query: "save" },
      }),
      true,
      `${name} must return its cached standard tool result instead of a synthetic rejection`,
    );
  }
  assert.equal(
    surface.runtimeV2ProviderCachedReadCanReplay({
      id: "mutation",
      name: "replace_in_file",
      arguments: { path: "src/main.js" },
    }),
    false,
  );
});

test("provider tool batches preserve novel child schedules up to the current lane capacity", () => {
  const calls = ["editor", "main", "toolbar"].map((task) => ({
    id: `spawn-${task}`,
    name: "spawn_subagent",
    arguments: {
      task_key: `review-${task}`,
      objective: `Review ${task}`,
      required_paths: `src/${task}.js`,
    },
  }));
  const first = surface.boundRuntimeV2ProviderToolCalls(
    calls,
    new Set(),
    new Set(),
    { maxSpawnSubagents: 2 },
  );
  assert.deepEqual(first.accepted, calls.slice(0, 2));
  assert.deepEqual(first.discarded, calls.slice(2));
  assert.equal(first.selection, "collaboration_batch");

  const afterFirstCompleted = surface.boundRuntimeV2ProviderToolCalls(
    calls,
    new Set([
      surface.runtimeV2ProviderToolCallIdentity(calls[0]),
    ]),
    new Set(),
    { maxSpawnSubagents: 2 },
  );
  assert.deepEqual(afterFirstCompleted.accepted, calls.slice(1));
  assert.deepEqual(afterFirstCompleted.discarded, calls.slice(0, 1));
  assert.equal(afterFirstCompleted.selection, "collaboration_batch");
});

test("an already completed safe read is not scheduled again before mutation", () => {
  const read = {
    id: "read-main",
    name: "read_file",
    arguments: { path: "src/main.js", start_line: 260, end_line: 310 },
  };
  const identity = surface.runtimeV2ProviderToolCallIdentity(read);
  const bounded = surface.boundRuntimeV2ProviderToolCalls(
    [read],
    new Set([identity]),
  );

  assert.deepEqual(bounded.accepted, []);
  assert.deepEqual(bounded.discarded, [read]);
  assert.equal(bounded.selection, "all_attempted");
});

test("a novel safe read keeps completed companions in the provider-selected batch", () => {
  const toolbar = {
    id: "read-toolbar-again",
    name: "read_file",
    arguments: { path: "src/components/toolbar.js" },
  };
  const main = {
    id: "read-main-focus",
    name: "read_file",
    arguments: {
      path: "src/main.js",
      start_line: 280,
      end_line: 450,
    },
  };
  const bounded = surface.boundRuntimeV2ProviderToolCalls(
    [toolbar, main],
    new Set([
      surface.runtimeV2ProviderToolCallIdentity(toolbar),
    ]),
  );

  assert.deepEqual(bounded.accepted, [toolbar, main]);
  assert.deepEqual(bounded.discarded, []);
  assert.equal(bounded.selection, "safe_batch");
});

test("only an unproven structured-call capability miss may negotiate another provider transport", () => {
  const nativeUnsupported = new providerLane.RuntimeV2ProviderProtocolError(
    "native_tools_unsupported",
    "unsupported native tools",
  );
  assert.equal(
    providerLane.runtimeV2ProviderProtocolErrorAllowsTransportFallback(
      nativeUnsupported,
    ),
    true,
  );
  assert.equal(
    providerLane.runtimeV2ProviderProtocolErrorAllowsTransportFallback(
      nativeUnsupported,
      { activeTransportProven: true },
    ),
    false,
  );
  const missing = new providerLane.RuntimeV2ProviderProtocolError(
    "required_tool_missing",
    "missing",
  );
  assert.equal(
    providerLane.runtimeV2ProviderProtocolErrorAllowsTransportFallback(
      missing,
    ),
    true,
  );
  assert.equal(
    providerLane.runtimeV2ProviderProtocolErrorAllowsTransportFallback(
      missing,
      { activeTransportProven: true },
    ),
    false,
    "a Run must not renegotiate a transport that already produced structured calls",
  );
  for (const code of [
    "output_truncated",
    "tool_surface_rejected",
    "tool_arguments_rejected",
    "repeated_action_rejected",
  ]) {
    assert.equal(
      providerLane.runtimeV2ProviderProtocolErrorAllowsTransportFallback(
        new providerLane.RuntimeV2ProviderProtocolError(code, code),
      ),
      false,
      `${code} already proves that the active transport expressed an action`,
    );
  }
  assert.equal(
    providerLane.runtimeV2ProviderProtocolErrorAllowsTransportFallback(
      new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT"),
    ),
    false,
    "a stalled provider endpoint is not repaired by changing the tool-call wire format",
  );
});

test("attempt failures remain recoverable without adapter proof that every transport is unavailable", () => {
  const timeout = new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT");
  assert.equal(
    providerLane.runtimeV2ProviderAttemptFailure(timeout),
    timeout,
  );
  assert.equal(
    providerLane.isRuntimeV2ProviderTransportsUnavailableError(
      providerLane.runtimeV2ProviderAttemptFailure(timeout),
    ),
    false,
  );
  for (const rejection of [null, undefined]) {
    const failure =
      providerLane.runtimeV2ProviderAttemptFailure(rejection);
    assert.equal(failure.name, "RuntimeV2ProviderAttemptError");
    assert.equal(
      failure.message,
      "RUNTIME_V2_PROVIDER_ATTEMPT_FAILED_UNKNOWN",
    );
    assert.equal(
      providerLane.isRuntimeV2ProviderTransportsUnavailableError(failure),
      false,
      "a nullish rejection from an attempted request is not capability proof",
    );
  }
});

test("provider tool batches skip a regenerated stale head for the first novel action", () => {
  const repeated = {
    id: "read-again",
    name: "read_file",
    arguments: { path: "src/main.js" },
  };
  const mutation = {
    id: "mutation",
    name: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  };
  const bounded = surface.boundRuntimeV2ProviderToolCalls(
    [repeated, mutation],
    new Set([surface.runtimeV2ProviderToolCallIdentity(repeated)]),
  );
  assert.deepEqual(
    bounded.accepted.map((item) => item.name),
    ["apply_patch"],
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

test("a completed mutation resets earlier read identities at the new source boundary", () => {
  const read = {
    name: "read_file",
    arguments: { path: "src/main.js", start_line: 1, end_line: 80 },
  };
  const attempted =
    surface.completedRuntimeV2ProviderToolCallIdentities([{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "read-before-mutation",
        type: "function",
        function: {
          name: read.name,
          arguments: JSON.stringify(read.arguments),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "read-before-mutation",
      content: "READ_FILE_RESULT",
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "mutation",
        type: "function",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            search_text: "old",
            replace_text: "new",
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "mutation",
      content: "File updated",
    }]);

  assert.equal(
    attempted.has(surface.runtimeV2ProviderToolCallIdentity(read)),
    false,
  );
});

test("a failed mutation does not create a new source boundary", () => {
  const read = {
    id: "read-current-source",
    name: "read_file",
    arguments: { path: "src/main.js" },
  };
  const transcript = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: read.id,
      type: "function",
      function: {
        name: read.name,
        arguments: JSON.stringify(read.arguments),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: read.id,
    content: "const current = true;",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "failed-mutation",
      type: "function",
      function: {
        name: "replace_in_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          search_text: "missing",
          replace_text: "next",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "failed-mutation",
    content: "MUTATION_PREFLIGHT_BLOCKED: search text is not current",
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(),
  };

  assert.equal(
    surface.completedRuntimeV2ProviderToolCallIdentities(
      transcript,
      effects,
    ).has(surface.runtimeV2ProviderToolCallIdentity(read)),
    true,
    "a rejected edit must not make the current source read eligible again",
  );
  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(
      read,
      transcript,
      effects,
    ),
    "const current = true;",
    "a rejected edit must not discard the still-current source receipt",
  );
});

test("a committed mutation invalidates every prior read authority", () => {
  const mainRead = {
    id: "read-main",
    name: "read_file",
    arguments: { path: "src/main.js" },
  };
  const toolbarRead = {
    id: "read-toolbar",
    name: "read_file",
    arguments: { path: "src/components/toolbar.js" },
  };
  const transcript = [{
    role: "assistant",
    content: "",
    tool_calls: [mainRead, toolbarRead].map((entry) => ({
      id: entry.id,
      type: "function",
      function: {
        name: entry.name,
        arguments: JSON.stringify(entry.arguments),
      },
    })),
  }, {
    role: "tool",
    tool_call_id: mainRead.id,
    content: "const main = 'current';",
  }, {
    role: "tool",
    tool_call_id: toolbarRead.id,
    content: "const toolbar = 'current';",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "mutation-main",
      type: "function",
      function: {
        name: "replace_in_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          search_text: "old",
          replace_text: "new",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "mutation-main",
    content: "File updated",
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map([
      ["mutation-main", ["src/main.js"]],
    ]),
    replayedToolCallIds: new Set(),
  };
  const identities =
    surface.completedRuntimeV2ProviderToolCallIdentities(
      transcript,
      effects,
    );

  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(
      mainRead,
      transcript,
      effects,
    ),
    null,
  );
  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(
      toolbarRead,
      transcript,
      effects,
    ),
    null,
  );
  assert.equal(
    identities.has(surface.runtimeV2ProviderToolCallIdentity(mainRead)),
    false,
  );
  assert.equal(
    identities.has(surface.runtimeV2ProviderToolCallIdentity(toolbarRead)),
    false,
  );
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

test("provider action identity changes only with the normalized action", () => {
  const staleMutation = {
    name: "replace_in_file",
    arguments: {
      path: "src/main.js",
      search_text: "old",
      replace_text: "new",
    },
  };
  const identity =
    surface.runtimeV2ProviderToolCallIdentity(staleMutation);

  assert.equal(
    identity,
    surface.runtimeV2ProviderToolCallIdentity(staleMutation),
  );
  assert.match(identity, /^runtime-v2-provider-action-sha256-[0-9a-f]{64}$/);
  assert.notEqual(
    identity,
    surface.runtimeV2ProviderToolCallIdentity({
      ...staleMutation,
      arguments: {
        ...staleMutation.arguments,
        search_text: "current",
      },
    }),
  );
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

test("a durable focused replay closes every covered range until mutation", () => {
  const source = Array.from(
    { length: 12 },
    (_value, index) => `line-${index + 1}`,
  ).join("\n");
  const original = [
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
  ].join("\n");
  const transcript = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-original",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-original",
    content: original,
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-replayed",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 4,
          end_line: 6,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-replayed",
    content: original,
  }];
  const replayEffects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(["read-replayed"]),
  };
  const differentCoveredRange = {
    id: "read-different-covered-range",
    name: "read_file",
    arguments: {
      path: "src/main.js",
      start_line: 7,
      end_line: 9,
    },
  };

  assert.equal(
    surface.runtimeV2ProviderCoveredSourceReplayIsClosed(
      differentCoveredRange,
      transcript,
      replayEffects,
    ),
    true,
    "restore must not grant another replay merely because the range changed",
  );

  const afterMutation = [...transcript, {
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
  const afterMutationEffects = {
    committedMutationTargetsByToolCallId: new Map([
      ["patch-main", ["src/main.js"]],
    ]),
    replayedToolCallIds: new Set(["read-replayed"]),
  };
  assert.equal(
    surface.runtimeV2ProviderCoveredSourceReplayIsClosed(
      differentCoveredRange,
      afterMutation,
      afterMutationEffects,
    ),
    false,
  );
});

test("a replay guard applies only while that exact source range is materialized", () => {
  const toolbarRead = {
    id: "read-toolbar",
    name: "read_file",
    arguments: {
      path: "src/components/toolbar.js",
      start_line: 1,
      end_line: 200,
    },
  };
  const toolbarCoverage = {
    target: "src/components/toolbar.js",
    version: "sha-toolbar-v1",
    totalLines: 240,
    windows: [{
      startLine: 1,
      endLine: 200,
      content: "toolbar source",
    }],
    complete: false,
  };

  assert.equal(
    surface.runtimeV2ProviderReadIsMaterialized(
      toolbarRead,
      [toolbarCoverage],
    ),
    true,
  );
  assert.equal(
    surface.runtimeV2ProviderReadIsMaterialized(
      {
        ...toolbarRead,
        arguments: {
          path: "src/components/toolbar.js",
          start_line: 201,
          end_line: 240,
        },
      },
      [toolbarCoverage],
    ),
    false,
    "an uncovered range remains readable",
  );
  assert.equal(
    surface.runtimeV2ProviderReadIsMaterialized(
      toolbarRead,
      [{
        ...toolbarCoverage,
        target: "src/main.js",
      }],
    ),
    false,
    "archived transcript source is not current model visibility",
  );
});

test("exact small and search receipts remain cacheable only until a mutation opens a new source boundary", () => {
  const read = {
    id: "candidate-read",
    name: "read_file",
    arguments: { path: "src/main.js" },
  };
  const search = {
    id: "candidate-search",
    name: "grep_search",
    arguments: { query: "save", path: "src" },
  };
  const transcript = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "small-read",
      type: "function",
      function: {
        name: read.name,
        arguments: JSON.stringify(read.arguments),
      },
    }, {
      id: "search",
      type: "function",
      function: {
        name: search.name,
        arguments: JSON.stringify(search.arguments),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "small-read",
    content: "const current = true;",
  }, {
    role: "tool",
    tool_call_id: "search",
    content: "src/main.js:10: save();",
  }];

  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(read, transcript),
    "const current = true;",
  );
  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(search, transcript),
    "src/main.js:10: save();",
  );

  const afterRejectedRead = [...transcript, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "rejected-read",
      type: "function",
      function: {
        name: read.name,
        arguments: JSON.stringify(read.arguments),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "rejected-read",
    content:
      "UNCHANGED_SOURCE_COVERAGE_REUSED: reuse the committed source.",
  }];
  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(
      read,
      afterRejectedRead,
    ),
    "const current = true;",
    "a runtime control result must never replace real source as a reusable receipt",
  );

  const afterMutation = [...transcript, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "mutation",
      type: "function",
      function: {
        name: "replace_in_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          search_text: "current",
          replace_text: "next",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "mutation",
    content: "File updated",
  }];
  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(read, afterMutation),
    null,
  );
  assert.equal(
    surface.runtimeV2ProviderReusableReadReceipt(search, afterMutation),
    null,
  );
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
