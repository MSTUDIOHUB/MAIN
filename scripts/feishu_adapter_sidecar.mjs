import * as Lark from "@larksuiteoapi/node-sdk";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

let client = null;
let wsClient = null;
let started = false;

function sanitizeSecretText(value) {
  return String(value ?? "")
    .replace(/app_secret['":=\s]+[A-Za-z0-9._-]+/gi, "app_secret=<hidden>")
    .replace(/appSecret['":=\s]+[A-Za-z0-9._-]+/gi, "appSecret=<hidden>");
}

function stringifyLogItem(item) {
  if (item instanceof Error) return item.message;
  if (!item || typeof item !== "object") return String(item);
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function writeSidecarLog(level, args) {
  const message = args.map(stringifyLogItem).join(" ");
  process.stderr.write(`[feishu-adapter:${level}] ${sanitizeSecretText(message)}\n`);
}

function installConsoleRedirect() {
  console.log = (...args) => writeSidecarLog("log", args);
  console.info = (...args) => writeSidecarLog("info", args);
  console.warn = (...args) => writeSidecarLog("warn", args);
  console.error = (...args) => writeSidecarLog("error", args);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitStatus(status, message, extra = {}) {
  emit({
    type: "status",
    adapter: "feishu",
    status,
    running: status === "connected" || status === "starting",
    message,
    timestamp: Date.now(),
    ...extra,
  });
}

function emitConnectionError(message) {
  emit({
    type: "error",
    adapter: "feishu",
    status: "error",
    running: false,
    message,
    timestamp: Date.now(),
  });
}

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseTextContent(content) {
  try {
    const parsed = JSON.parse(content || "{}");
    return safeText(parsed.text || "");
  } catch {
    return safeText(content || "");
  }
}

function parseCardActionValue(value) {
  let record = value;
  if (typeof value === "string") {
    try {
      record = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.mainAction !== "feishu_approval") return null;
  const action = safeText(record.action);
  const approvalId = safeText(record.approvalId);
  const nonce = safeText(record.nonce);
  if (action !== "approve" && action !== "approve_session" && action !== "reject") return null;
  if (!approvalId || !nonce) return null;
  return { action, approvalId, nonce };
}

export function normalizeFeishuCardActionEvent(data) {
  const context = data?.context || {};
  const operator = data?.operator || {};
  const actionValue = parseCardActionValue(data?.action?.value);
  const messageId = safeText(context.open_message_id || data?.open_message_id || data?.message_id);
  const chatId = safeText(context.open_chat_id || data?.open_chat_id || data?.chat_id);
  const userId = safeText(operator.open_id || operator.user_id || operator.union_id);
  if (!actionValue || !messageId || !chatId || !userId) return null;
  return {
    type: "card_action",
    adapter: "feishu",
    messageId,
    chatId,
    userId,
    userName: safeText(operator.name || userId) || userId,
    action: actionValue.action,
    approvalId: actionValue.approvalId,
    nonce: actionValue.nonce,
    timestamp: Date.now(),
  };
}

function resolveDomain(domain) {
  const value = safeText(domain) || "https://open.feishu.cn";
  if (value.includes("open.larksuite.com")) return Lark.Domain.Lark;
  if (value.includes("open.feishu.cn")) return Lark.Domain.Feishu;
  return value;
}

function createLogger() {
  const write = (level, args) => {
    const message = args.map(stringifyLogItem).join(" ");
    process.stderr.write(`[feishu-adapter:${level}] ${sanitizeSecretText(message)}\n`);
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

async function startAdapter(config) {
  if (started) {
    emitStatus("connected", "Feishu adapter is already running.");
    return;
  }

  const appId = safeText(config?.appId);
  const appSecret = String(config?.appSecret || "");
  if (!appId || !appSecret) {
    emitConnectionError("Missing Feishu App ID or App Secret.");
    return;
  }

  emitStatus("starting", "Starting Feishu long connection...");

  const baseConfig = {
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(config?.domain),
    logger: createLogger(),
    loggerLevel: Lark.LoggerLevel.warn,
  };

  client = new Lark.Client(baseConfig);
  wsClient = new Lark.WSClient({
    ...baseConfig,
    onReady: () => emitStatus("connected", "Feishu long connection is ready."),
    onError: (error) => emitConnectionError(error?.message || "Feishu long connection failed."),
    onReconnecting: () => emitStatus("starting", "Feishu long connection is reconnecting..."),
    onReconnected: () => emitStatus("connected", "Feishu long connection reconnected."),
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const message = data?.message || {};
      const sender = data?.sender || {};
      const senderId = sender.sender_id || {};
      const chatType = safeText(message.chat_type);
      const messageType = safeText(message.message_type);

      if (!["p2p", "private"].includes(chatType)) return;
      if (messageType !== "text") return;

      const text = parseTextContent(message.content);
      if (!text) return;

      const userId = safeText(senderId.open_id || senderId.user_id || senderId.union_id);
      if (!userId) return;

      emit({
        type: "message",
        adapter: "feishu",
        messageId: safeText(message.message_id || data?.event_id || `${Date.now()}`),
        chatId: safeText(message.chat_id),
        chatType,
        userId,
        userName: userId,
        text,
        timestamp: Number(message.create_time) || Date.now(),
      });
    },
    "card.action.trigger": async (data) => {
      const event = normalizeFeishuCardActionEvent(data);
      if (event) emit(event);
    },
  });

  started = true;
  await wsClient.start({ eventDispatcher });
}

export function buildFeishuSendAttempts(target) {
  const attempts = [];
  const seen = new Set();
  const addCreateAttempt = (receiveIdType, receiveId) => {
    const id = safeText(receiveId);
    if (!id) return;
    const key = `${receiveIdType}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({
      method: "create",
      receiveIdType,
      receiveId: id,
      label: `${receiveIdType}:${id}`,
    });
  };

  addCreateAttempt("chat_id", target?.chatId);
  addCreateAttempt("open_id", target?.openId || target?.userId);

  const messageId = safeText(target?.messageId);
  if (messageId) {
    attempts.push({
      method: "reply",
      messageId,
      label: `reply:${messageId}`,
    });
  }

  return attempts;
}

export function formatFeishuError(error) {
  const response = error?.response || error?.error?.response;
  const data = response?.data || error?.data || error?.responseBody || null;
  const status = response?.status || error?.status || error?.code || "";
  const requestId =
    response?.headers?.["x-tt-logid"] ||
    response?.headers?.["x-request-id"] ||
    response?.headers?.["x-lark-request-id"] ||
    error?.requestId ||
    "";
  const pieces = [];
  if (status) pieces.push(`status=${status}`);
  if (error?.message) pieces.push(`message=${error.message}`);
  if (requestId) pieces.push(`request_id=${requestId}`);
  if (data) pieces.push(`body=${stringifyLogItem(data)}`);
  return sanitizeSecretText(pieces.join(" ") || String(error));
}

async function sendMessagePayload(target, message, sdkClient = client, emitFn = emit) {
  if (!sdkClient) throw new Error("Feishu adapter is not connected.");
  if (!message?.content || !message?.msgType) return null;

  const attempts = buildFeishuSendAttempts(target);
  if (attempts.length === 0) throw new Error("Missing Feishu send target.");

  const failures = [];

  for (const attempt of attempts) {
    try {
      let response = null;
      if (attempt.method === "reply") {
        response = await sdkClient.im.v1.message.reply({
          path: { message_id: attempt.messageId },
          data: {
            msg_type: message.msgType,
            content: message.content,
          },
        });
      } else {
        response = await sdkClient.im.v1.message.create({
          params: {
            receive_id_type: attempt.receiveIdType,
          },
          data: {
            receive_id: attempt.receiveId,
            msg_type: message.msgType,
            content: message.content,
          },
        });
      }
      const messageId = safeText(response?.data?.message_id);
      emitFn({
        type: "message_sent",
        adapter: "feishu",
        messageKind: message.messageKind,
        approvalId: message.approvalId,
        messageId,
        chatId: safeText(target?.chatId),
        timestamp: Date.now(),
      });
      emitFn({
        type: "log",
        adapter: "feishu",
        level: "info",
        message: `Feishu message sent via ${attempt.label}.`,
        timestamp: Date.now(),
      });
      return messageId;
    } catch (error) {
      failures.push(`${attempt.label}: ${formatFeishuError(error)}`);
    }
  }

  const failureMessage = `Feishu message send failed. ${failures.join(" | ")}`;
  emitFn({
    type: "status",
    adapter: "feishu",
    status: started ? "connected" : "idle",
    running: started,
    message: failureMessage,
    timestamp: Date.now(),
    sendError: true,
  });
  throw new Error(failureMessage);
}

export async function sendText(target, text, sdkClient = client, emitFn = emit) {
  const content = safeText(text);
  if (!content) return null;
  return sendMessagePayload(
    target,
    {
      msgType: "text",
      content: JSON.stringify({ text: content.slice(0, 3500) }),
      messageKind: "text",
    },
    sdkClient,
    emitFn,
  );
}

export async function sendCard(target, card, sdkClient = client, emitFn = emit) {
  if (!card || typeof card !== "object") throw new Error("Missing Feishu interactive card content.");
  return sendMessagePayload(
    target,
    {
      msgType: "interactive",
      content: JSON.stringify(card),
      messageKind: target?.messageKind || "interactive_card",
      approvalId: safeText(target?.approvalId),
    },
    sdkClient,
    emitFn,
  );
}

export async function patchCard(messageId, card, sdkClient = client, emitFn = emit) {
  if (!sdkClient) throw new Error("Feishu adapter is not connected.");
  const id = safeText(messageId);
  if (!id) throw new Error("Missing Feishu message id for card update.");
  if (!card || typeof card !== "object") throw new Error("Missing Feishu interactive card content.");
  await sdkClient.im.v1.message.patch({
    path: { message_id: id },
    data: {
      content: JSON.stringify(card),
    },
  });
  emitFn({
    type: "log",
    adapter: "feishu",
    level: "info",
    message: `Feishu card patched: ${id}.`,
    timestamp: Date.now(),
  });
}

async function stopAdapter() {
  if (wsClient) {
    try {
      wsClient.close({ force: true });
    } catch {
      // Closing is best-effort during shutdown.
    }
  }
  emitStatus("stopped", "Feishu adapter stopped.");
  process.exit(0);
}

async function handleCommandLine(line) {
  if (!line.trim()) return;
  try {
    const command = JSON.parse(line);
    if (command.type === "start") {
      await startAdapter(command.config);
      return;
    }
    if (command.type === "send_text") {
      try {
        await sendText(command, command.text);
      } catch {
        // sendText emits a non-fatal status update; keep the long connection alive.
      }
      return;
    }
    if (command.type === "send_card") {
      try {
        await sendCard(command, command.card);
      } catch (error) {
        emit({
          type: "status",
          adapter: "feishu",
          status: started ? "connected" : "idle",
          running: started,
          message: `Feishu card send failed. ${formatFeishuError(error)}`,
          timestamp: Date.now(),
          sendError: true,
        });
      }
      return;
    }
    if (command.type === "patch_card") {
      try {
        await patchCard(command.messageId, command.card);
      } catch (error) {
        emit({
          type: "status",
          adapter: "feishu",
          status: started ? "connected" : "idle",
          running: started,
          message: `Feishu card update failed. ${formatFeishuError(error)}`,
          timestamp: Date.now(),
          sendError: true,
        });
      }
      return;
    }
    if (command.type === "stop") {
      await stopAdapter();
    }
  } catch (error) {
    emitConnectionError(error instanceof Error ? error.message : String(error));
  }
}

function startCommandLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    void handleCommandLine(line);
  });

  process.on("SIGTERM", () => {
    void stopAdapter();
  });

  process.on("SIGINT", () => {
    void stopAdapter();
  });
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  installConsoleRedirect();
  startCommandLoop();
  emitStatus("idle", "Feishu adapter sidecar is ready.");
}
