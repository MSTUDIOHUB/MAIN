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
  FEISHU_APPROVAL_TTL_MS,
  buildFeishuApprovalCard,
  buildFeishuMarkdownCard,
  createFeishuPairingRequest,
  normalizeImAdaptersConfig,
  parseFeishuApprovalCardActionValue,
  parseFeishuTextCommand,
  resolveFeishuApprovalAction,
  resolveFeishuRemoteIntentOverride,
  upsertFeishuPairedUser,
  upsertFeishuPairingRequest,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/imAdapters.ts"));

test("normalizes Feishu adapter config with fixed v1 policy defaults", () => {
  const config = normalizeImAdaptersConfig({
    feishu: {
      enabled: true,
      appId: " cli_app ",
      appSecret: "secret",
      domain: "",
      pairingCode: "abc",
      routing: "other",
      chatScope: "group",
      accessPolicy: "open",
      pairedUsers: [{ openId: "ou_1", name: "Michael", chatId: "oc_1", pairedAt: 10 }],
    },
  });

  assert.equal(config.feishu.enabled, true);
  assert.equal(config.feishu.appId, "cli_app");
  assert.equal(config.feishu.domain, "https://open.feishu.cn");
  assert.match(config.feishu.pairingCode, /^\d{6}$/);
  assert.equal(config.feishu.routing, "current_workspace");
  assert.equal(config.feishu.chatScope, "dm_only");
  assert.equal(config.feishu.accessPolicy, "pairing");
  assert.equal(config.feishu.pairedUsers.length, 1);
});

test("parses Feishu private-chat commands", () => {
  assert.deepEqual(parseFeishuTextCommand("/approve ABC123"), { kind: "approve", code: "ABC123" });
  assert.deepEqual(parseFeishuTextCommand("/always_allow ABC123"), { kind: "approve_session", code: "ABC123" });
  assert.deepEqual(parseFeishuTextCommand("/approve_session XYZ456"), { kind: "approve_session", code: "XYZ456" });
  assert.deepEqual(parseFeishuTextCommand("/reject xyz9"), { kind: "reject", code: "xyz9" });
  assert.deepEqual(parseFeishuTextCommand("/pair 123456"), { kind: "pair", code: "123456" });
  assert.deepEqual(parseFeishuTextCommand("/status"), { kind: "status" });
  assert.deepEqual(parseFeishuTextCommand("/stop"), { kind: "stop" });
  assert.deepEqual(parseFeishuTextCommand("/help"), { kind: "help" });
  assert.deepEqual(parseFeishuTextCommand("/new"), { kind: "new" });
  assert.deepEqual(parseFeishuTextCommand("/reset"), { kind: "new" });
  assert.deepEqual(parseFeishuTextCommand("/follow"), { kind: "follow" });
  assert.deepEqual(parseFeishuTextCommand("帮我执行任务"), { kind: "message", text: "帮我执行任务" });
});

test("Feishu plain text defaults to read-only analysis unless an intent shortcut is present", () => {
  assert.deepEqual(resolveFeishuRemoteIntentOverride("当前项目是什么游戏类型？"), {
    resolvedIntent: "analyze",
    skipIntentResolution: true,
  });
  assert.deepEqual(resolveFeishuRemoteIntentOverride("/execute 修复编译错误"), {
    resolvedIntent: "analyze",
    skipIntentResolution: true,
  });
  assert.deepEqual(resolveFeishuRemoteIntentOverride("/分析 检查编译错误"), {});
  assert.deepEqual(resolveFeishuRemoteIntentOverride("/计划 先给我实现方案"), {});
  assert.deepEqual(resolveFeishuRemoteIntentOverride("/MDEBUG\n# MAIN 用户反馈修复请求"), {});
});

test("upserts pairing requests and paired users by open id", () => {
  const message = {
    type: "message",
    adapter: "feishu",
    messageId: "m1",
    chatId: "oc_1",
    chatType: "p2p",
    userId: "ou_1",
    userName: "Michael",
    text: "hello",
    timestamp: 100,
  };
  const request = createFeishuPairingRequest(message);
  const requests = upsertFeishuPairingRequest([request], { ...request, requestedAt: 200 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestedAt, 200);

  const users = upsertFeishuPairedUser(
    [{ openId: "ou_1", name: "Old", chatId: "oc_old", pairedAt: 1 }],
    { openId: "ou_1", name: "Michael", chatId: "oc_1", pairedAt: 2, lastSeenAt: 3 },
  );
  assert.equal(users.length, 1);
  assert.equal(users[0].name, "Michael");
  assert.equal(users[0].chatId, "oc_1");
});

test("builds Feishu approval card without leaking command into button values", () => {
  const card = buildFeishuApprovalCard({
    language: "zh",
    approvalId: "apv_123",
    nonce: "nonce_secret",
    code: "ABC123",
    toolName: "run_command",
    target: "npm test",
    workspace: "/tmp/project",
    preview: "npm test -- --runInBand",
    requestedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + FEISHU_APPROVAL_TTL_MS,
    status: "pending",
  });

  const serialized = JSON.stringify(card);
  assert.match(serialized, /npm test -- --runInBand/);
  const actionBlock = card.elements.find((element) => element.tag === "action");
  assert.ok(actionBlock);
  const buttonValues = JSON.stringify(actionBlock.actions.map((action) => action.value));
  assert.match(buttonValues, /apv_123/);
  assert.match(buttonValues, /nonce_secret/);
  assert.doesNotMatch(buttonValues, /npm test/);
  assert.doesNotMatch(buttonValues, /runInBand/);
});

test("parses Feishu approval card action payloads", () => {
  const payload = {
    mainAction: "feishu_approval",
    action: "approve",
    approvalId: "apv_1",
    nonce: "nonce_1",
  };
  assert.deepEqual(parseFeishuApprovalCardActionValue(payload), {
    action: "approve",
    approvalId: "apv_1",
    nonce: "nonce_1",
  });
  assert.deepEqual(parseFeishuApprovalCardActionValue({ ...payload, action: "approve_session" }), {
    action: "approve_session",
    approvalId: "apv_1",
    nonce: "nonce_1",
  });
  assert.deepEqual(parseFeishuApprovalCardActionValue(JSON.stringify({ ...payload, action: "reject" })), {
    action: "reject",
    approvalId: "apv_1",
    nonce: "nonce_1",
  });
  assert.equal(parseFeishuApprovalCardActionValue({ ...payload, action: "delete" }), null);
  assert.equal(parseFeishuApprovalCardActionValue({ action: "approve" }), null);
});

test("validates Feishu approval action identity, nonce, expiry and single-use state", () => {
  const pending = {
    approvalId: "apv_1",
    nonce: "nonce_1",
    chatId: "oc_1",
    userId: "ou_1",
    expiresAt: 2000,
    status: "pending",
  };
  const baseRequest = {
    approvalId: "apv_1",
    nonce: "nonce_1",
    chatId: "oc_1",
    userId: "ou_1",
    action: "approve",
  };

  assert.deepEqual(resolveFeishuApprovalAction([pending], baseRequest, 1000), {
    ok: true,
    approval: pending,
  });
  assert.equal(resolveFeishuApprovalAction([pending], { ...baseRequest, userId: "ou_2" }, 1000).reason, "wrong_user");
  assert.equal(resolveFeishuApprovalAction([pending], { ...baseRequest, chatId: "oc_2" }, 1000).reason, "wrong_chat");
  assert.equal(resolveFeishuApprovalAction([pending], { ...baseRequest, nonce: "bad" }, 1000).reason, "nonce_mismatch");
  assert.equal(resolveFeishuApprovalAction([pending], baseRequest, 3000).reason, "expired");
  assert.equal(resolveFeishuApprovalAction([{ ...pending, status: "approved" }], baseRequest, 1000).reason, "already_resolved");
});

test("builds Feishu markdown card with wide screen config and custom template color", () => {
  const card = buildFeishuMarkdownCard("Test Title", "Test Content", "purple");
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.header.template, "purple");
  assert.equal(card.header.title.content, "Test Title");
  assert.equal(card.elements[0].tag, "markdown");
  assert.equal(card.elements[0].content, "Test Content");
});

