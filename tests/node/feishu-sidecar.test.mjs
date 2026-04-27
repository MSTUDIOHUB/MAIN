import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = process.cwd();
const sidecarUrl = pathToFileURL(path.join(workspaceRoot, "scripts/feishu_adapter_sidecar.mjs")).href;
const {
  buildFeishuSendAttempts,
  formatFeishuError,
  sendText,
} = await import(sidecarUrl);

test("builds Feishu send attempts with chat, open id, then reply fallback", () => {
  assert.deepEqual(
    buildFeishuSendAttempts({ chatId: "oc_1", userId: "ou_1", messageId: "om_1" }),
    [
      { method: "create", receiveIdType: "chat_id", receiveId: "oc_1", label: "chat_id:oc_1" },
      { method: "create", receiveIdType: "open_id", receiveId: "ou_1", label: "open_id:ou_1" },
      { method: "reply", messageId: "om_1", label: "reply:om_1" },
    ],
  );
});

test("sendText falls back from chat_id 400 to open_id without emitting adapter error", async () => {
  const calls = [];
  const events = [];
  const mockClient = {
    im: {
      v1: {
        message: {
          create: async (payload) => {
            calls.push(payload);
            if (payload.params.receive_id_type === "chat_id") {
              const error = new Error("Request failed with status code 400");
              error.response = {
                status: 400,
                data: { code: 99991672, msg: "bad receive_id" },
                headers: { "x-tt-logid": "req_1" },
              };
              throw error;
            }
            return { data: { message_id: "om_sent" } };
          },
          reply: async (payload) => {
            calls.push(payload);
            return { data: { message_id: "om_reply" } };
          },
        },
      },
    },
  };

  await sendText(
    { chatId: "oc_bad", userId: "ou_good", messageId: "om_original" },
    "hello",
    mockClient,
    (event) => events.push(event),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.receive_id_type, "chat_id");
  assert.equal(calls[1].params.receive_id_type, "open_id");
  assert.equal(calls[1].data.receive_id, "ou_good");
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.some((event) => event.type === "status" && event.sendError), false);
});

test("formatFeishuError includes response body and request id", () => {
  const error = new Error("Request failed with status code 400");
  error.response = {
    status: 400,
    data: { code: 99991672, msg: "bad receive_id" },
    headers: { "x-tt-logid": "req_1" },
  };

  const formatted = formatFeishuError(error);
  assert.match(formatted, /status=400/);
  assert.match(formatted, /req_1/);
  assert.match(formatted, /bad receive_id/);
});
