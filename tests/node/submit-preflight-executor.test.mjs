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
  executeSubmitBlockingPreflight,
  startSubmitBlockingPreflightEffect,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPreflightExecutor.ts"),
);

function commandDirective(overrides = {}) {
  return {
    kind: "none",
    source: "natural_language",
    requiresWorkspace: false,
    requiresApproval: false,
    confidence: 0.8,
    ...overrides,
  };
}

function baseResolution(overrides = {}) {
  return {
    intent: "respond",
    reason: "local low-risk response",
    confidence: 0.72,
    bypassMainRouter: false,
    riskLevel: "low",
    requiresApproval: false,
    commandDirective: commandDirective(),
    ...overrides,
  };
}

function createEffect(overrides = {}) {
  const originalText = overrides.originalText || "修复标题同步";
  return {
    request: {
      input: originalText,
      language: "zh",
      mainModeKey: "main_mode",
      config: {},
    },
    originalText,
    originalImages: ["image-a"],
    originalOptions: { preservePlanState: true },
    originalMainModeKey: "main_mode",
    preferredLanguage: "zh",
    resolution: baseResolution(),
    sendOriginSessionKey: null,
    ...overrides,
  };
}

async function executeWithFakes({ effect = createEffect(), preflight = null, latest = {}, originActive = true } = {}) {
  const events = [];
  const pendingDecisions = [];
  const resumes = [];
  const requests = [];
  const action = await executeSubmitBlockingPreflight({
    effect,
    async runIntentPreflight(request) {
      requests.push(request);
      return preflight;
    },
    getLatestSnapshot() {
      return {
        input: effect.originalText,
        selectedMainModeKey: "main_mode",
        lockedComposerIntent: null,
        isOriginSessionActive: originActive,
        ...latest,
      };
    },
    applyPendingRunDecision(decision) {
      pendingDecisions.push(decision);
    },
    resumeSubmission(text, images, options) {
      resumes.push({ text, images, options });
    },
    logStoreEvent(event, data) {
      events.push({ event, data });
    },
  });
  return { action, events, pendingDecisions, resumes, requests };
}

test("submit blocking preflight executor logs stale drafts without resuming", async () => {
  const result = await executeWithFakes({
    latest: { input: "用户已经改了草稿" },
  });

  assert.equal(result.action.kind, "stale_discard");
  assert.equal(result.requests.length, 1);
  assert.equal(result.events[0].event, "intent_preflight_stale_discarded");
  assert.equal(result.events[0].data.latestChars, "用户已经改了草稿".length);
  assert.equal(result.pendingDecisions.length, 0);
  assert.equal(result.resumes.length, 0);
});

test("submit blocking preflight executor applies pending user decisions", async () => {
  const result = await executeWithFakes({
    preflight: {
      intent: "plan",
      confidence: 0.58,
      needsUserChoice: true,
      question: "要先规划吗？",
      options: [{ id: "plan", label: "先规划", value: "请先制定计划" }],
      commandDirective: commandDirective({ source: "preflight" }),
    },
  });

  assert.equal(result.action.kind, "set_pending_decision");
  assert.equal(result.pendingDecisions.length, 1);
  assert.equal(result.pendingDecisions[0].source, "preflight");
  assert.equal(result.pendingDecisions[0].title, "要先规划吗？");
  assert.equal(result.resumes.length, 0);
  assert.equal(result.events.length, 0);
});

test("submit blocking preflight executor skips inactive async resumes", async () => {
  const effect = createEffect({
    resolution: baseResolution({
      intent: "execute",
      riskLevel: "medium",
      commandDirective: commandDirective({ kind: "file_modify", source: "natural_language" }),
    }),
    sendOriginSessionKey: "workspace-a:42",
  });
  const result = await executeWithFakes({
    effect,
    originActive: false,
    preflight: {
      intent: "execute",
      confidence: 0.96,
      requiresApproval: false,
      summary: "修改标题同步逻辑",
      reason: "明确要求修改代码",
      commandDirective: commandDirective({ kind: "file_modify", source: "preflight" }),
    },
  });

  assert.equal(result.action.kind, "skip_inactive_session");
  assert.equal(result.events[0].event, "send_async_resume_skipped_inactive_session");
  assert.equal(result.events[0].data.sessionKey, "workspace-a:42");
  assert.equal(result.pendingDecisions.length, 0);
  assert.equal(result.resumes.length, 0);
});

test("submit blocking preflight executor resumes active submissions with preflight options", async () => {
  const effect = createEffect({
    resolution: baseResolution({
      intent: "execute",
      riskLevel: "medium",
      commandDirective: commandDirective({ kind: "file_modify", source: "natural_language" }),
    }),
    sendOriginSessionKey: "workspace-a:42",
  });
  const result = await executeWithFakes({
    effect,
    preflight: {
      intent: "execute",
      confidence: 0.97,
      requiresApproval: false,
      title: "修复标题同步",
      summary: "调整标题同步逻辑",
      reason: "用户要求修改代码",
      commandDirective: commandDirective({ kind: "file_modify", source: "preflight" }),
    },
  });

  assert.equal(result.action.kind, "resume");
  assert.equal(result.resumes.length, 1);
  assert.equal(result.resumes[0].text, "修复标题同步");
  assert.deepEqual(result.resumes[0].images, ["image-a"]);
  assert.equal(result.resumes[0].options.skipIntentResolution, true);
  assert.equal(result.resumes[0].options.resolvedIntent, "execute");
  assert.equal(result.resumes[0].options.turnTitle, "修复标题同步");
  assert.equal(result.pendingDecisions.length, 0);
  assert.equal(result.events.length, 0);
});

test("submit blocking preflight starter derives origin activity from latest state", async () => {
  const effect = createEffect({
    resolution: baseResolution({
      intent: "execute",
      riskLevel: "medium",
      commandDirective: commandDirective({ kind: "file_modify", source: "natural_language" }),
    }),
    sendOriginSessionKey: "workspace-a:42",
  });
  const events = [];
  const resumes = [];
  const action = await startSubmitBlockingPreflightEffect({
    effect,
    async runIntentPreflight() {
      return {
        intent: "execute",
        confidence: 0.96,
        requiresApproval: false,
        commandDirective: commandDirective({ kind: "file_modify", source: "preflight" }),
      };
    },
    getState() {
      return {
        input: effect.originalText,
        selectedMainModeKey: "main_mode",
        lockedComposerIntent: null,
        currentWorkspace: "/tmp/ui",
        currentSessionId: 7,
      };
    },
    isSessionRuntimeActive(state, sessionKey) {
      assert.equal(state.currentWorkspace, "/tmp/ui");
      assert.equal(sessionKey, "workspace-a:42");
      return false;
    },
    applyPreRunSessionPatch() {
      assert.fail("inactive resume should not set a pending decision");
    },
    resumeSubmission(text, images, options) {
      resumes.push({ text, images, options });
    },
    logStoreEvent(event, data) {
      events.push({ event, data });
    },
  });

  assert.equal(action.kind, "skip_inactive_session");
  assert.deepEqual(resumes, []);
  assert.equal(events[0].event, "send_async_resume_skipped_inactive_session");
  assert.equal(events[0].data.sessionKey, "workspace-a:42");
});

test("submit blocking preflight starter applies pending decisions through pre-run patcher", async () => {
  const effect = createEffect();
  const patches = [];
  const action = await startSubmitBlockingPreflightEffect({
    effect,
    async runIntentPreflight() {
      return {
        intent: "plan",
        confidence: 0.58,
        needsUserChoice: true,
        question: "要先规划吗？",
        options: [{ id: "plan", label: "先规划", value: "请先制定计划" }],
        commandDirective: commandDirective({ source: "preflight" }),
      };
    },
    getState() {
      return {
        input: effect.originalText,
        selectedMainModeKey: "main_mode",
        lockedComposerIntent: null,
      };
    },
    isSessionRuntimeActive() {
      return true;
    },
    applyPreRunSessionPatch(patch) {
      patches.push(patch);
    },
    resumeSubmission() {
      assert.fail("pending decision should not resume submission");
    },
    logStoreEvent() {},
  });

  assert.equal(action.kind, "set_pending_decision");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].pendingRunDecision.source, "preflight");
  assert.equal(patches[0].pendingRunDecision.title, "要先规划吗？");
});
