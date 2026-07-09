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
  createSubmitSessionRuntimeFacade,
  startSubmitElapsedTimer,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRuntimeFacade.ts"),
);

const runtimeKeys = ["currentTurnId", "agentStatus", "elapsedTime", "taskFlow"];

function createRuntimeFromState(state) {
  return {
    currentTurnId: state.currentTurnId ?? null,
    agentStatus: state.agentStatus || "idle",
    elapsedTime: state.elapsedTime ?? 0,
    taskFlow: Array.isArray(state.taskFlow) ? state.taskFlow : [],
  };
}

function pickRuntimePatch(source) {
  const patch = {};
  for (const key of runtimeKeys) {
    if (Object.hasOwn(source, key)) patch[key] = source[key];
  }
  return patch;
}

function applySet(stateRef, patchOrUpdater) {
  const patch = typeof patchOrUpdater === "function"
    ? patchOrUpdater(stateRef.current)
    : patchOrUpdater;
  stateRef.current = { ...stateRef.current, ...patch };
}

test("submit session runtime facade writes active runs to top-level state and runtime snapshot", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/app",
      currentSessionId: 42,
      runtimeBySessionKey: {},
      currentTurnId: "turn-ui",
      agentStatus: "idle",
      elapsedTime: 0,
      taskFlow: [],
      globalOnly: "before",
    },
  };

  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/app:42",
    createRuntimeFromState,
    pickRuntimePatch,
  });

  facade.seedSessionRuntime();
  facade.sessionSet({
    agentStatus: "running",
    elapsedTime: 3,
    globalOnly: "after",
  });

  assert.equal(stateRef.current.agentStatus, "running");
  assert.equal(stateRef.current.elapsedTime, 3);
  assert.equal(stateRef.current.globalOnly, "after");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/app:42"].agentStatus, "running");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/app:42"].elapsedTime, 3);
  assert.equal(Object.hasOwn(stateRef.current.runtimeBySessionKey["/tmp/app:42"], "globalOnly"), false);
});

test("submit session runtime facade writes background runs only to their runtime snapshot", () => {
  const stateRef = {
    current: {
      currentWorkspace: "/tmp/ui",
      currentSessionId: 7,
      runtimeBySessionKey: {
        "/tmp/run:42": {
          currentTurnId: "turn-run",
          agentStatus: "running",
          elapsedTime: 5,
          taskFlow: [{ id: 1 }],
        },
      },
      currentTurnId: "turn-ui",
      agentStatus: "idle",
      elapsedTime: 0,
      taskFlow: [],
      globalOnly: "ui",
    },
  };

  const facade = createSubmitSessionRuntimeFacade({
    get: () => stateRef.current,
    set: (patchOrUpdater) => applySet(stateRef, patchOrUpdater),
    runSessionKey: "/tmp/run:42",
    createRuntimeFromState,
    pickRuntimePatch,
    decorateScopedState: (state) => ({ ...state, decorated: true }),
  });

  facade.sessionSet((scoped) => {
    assert.equal(scoped.currentTurnId, "turn-run");
    assert.equal(scoped.elapsedTime, 5);
    return {
      agentStatus: "pending_review",
      elapsedTime: scoped.elapsedTime + 1,
      globalOnly: "should-not-touch-ui",
    };
  });

  assert.equal(stateRef.current.currentTurnId, "turn-ui");
  assert.equal(stateRef.current.agentStatus, "idle");
  assert.equal(stateRef.current.elapsedTime, 0);
  assert.equal(stateRef.current.globalOnly, "ui");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].agentStatus, "pending_review");
  assert.equal(stateRef.current.runtimeBySessionKey["/tmp/run:42"].elapsedTime, 6);

  const scoped = facade.sessionGet();
  assert.equal(scoped.currentTurnId, "turn-run");
  assert.equal(scoped.decorated, true);
});

test("submit elapsed timer updates active elapsed time and clears itself when run ends", () => {
  let now = 1000;
  let agentStatus = "running";
  const patches = [];
  const callbacks = [];
  const cleared = [];

  const timer = startSubmitElapsedTimer({
    sessionGet: () => ({ agentStatus }),
    sessionSet: (patch) => patches.push(patch),
    nowMs: () => now,
    setTimer: (callback, ms) => {
      assert.equal(ms, 1000);
      callbacks.push(callback);
      return "timer-1";
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  assert.equal(timer.timerInterval, "timer-1");
  now = 2600;
  callbacks[0]();
  assert.deepEqual(patches, [{ elapsedTime: 2 }]);

  agentStatus = "idle";
  callbacks[0]();
  assert.deepEqual(cleared, ["timer-1"]);
  assert.equal(timer.getElapsedSeconds(), 2);
});
