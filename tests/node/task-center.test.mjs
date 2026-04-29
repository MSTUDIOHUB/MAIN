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
  appendTaskCenterRunLog,
  canStartTaskCenterTask,
  createDefaultTaskCenterState,
  createTaskCenterTask,
  createTaskSourceAdapters,
  finishTaskCenterRun,
  normalizeTaskCenterState,
  pickNextTaskCenterTask,
  startTaskCenterRun,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/taskCenter.ts"));

const {
  MAIN_MODE_KEYS,
  mapLegacyNexusModeToMainMode,
  mapMainModeToLegacyNexusMode,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/mainModes.ts"));

test("mode registry exposes Task Center without breaking legacy MAIN mapping", () => {
  assert.deepEqual(MAIN_MODE_KEYS, ["main_mode", "task_center", "game_studio"]);
  assert.equal(mapLegacyNexusModeToMainMode("task_center"), "task_center");
  assert.equal(mapLegacyNexusModeToMainMode("nexus_game_studio"), "game_studio");
  assert.equal(mapLegacyNexusModeToMainMode("nexus_general"), "main_mode");
  assert.equal(mapMainModeToLegacyNexusMode("task_center"), "nexus_general");
});

test("creates local task cards with stable defaults and deduped context", () => {
  const task = createTaskCenterTask({
    prompt: "  Implement the Task Center scheduler and tests  ",
    contextMentions: ["src/a.ts", "src/a.ts", " "],
    attachedFiles: ["notes.md", "notes.md"],
    imageCount: -2,
    workspace: "/tmp/main",
    now: 1000,
  });

  assert.equal(task.status, "inbox");
  assert.equal(task.source.provider, "local");
  assert.equal(task.prompt, "Implement the Task Center scheduler and tests");
  assert.equal(task.title.length <= 42, true);
  assert.equal(task.title.startsWith("Implement the Task Center scheduler"), true);
  assert.equal(task.title.endsWith("..."), true);
  assert.deepEqual(task.contextMentions, ["src/a.ts"]);
  assert.deepEqual(task.attachedFiles, ["notes.md"]);
  assert.equal(task.imageCount, 0);
  assert.equal(task.attempts, 0);
  assert.equal(task.workspace, "/tmp/main");
});

test("normalizes persisted task center state defensively", () => {
  const normalized = normalizeTaskCenterState({
    selectedTaskId: "missing",
    activeTaskId: "missing",
    scheduler: {
      paused: false,
      maxReadOnlyConcurrency: 0,
      maxWriteConcurrency: 0,
    },
    tasks: [
      {
        id: "task-1",
        title: "",
        prompt: "Review imported issue",
        status: "unknown",
        source: { provider: "jira" },
        contextMentions: ["a", "a"],
        attachedFiles: ["b", "b"],
        imageCount: 2,
        subtasks: [],
        runIds: [],
        attempts: -1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    runs: [
      {
        id: "run-1",
        taskId: "task-1",
        status: "mystery",
        intent: "draft",
        attempt: 0,
        startedAt: 2,
        logs: [],
      },
    ],
  });

  assert.equal(normalized.selectedTaskId, "task-1");
  assert.equal(normalized.activeTaskId, null);
  assert.equal(normalized.tasks[0].status, "inbox");
  assert.equal(normalized.tasks[0].source.provider, "local");
  assert.equal(normalized.tasks[0].attempts, 0);
  assert.deepEqual(normalized.tasks[0].contextMentions, ["a"]);
  assert.equal(normalized.runs[0].status, "queued");
  assert.equal(normalized.runs[0].intent, "execute");
  assert.equal(normalized.runs[0].attempt, 1);
  assert.equal(normalized.scheduler.maxReadOnlyConcurrency, 1);
  assert.equal(normalized.scheduler.maxWriteConcurrency, 1);
});

test("run lifecycle updates task, run logs, attempts, and write lock", () => {
  const task = createTaskCenterTask({ prompt: "Ship it", now: 1000 });
  const initialState = {
    ...createDefaultTaskCenterState(),
    tasks: [{ ...task, status: "ready" }],
    selectedTaskId: task.id,
  };

  const started = startTaskCenterRun(initialState, task.id, "execute", 2000);
  assert.ok(started.run);
  assert.equal(started.state.activeTaskId, task.id);
  assert.equal(started.state.scheduler.writeLockTaskId, task.id);
  assert.equal(started.state.tasks[0].status, "running");
  assert.equal(started.state.tasks[0].attempts, 1);
  assert.equal(started.state.runs[0].status, "running");
  assert.match(started.state.runs[0].logs[0].message, /Execution run started/);

  const logged = appendTaskCenterRunLog(started.state, task.id, "Tool running: npm test", "info", 2500);
  assert.equal(logged.runs[0].logs.at(-1).message, "Tool running: npm test");

  const review = finishTaskCenterRun(logged, task.id, "needs_review", "Waiting for approval", 3000);
  assert.equal(review.activeTaskId, task.id);
  assert.equal(review.scheduler.writeLockTaskId, task.id);
  assert.equal(review.tasks[0].status, "needs_review");
  assert.equal(review.runs[0].status, "needs_review");
  assert.equal(review.runs[0].endedAt, null);

  const done = finishTaskCenterRun(review, task.id, "done", "Completed", 4000);
  assert.equal(done.activeTaskId, null);
  assert.equal(done.scheduler.writeLockTaskId, null);
  assert.equal(done.tasks[0].status, "done");
  assert.equal(done.tasks[0].completedAt, 4000);
  assert.equal(done.runs[0].status, "done");
  assert.equal(done.runs[0].summary, "Completed");
});

test("scheduler picker respects pause state, FIFO order, and write lock", () => {
  const first = { ...createTaskCenterTask({ prompt: "First", now: 1000 }), status: "ready" };
  const second = { ...createTaskCenterTask({ prompt: "Second", now: 2000 }), status: "ready" };
  const baseState = {
    ...createDefaultTaskCenterState(),
    tasks: [second, first],
  };

  assert.equal(pickNextTaskCenterTask(baseState, "execute").id, first.id);
  assert.equal(pickNextTaskCenterTask({
    ...baseState,
    tasks: [{ ...first, status: "inbox" }, second],
  }, "execute", ["ready"]).id, second.id);
  assert.equal(canStartTaskCenterTask(baseState, first, "execute"), true);

  const lockedBySecond = {
    ...baseState,
    scheduler: { ...baseState.scheduler, writeLockTaskId: second.id },
  };
  assert.equal(pickNextTaskCenterTask(lockedBySecond, "execute").id, second.id);
  assert.equal(canStartTaskCenterTask(lockedBySecond, first, "execute"), false);
  assert.equal(canStartTaskCenterTask(lockedBySecond, first, "plan"), true);

  const paused = {
    ...baseState,
    scheduler: { ...baseState.scheduler, paused: true },
  };
  assert.equal(pickNextTaskCenterTask(paused, "execute"), null);
});

test("external adapters stay inert until configured and preserve links", async () => {
  const state = createDefaultTaskCenterState();
  const adapters = createTaskSourceAdapters(state.integrations);
  assert.deepEqual(adapters.map((adapter) => adapter.provider), ["linear", "github", "feishu"]);

  for (const adapter of adapters) {
    assert.equal(adapter.isConfigured(), false);
    assert.deepEqual(await adapter.importIssues(), []);
    await adapter.pushStatus(createTaskCenterTask({ prompt: "No-op" }));
  }

  const configured = createTaskSourceAdapters({
    ...state.integrations,
    github: {
      ...state.integrations.github,
      enabled: true,
      token: "token",
    },
  });
  const github = configured.find((adapter) => adapter.provider === "github");
  assert.equal(github.isConfigured(), true);
  assert.deepEqual(await github.importIssues(), []);

  const linked = await github.linkTask(createTaskCenterTask({
    prompt: "Imported issue",
    title: "Issue title",
    source: {
      provider: "github",
      externalId: "42",
      url: "https://github.com/example/repo/issues/42",
    },
  }));
  assert.deepEqual(linked, {
    provider: "github",
    externalId: "42",
    url: "https://github.com/example/repo/issues/42",
    title: "Issue title",
  });
});
