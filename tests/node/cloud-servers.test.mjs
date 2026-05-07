import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadCloudServersModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/cloudServers.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const localRequire = createRequire(sourcePath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(sourcePath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!require("node:fs").existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          const nestedSource = require("node:fs").readFileSync(candidate, "utf8");
          const nestedTranspiled = ts.transpileModule(nestedSource, {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2020,
            },
            fileName: candidate,
          }).outputText;
          const nestedModule = { exports: {} };
          const nestedFactory = new Function("exports", "module", "require", nestedTranspiled);
          nestedFactory(nestedModule.exports, nestedModule, runtimeRequire);
          return nestedModule.exports;
        }
      }
    }

    return localRequire(specifier);
  };

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

const {
  DEFAULT_CLOUD_SERVER_ID,
  createDefaultCloudConfig,
  normalizeCloudServerState,
} = await loadCloudServersModule();

test("keeps a fresh default cloud config empty until the user adds a server", () => {
  const state = normalizeCloudServerState({
    cloud: createDefaultCloudConfig(),
  });

  assert.equal(state.cloudServers.length, 0);
  assert.equal(state.activeCloudServerId, "");
  assert.equal(state.cloud.endpoint, "https://api.openai.com/v1");
  assert.equal(state.cloud.model, "");
});

test("normalizes legacy single cloud config into one active server", () => {
  const state = normalizeCloudServerState({
    cloud: {
      provider: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1",
      model: "openrouter/model",
      apiKey: "key",
      apiFormat: "responses",
    },
  });

  assert.equal(state.cloudServers.length, 1);
  assert.equal(state.activeCloudServerId, DEFAULT_CLOUD_SERVER_ID);
  assert.equal(state.cloudServers[0].name, "OpenRouter");
  assert.equal(state.cloud.provider, "OpenRouter");
  assert.equal(state.cloud.endpoint, "https://openrouter.ai/api/v1");
  assert.equal(state.cloud.model, "openrouter/model");
  assert.equal(state.cloud.apiFormat, "responses");
});

test("repairs invalid active server ids and mirrors the selected server to cloud", () => {
  const state = normalizeCloudServerState({
    activeCloudServerId: "missing",
    cloudServers: [
      {
        id: "first",
        name: "First",
        protocol: "openai",
        endpoint: "https://first.example/v1",
        model: "first-model",
      },
      {
        id: "second",
        name: "Second",
        protocol: "openai",
        endpoint: "https://second.example/v1",
        model: "second-model",
      },
    ],
  });

  assert.equal(state.activeCloudServerId, "first");
  assert.equal(state.cloud.endpoint, "https://first.example/v1");
  assert.equal(state.cloud.model, "first-model");
});

test("fills protocol-specific defaults for incomplete server records", () => {
  const state = normalizeCloudServerState({
    activeCloudServerId: "anthropic-a",
    cloudServers: [
      {
        id: "anthropic-a",
        name: "Claude",
        protocol: "anthropic",
      },
    ],
  });

  assert.equal(state.cloudServers[0].provider, "Anthropic");
  assert.equal(state.cloudServers[0].endpoint, "https://api.anthropic.com");
  assert.equal(state.cloudServers[0].apiFormat, "chat_completions");
  assert.equal(state.cloudServers[0].disableResponseStorage, true);
  assert.equal(state.cloudServers[0].reasoningEffort, "none");
  assert.equal(state.cloudServers[0].toolProtocol, "auto");
});
