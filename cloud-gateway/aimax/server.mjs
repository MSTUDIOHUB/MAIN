import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  GatewayError,
  buildUpstreamHeaders,
  buildUpstreamRequestBody,
  buildUpstreamUrl,
  extractTextDeltaFromUpstreamPayload,
  getConfig,
  loadEnvFile,
  parseUpstreamTextStream,
} from "./adapter.mjs";
import {
  createCompletedResponse,
  createResponseId,
  writeResponseCompleted,
  writeResponseCreated,
  writeResponseError,
  writeTextDelta,
  writeTextDone,
} from "./responses.mjs";

loadEnvFile();

const config = getConfig();

// #region HTTP 服务入口
export function createServer(activeConfig = config) {
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = createResponseId();

    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, model: activeConfig.model });
        logRequest({ requestId, method: req.method, path: url.pathname, status: 200, startedAt });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: [{ id: activeConfig.model, object: "model", created: 0, owned_by: "ai-max-cloud" }],
        });
        logRequest({ requestId, method: req.method, path: url.pathname, status: 200, startedAt });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const body = await readJsonBody(req);
        if (body.stream) {
          await handleStreamingResponse({ req, res, body, config: activeConfig, requestId, startedAt });
        } else {
          await handleNonStreamingResponse({ res, body, config: activeConfig, requestId, startedAt });
        }
        return;
      }

      sendJson(res, 404, { error: { message: "Not found", type: "not_found", code: "not_found" } });
      logRequest({ requestId, method: req.method, path: url.pathname, status: 404, startedAt });
    } catch (error) {
      handleHttpError(res, error);
      logRequest({ requestId, method: req.method, path: req.url, status: error.status || 500, startedAt, error });
    }
  });
}
// #endregion

// #region Responses 请求处理
async function handleNonStreamingResponse({ res, body, config, requestId, startedAt }) {
  const upstreamBody = buildUpstreamRequestBody(body, config);
  const upstreamResponse = await fetchUpstream({ upstreamBody, config, stream: false });
  const upstreamJson = await upstreamResponse.json().catch(() => ({}));

  if (!upstreamResponse.ok) {
    throw new GatewayError(`Upstream request failed with ${upstreamResponse.status}.`, {
      status: upstreamResponse.status,
      code: "upstream_error",
      details: upstreamJson,
    });
  }

  const { text } = extractTextDeltaFromUpstreamPayload(upstreamJson);
  sendJson(res, 200, createCompletedResponse({ id: requestId, model: config.model, text }));
  logRequest({ requestId, method: "POST", path: "/v1/responses", status: 200, startedAt, stream: false, model: config.model });
}

async function handleStreamingResponse({ req, res, body, config, requestId, startedAt }) {
  const upstreamBody = buildUpstreamRequestBody(body, config);
  const upstreamResponse = await fetchUpstream({ upstreamBody, config, stream: true });

  res.writeHead(upstreamResponse.ok ? 200 : upstreamResponse.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (!upstreamResponse.ok) {
    const details = await upstreamResponse.text().catch(() => "");
    writeResponseError(res, new GatewayError(`Upstream request failed with ${upstreamResponse.status}.`, {
      status: upstreamResponse.status,
      code: "upstream_error",
      details,
    }));
    res.end();
    logRequest({ requestId, method: "POST", path: "/v1/responses", status: upstreamResponse.status, startedAt, stream: true, model: config.model });
    return;
  }

  const createdAt = Math.floor(Date.now() / 1000);
  let fullText = "";
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);

  req.on("close", () => clearInterval(keepAlive));

  try {
    writeResponseCreated(res, { id: requestId, model: config.model, createdAt });

    for await (const payload of parseUpstreamTextStream(upstreamResponse.body)) {
      const { done, text } = extractTextDeltaFromUpstreamPayload(payload);
      if (text) {
        fullText += text;
        writeTextDelta(res, { responseId: requestId, delta: text });
      }
      if (done) break;
    }

    writeTextDone(res, { responseId: requestId, text: fullText });
    writeResponseCompleted(res, { id: requestId, model: config.model, text: fullText, createdAt });
  } catch (error) {
    writeResponseError(res, error);
  } finally {
    clearInterval(keepAlive);
    res.end();
    logRequest({ requestId, method: "POST", path: "/v1/responses", status: 200, startedAt, stream: true, model: config.model });
  }
}
// #endregion

// #region 上游请求
async function fetchUpstream({ upstreamBody, config, stream }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  try {
    return await fetch(buildUpstreamUrl(config), {
      method: "POST",
      headers: buildUpstreamHeaders(config),
      body: JSON.stringify({ ...upstreamBody, stream }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GatewayError("Upstream request timed out.", { status: 504, code: "upstream_timeout" });
    }
    throw new GatewayError(`Unable to reach upstream: ${error.message}`, { status: 502, code: "upstream_unreachable" });
  } finally {
    clearTimeout(timeout);
  }
}
// #endregion

// #region HTTP 工具与日志
async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError("Request body must be valid JSON.", { status: 400, code: "invalid_json" });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function handleHttpError(res, error) {
  const status = error.status || 500;
  sendJson(res, status, {
    error: {
      message: error.message || "Gateway error",
      type: error.code || "gateway_error",
      code: error.code || "gateway_error",
      details: error.details,
    },
  });
}

function logRequest({ requestId, method, path, status, startedAt, stream, model, error }) {
  const elapsedMs = Date.now() - startedAt;
  const fields = [`request=${requestId}`, method, `path=${path}`, `status=${status}`, `elapsed_ms=${elapsedMs}`];
  if (model) fields.push(`model=${model}`);
  if (stream !== undefined) fields.push(`stream=${stream}`);
  if (error) fields.push(`error=${error.code || error.message}`);
  console.log(fields.filter(Boolean).join(" "));
}
// #endregion

// #region 本地启动
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer(config);
  server.listen(config.port, () => {
    console.log(`AI Max Codex gateway listening on http://127.0.0.1:${config.port}`);
  });
}
// #endregion
