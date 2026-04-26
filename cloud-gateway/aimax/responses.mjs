import { randomUUID } from "node:crypto";

// #region Responses 对象构造
export function createResponseId() {
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

export function createOutputItemId() {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

export function createTextContent(text) {
  return [{ type: "output_text", text, annotations: [] }];
}

export function createCompletedResponse({ id = createResponseId(), model, text, createdAt = Math.floor(Date.now() / 1000) }) {
  const outputItemId = createOutputItemId();
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [{
      id: outputItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: createTextContent(text),
    }],
    output_text: text,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "none",
    tools: [],
    top_p: null,
  };
}

export function createErrorBody(error) {
  return {
    error: {
      message: error?.message || "Gateway error",
      type: error?.code || "gateway_error",
      code: error?.code || "gateway_error",
      details: error?.details,
    },
  };
}
// #endregion

// #region SSE 事件输出
export function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeResponseCreated(res, { id, model, createdAt }) {
  writeSse(res, "response.created", {
    id,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [],
  });
}

export function writeTextDelta(res, { responseId, outputIndex = 0, contentIndex = 0, delta }) {
  writeSse(res, "response.output_text.delta", {
    type: "response.output_text.delta",
    response_id: responseId,
    output_index: outputIndex,
    content_index: contentIndex,
    delta,
  });
}

export function writeTextDone(res, { responseId, outputIndex = 0, contentIndex = 0, text }) {
  writeSse(res, "response.output_text.done", {
    type: "response.output_text.done",
    response_id: responseId,
    output_index: outputIndex,
    content_index: contentIndex,
    text,
  });
}

export function writeResponseCompleted(res, { id, model, text, createdAt }) {
  writeSse(res, "response.completed", createCompletedResponse({ id, model, text, createdAt }));
}

export function writeResponseError(res, error) {
  writeSse(res, "error", createErrorBody(error));
}
// #endregion
