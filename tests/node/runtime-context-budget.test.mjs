import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
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

const budget = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtimeContextBudget.ts",
));
const providerSettings = loadTs(path.join(
  workspaceRoot,
  "src/lib/providerLaneSettings.ts",
));
const executionText = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionText.ts",
));
const submissionContext = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/submissionContext.ts",
));
const providerRequest = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderRequest.ts",
));

const GIB = 1024 ** 3;

test("provider model metadata and loaded status define a real local capability", () => {
  const capability = budget.parseOpenAiLocalModelCapability({
    model: "Qwen3.6-35B-A3B-6bit",
    modelsPayload: {
      data: [{
        id: "Qwen3.6-35B-A3B-6bit",
        max_model_len: 262_144,
      }],
    },
    statusPayload: {
      models: [{
        id: "Qwen3.6-35B-A3B-6bit",
        loaded: true,
        is_loading: false,
      }],
    },
  });

  assert.deepEqual(capability, {
    providerContextLimit: 262_144,
    loaded: true,
  });
});

test("healthy memory can expand a loaded model above the configured fallback without exceeding provider capacity", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 32_768,
    providerContextLimit: 262_144,
    modelLoaded: true,
    availableMemoryBytes: 12 * GIB,
  });

  assert.ok(resolved.contextLimit > 32_768);
  assert.ok(resolved.contextLimit <= 262_144);
  assert.ok(resolved.inputBudget > 32_768);
  assert.ok(resolved.outputBudget > 8_192);
  assert.ok(resolved.readWindowChars > 32_000);
  assert.equal(resolved.source, "provider_and_memory");
});

test("unknown model capacity never guesses a larger context than configured", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 32_768,
    providerContextLimit: null,
    modelLoaded: null,
    availableMemoryBytes: 24 * GIB,
    reservedOutputTokens: 8_192,
  });

  assert.equal(resolved.contextLimit, 32_768);
  assert.equal(resolved.source, "configured");
});

test("memory pressure can lower the effective budget but never below the runtime minimum", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 131_072,
    providerContextLimit: 262_144,
    modelLoaded: true,
    availableMemoryBytes: 900 * 1024 ** 2,
    reservedOutputTokens: 4_096,
  });

  assert.equal(resolved.contextLimit, 4_096);
  assert.equal(resolved.inputBudget, 0);
  assert.equal(resolved.readWindowChars, 4_000);
});

test("runtime budget resolver uses authenticated provider facts and current memory once", async () => {
  const requested = [];
  const resolved = await budget.resolveRuntimeContextBudget({
    activeProfile: "local",
    local: {
      provider: "OMLX",
      endpoint: "http://127.0.0.1:8000/v1",
      model: "Qwen3.6-35B-A3B-6bit",
      apiKey: "secret-not-logged",
      contextLimit: 32_768,
      toolProtocol: "auto",
    },
  }, {
    getSystemMemory: async () => ({
      total_gb: 64,
      available_gb: 12,
      total_bytes: 64 * GIB,
      available_bytes: 12 * GIB,
    }),
    requestJson: async (url, headers) => {
      requested.push({
        url,
        authorizationPresent: Boolean(headers.authorization),
      });
      if (url.endsWith("/models/status")) {
        return {
          models: [{
            id: "Qwen3.6-35B-A3B-6bit",
            loaded: true,
            is_loading: false,
          }],
        };
      }
      return {
        data: [{
          id: "Qwen3.6-35B-A3B-6bit",
          max_model_len: 262_144,
        }],
      };
    },
  });

  assert.ok(resolved.contextLimit > 32_768);
  assert.deepEqual(
    requested.map((entry) => entry.url),
    [
      "http://127.0.0.1:8000/v1/models",
      "http://127.0.0.1:8000/v1/models/status",
    ],
  );
  assert.ok(requested.every((entry) => entry.authorizationPresent));
});

test("cloud Runs keep provider-managed context and do not probe local capacity", async () => {
  let probes = 0;
  const resolved = await budget.resolveRuntimeContextBudget({
    activeProfile: "cloud",
    local: {
      endpoint: "http://127.0.0.1:8000/v1",
      model: "local-model",
      contextLimit: 32_768,
    },
  }, {
    getSystemMemory: async () => {
      probes += 1;
      throw new Error("must not be called");
    },
    requestJson: async () => {
      probes += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(resolved, null);
  assert.equal(probes, 0);
});

test("missing local endpoint or model uses configured fallback without probes", async () => {
  let probes = 0;
  const resolved = await budget.resolveRuntimeContextBudget({
    activeProfile: "local",
    local: {
      endpoint: "",
      model: "",
      contextLimit: 24_576,
    },
  }, {
    getSystemMemory: async () => {
      probes += 1;
      throw new Error("must not be called");
    },
    requestJson: async () => {
      probes += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(resolved.contextLimit, 24_576);
  assert.equal(resolved.source, "configured");
  assert.equal(probes, 0);
});

test("one resolved Run budget drives provider settings and read_file windows", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 32_768,
    providerContextLimit: 262_144,
    modelLoaded: true,
    availableMemoryBytes: 12 * GIB,
    reservedOutputTokens: 8_192,
  });
  const config = {
    activeProfile: "local",
    local: {
      provider: "OMLX",
      endpoint: "http://127.0.0.1:8000/v1",
      model: "Qwen3.6-35B-A3B-6bit",
      apiKey: "",
      contextLimit: 32_768,
      toolProtocol: "auto",
    },
  };
  const settings = providerSettings.deriveBudgetedStreamSettings(
    config,
    resolved,
  );
  const args = executionText.runtimeV2ContextBoundToolArguments(
    "read_file",
    { path: "src/main.js" },
    resolved,
  );
  const explicitSmaller = executionText.runtimeV2ContextBoundToolArguments(
    "read_file",
    { path: "src/main.js", max_chars: 12_000 },
    resolved,
  );

  assert.equal(settings.contextLimit, resolved.contextLimit);
  assert.equal(args.max_chars, resolved.readWindowChars);
  assert.equal(explicitSmaller.max_chars, 12_000);
  assert.ok(args.max_chars > 32_000);
});

test("Runtime v2 preserves a complete admitted read window instead of truncating it again", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 32_768,
    providerContextLimit: 262_144,
    modelLoaded: true,
    availableMemoryBytes: 12 * GIB,
  });
  const content = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "truncated: false",
    "---CONTENT START---",
    "x".repeat(48_000),
    "---CONTENT END---",
  ].join("\n");

  const retained = executionText.boundedRuntimeV2ToolContent(
    "read_file",
    content,
    resolved,
  );

  assert.equal(retained, content);
  assert.doesNotMatch(retained, /Runtime v2 truncated/);
});

test("native Runtime v2 responses use the Run output budget while text envelopes stay compact", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 32_768,
    providerContextLimit: 262_144,
    modelLoaded: true,
    availableMemoryBytes: 12 * GIB,
  });
  const command = {
    payload: {
      toolExpectation: "required",
    },
  };

  assert.equal(
    providerRequest.runtimeV2ExecutionProviderOutputTokenLimit(
      command,
      false,
      resolved,
    ),
    resolved.outputBudget,
  );
  assert.equal(
    providerRequest.runtimeV2ExecutionProviderOutputTokenLimit(
      command,
      true,
      resolved,
    ),
    4_096,
  );
});

test("Run admission attaches one immutable budget object to the submission context", () => {
  const resolved = budget.computeRuntimeContextBudget({
    configuredContextLimit: 32_768,
    providerContextLimit: 262_144,
    modelLoaded: true,
    availableMemoryBytes: 12 * GIB,
  });
  const original = {
    turnId: "turn-1",
    runtimeContextBudget: null,
  };
  const attached = submissionContext.withRuntimeV2ContextBudget(
    original,
    resolved,
  );

  assert.notEqual(attached, original);
  assert.equal(attached.runtimeContextBudget, resolved);
  assert.equal(original.runtimeContextBudget, null);
});

test("pressure compaction never drops a trailing phase authority instruction", () => {
  const messages = [
    { role: "system", content: "root authority" },
    { role: "user", content: "fix the complete objective" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "read-1",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/main.js" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "read-1",
      content: "x".repeat(80_000),
    },
    {
      role: "system",
      content: "submit the evidence-backed result now",
    },
  ];
  const bounded = budget.boundRuntimeMessagesToContext(messages, {
    contextLimit: 8_192,
    reservedOutputTokens: 4_096,
  });

  assert.equal(
    bounded.at(-1).content,
    "submit the evidence-backed result now",
  );
  assert.ok(bounded.some((message) =>
    message.role === "user" &&
    message.content === "fix the complete objective"
  ));
});
