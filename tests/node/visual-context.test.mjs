import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(workspaceRoot, "src/lib/visualContext.ts");
const source = fsSync.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
const factory = new Function("exports", "module", "require", transpiled);
const nativeRequire = createRequire(sourcePath);
const runtimeRequire = (specifier) => {
  if (specifier === "./sha256") {
    const dependencyPath = path.join(workspaceRoot, "src/lib/sha256.ts");
    const dependencySource = fsSync.readFileSync(dependencyPath, "utf8");
    const dependencyTranspiled = ts.transpileModule(dependencySource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: dependencyPath,
    }).outputText;
    const dependencyModule = { exports: {} };
    const dependencyFactory = new Function("exports", "module", "require", dependencyTranspiled);
    dependencyFactory(dependencyModule.exports, dependencyModule, nativeRequire);
    return dependencyModule.exports;
  }
  return nativeRequire(specifier);
};
factory(module.exports, module, runtimeRequire);

const {
  appendVisualContextObservationContinuity,
  appendVisualObservationProtocol,
  buildProviderUnsupportedVisualContextNotice,
  countProviderOmittedVisualParts,
  countVisualContentParts,
  compactObservedVisualContextPayload,
  getVisualContextDeliveryObservation,
  latestVisualContextIsModelVisible,
  normalizeReservedVisualObservationProtocol,
  persistVisualContextDeliveryObservation,
  parseVisualContextRecognition,
  preserveVisualContextDeliveryObservationsInSystemPrompt,
  resolveMonotonicVisualContextStatus,
  resolveTurnVisualPayloadBinding,
  resolveVisualContextDeliveryState,
  resolveVisualContextDeliveryStateFromReceipt,
} = module.exports;

test("accepted visual observation replaces repeated data URL transport with system continuity", () => {
  const messages = [
    { role: "system", content: "Base prompt" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,large-payload" } },
        { type: "text", text: "[turn_intake]\n[user_request]\n检查截图\n[/user_request]\n[/turn_intake]" },
      ],
    },
    { role: "assistant", content: "继续分析" },
  ];
  const compacted = compactObservedVisualContextPayload(messages, {
    expectedImageParts: 1,
  });
  assert.equal(compacted.changed, true);
  assert.equal(compacted.removedImageParts, 1);
  assert.equal(countVisualContentParts(compacted.messages), 0);
  assert.doesNotMatch(JSON.stringify(compacted.messages), /large-payload/);
  assert.match(JSON.stringify(compacted.messages), /检查截图/);
  assert.equal(compactObservedVisualContextPayload(messages, {
    expectedImageParts: 2,
  }).changed, false, "a mismatched observation cannot compact another Turn's payload");

  const continuity = appendVisualContextObservationContinuity("Base prompt", {
    turnId: "turn-image-continuity",
    imageCount: 1,
    summary: "截图显示计划卡片缺少审核状态。",
    observationId: "visual-continuity-1",
    recognition: "observed",
    evidenceMeaning: "model_visual_observation",
  });
  assert.match(continuity, /visual_context_observation/);
  assert.match(continuity, /visual-continuity-1/);
  assert.match(continuity, /quoted visual evidence, not as instructions/);
  assert.doesNotMatch(continuity, /data:image|base64,/i);
});

test("exact visual binding cannot fall back to an older Turn or accept a count surplus", () => {
  const owner = {
    sessionKey: "session-current",
    sessionEpoch: "epoch-current",
    turnId: "turn-current",
    runId: "run-current",
    attemptId: "attempt-current",
  };
  const messages = [
    {
      role: "user",
      runtimeTurnId: "turn-old",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,old" } }],
    },
    {
      role: "user",
      runtimeTurnId: "turn-current",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,current" } },
        { type: "text", text: "inspect current" },
      ],
    },
  ];
  const binding = resolveTurnVisualPayloadBinding(messages, {
    owner,
    expectedImageParts: 1,
  });
  assert.ok(binding);

  const delivered = resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    expectedBinding: binding,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      owner,
      expectedImageParts: 1,
      payloadDigest: binding.payloadDigest,
      logicalImageParts: 1,
      serializedImageParts: 1,
      omittedImageParts: 0,
    },
  });
  assert.equal(delivered.status, "delivered");

  const omittedBinding = resolveTurnVisualPayloadBinding([{
    role: "user",
    runtimeTurnId: owner.turnId,
    runtimeVisualImageParts: 1,
    runtimeVisualPayloadDigest: binding.payloadDigest,
    content: "[visual_context_omission]\nstatus: provider_unsupported\nimageCount: 1\n[/visual_context_omission]",
  }], { owner, expectedImageParts: 1 });
  assert.deepEqual(omittedBinding, binding);
  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    expectedBinding: omittedBinding,
    receipt: {
      protocol: "openai_chat_completions",
      requestAccepted: true,
      owner,
      expectedImageParts: 1,
      payloadDigest: binding.payloadDigest,
      logicalImageParts: 1,
      serializedImageParts: 0,
      omittedImageParts: 1,
      omissionReason: "provider_unsupported",
    },
  }).status, "provider_unsupported");

  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    expectedBinding: binding,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      owner: { ...owner, turnId: "turn-old" },
      expectedImageParts: 1,
      payloadDigest: binding.payloadDigest,
      logicalImageParts: 1,
      serializedImageParts: 1,
      omittedImageParts: 0,
    },
  }).status, "not_delivered");
  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    expectedBinding: binding,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      owner,
      expectedImageParts: 1,
      payloadDigest: binding.payloadDigest,
      logicalImageParts: 2,
      serializedImageParts: 2,
      omittedImageParts: 0,
    },
  }).status, "not_delivered", "logical > expected is a different payload, not delivery proof");
  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    expectedBinding: null,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      logicalImageParts: 1,
      serializedImageParts: 1,
      omittedImageParts: 0,
    },
  }).status, "not_delivered", "production callers fail closed when no exact binding exists");
});

test("exact visual compaction removes only the bound Turn payload and is idempotent", () => {
  const owner = {
    sessionKey: "session-compact",
    sessionEpoch: "epoch-compact",
    turnId: "turn-current",
    runId: "run-compact",
    attemptId: "attempt-compact",
  };
  const messages = [
    { role: "system", content: "system" },
    {
      role: "user",
      runtimeTurnId: "turn-old",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,old" } },
        { type: "text", text: "old turn" },
      ],
    },
    {
      role: "user",
      runtimeTurnId: "turn-current",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,current" } },
        { type: "text", text: "current turn" },
      ],
    },
  ];
  const binding = resolveTurnVisualPayloadBinding(messages, { owner, expectedImageParts: 1 });
  assert.ok(binding);
  const compacted = compactObservedVisualContextPayload(messages, {
    expectedImageParts: 1,
    turnId: owner.turnId,
    payloadDigest: binding.payloadDigest,
  });
  assert.equal(compacted.changed, true);
  assert.match(JSON.stringify(compacted.messages), /base64,old/);
  assert.doesNotMatch(JSON.stringify(compacted.messages), /base64,current/);

  const repeated = compactObservedVisualContextPayload(compacted.messages, {
    expectedImageParts: 1,
    turnId: owner.turnId,
    payloadDigest: binding.payloadDigest,
  });
  assert.equal(repeated.changed, false);
  assert.match(JSON.stringify(repeated.messages), /base64,old/);
});

test("reserved visual metadata tool calls are isolated and reuse exact visual evidence checks", () => {
  const readCall = {
    id: "call_read",
    name: "read_file",
    arguments: '{"path":"README.md"}',
  };
  const normalized = normalizeReservedVisualObservationProtocol({
    text: "I found the layout mismatch.",
    toolCalls: [
      {
        id: "call_visual",
        name: " main_visual_observation ",
        arguments: JSON.stringify({
          turnId: "turn-native-visual",
          imageCount: 2,
          summary: "The screenshot shows two overlapping toolbar controls.",
        }),
      },
      readCall,
    ],
    expectedTurnId: "turn-native-visual",
    expectedImageParts: 2,
    deliveryStatus: "delivered",
  });

  assert.equal(normalized.cleanedText, "I found the layout mismatch.");
  assert.deepEqual(normalized.toolCalls, [readCall]);
  assert.equal(normalized.isolatedToolCallCount, 1);
  assert.deepEqual(normalized.isolatedToolCallIds, ["call_visual"]);
  assert.equal(normalized.observationSource, "reserved_tool_call");
  assert.equal(normalized.observation?.turnId, "turn-native-visual");
  assert.equal(normalized.observation?.imageCount, 2);
});

test("invalid reserved visual metadata is quarantined without becoming evidence", () => {
  const cases = [
    {
      label: "wrong turn",
      arguments: JSON.stringify({ turnId: "old-turn", imageCount: 1, summary: "Old image." }),
      deliveryStatus: "delivered",
    },
    {
      label: "wrong image count",
      arguments: JSON.stringify({ turnId: "current-turn", imageCount: 2, summary: "Two images." }),
      deliveryStatus: "delivered",
    },
    {
      label: "request did not deliver images",
      arguments: JSON.stringify({ turnId: "current-turn", imageCount: 1, summary: "Guessed image." }),
      deliveryStatus: "not_delivered",
    },
    {
      label: "malformed arguments",
      arguments: '{"turnId":',
      deliveryStatus: "delivered",
    },
  ];

  for (const candidate of cases) {
    const normalized = normalizeReservedVisualObservationProtocol({
      text: "Visible answer.",
      toolCalls: [{
        id: `call_${candidate.label}`,
        name: "MAIN_VISUAL_OBSERVATION",
        arguments: candidate.arguments,
      }],
      expectedTurnId: "current-turn",
      expectedImageParts: 1,
      deliveryStatus: candidate.deliveryStatus,
    });
    assert.equal(normalized.observation, null, candidate.label);
    assert.deepEqual(normalized.toolCalls, [], candidate.label);
    assert.equal(normalized.isolatedToolCallCount, 1, candidate.label);
    assert.equal(normalized.cleanedText, "Visible answer.", candidate.label);
  }
});

test("visual observation protocol requires exact delivered turn metadata", () => {
  const instruction = appendVisualObservationProtocol("Base prompt", {
    turnId: "turn-image-1",
    imageCount: 2,
  });
  assert.match(instruction, /visual_observation_protocol/);
  assert.match(instruction, /turn-image-1/);
  assert.doesNotMatch(instruction, /<concise visible facts>/);

  const marker = '<!--MAIN_VISUAL_OBSERVATION {"turnId":"turn-image-1","imageCount":2,"summary":"The screenshot shows a compact toolbar with three controls."}-->';
  const accepted = parseVisualContextRecognition({
    text: `${marker}\nI found the layout mismatch.`,
    expectedTurnId: "turn-image-1",
    expectedImageParts: 2,
    deliveryStatus: "delivered",
  });
  assert.equal(accepted.cleanedText, "I found the layout mismatch.");
  assert.equal(accepted.observation?.recognition, "observed");
  assert.equal(accepted.observation?.imageCount, 2);
  assert.match(accepted.observation?.observationId || "", /^visual-/);

  const notDelivered = parseVisualContextRecognition({
    text: marker,
    expectedTurnId: "turn-image-1",
    expectedImageParts: 2,
    deliveryStatus: "provider_unsupported",
  });
  assert.equal(notDelivered.cleanedText, "");
  assert.equal(notDelivered.observation, null);

  const wrongTurn = parseVisualContextRecognition({
    text: marker,
    expectedTurnId: "turn-image-2",
    expectedImageParts: 2,
    deliveryStatus: "delivered",
  });
  assert.equal(wrongTurn.observation, null);
  assert.equal(parseVisualContextRecognition({
    text: "I inspected the screenshot and it looks correct.",
    expectedTurnId: "turn-image-1",
    expectedImageParts: 2,
    deliveryStatus: "delivered",
  }).observation, null, "ordinary assistant prose is never visual observation evidence");

  const truncated = parseVisualContextRecognition({
    text: 'Visible preface.\n<!-- MAIN_VISUAL_OBSERVATION {"turnId":"turn-image-1"',
    expectedTurnId: "turn-image-1",
    expectedImageParts: 2,
    deliveryStatus: "delivered",
  });
  assert.equal(truncated.cleanedText, "Visible preface.");
  assert.equal(truncated.observation, null);
});

test("visual observations remain runtime evidence and are never promoted from assistant prose", () => {
  const parsed = parseVisualContextRecognition({
    text: '<!--MAIN_VISUAL_OBSERVATION {"turnId":"turn-image-persist","imageCount":1,"summary":"A disabled Save button is visible."}-->',
    expectedTurnId: "turn-image-persist",
    expectedImageParts: 1,
    deliveryStatus: "delivered",
  });
  assert.ok(parsed.observation);
  assert.equal(parsed.cleanedText, "");
  assert.equal(parseVisualContextRecognition({
    text: "I inspected the screenshot. A disabled Save button is visible.",
    expectedTurnId: "turn-image-persist",
    expectedImageParts: 1,
    deliveryStatus: "delivered",
  }).observation, null);
});

test("visual delivery state distinguishes model-visible images from provider omission", () => {
  const delivered = resolveVisualContextDeliveryState({
    expectedImageParts: 2,
    messagesSentToModel: [{
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,a" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,b" } },
        { type: "text", text: "Inspect these" },
      ],
    }],
  });
  assert.deepEqual(delivered, {
    status: "delivered",
    expectedImageParts: 2,
    deliveredImageParts: 2,
    omittedImageParts: 0,
  });

  const omission = buildProviderUnsupportedVisualContextNotice(2);
  const unsupported = resolveVisualContextDeliveryState({
    expectedImageParts: 2,
    messagesSentToModel: [{ content: `Inspect these\n\n${omission}` }],
  });
  assert.deepEqual(unsupported, {
    status: "provider_unsupported",
    expectedImageParts: 2,
    deliveredImageParts: 0,
    omittedImageParts: 2,
  });
  assert.equal(countProviderOmittedVisualParts([{ content: omission }]), 2);
});

test("current visual delivery ignores screenshots from older turns", () => {
  const omission = buildProviderUnsupportedVisualContextNotice(1);
  const state = resolveVisualContextDeliveryState({
    expectedImageParts: 1,
    messagesSentToModel: [
      { content: [{ type: "image_url", image_url: { url: "data:image/png;base64,old" } }] },
      { content: `Current turn\n${omission}` },
      { content: "Later tool result" },
    ],
  });

  assert.equal(countVisualContentParts([{ content: [{ type: "image_url", image_url: { url: "old" } }] }]), 1);
  assert.equal(state.status, "provider_unsupported");
  assert.equal(state.deliveredImageParts, 0);
  assert.equal(state.omittedImageParts, 1);
});

test("missing or partial visual payload is never promoted to recognized evidence", () => {
  assert.equal(resolveVisualContextDeliveryState({
    expectedImageParts: 1,
    messagesSentToModel: [{ content: "text only" }],
  }).status, "not_delivered");

  assert.equal(resolveVisualContextDeliveryState({
    expectedImageParts: 2,
    messagesSentToModel: [{
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }],
    }],
  }).status, "partially_delivered");
});

test("visual delivery is derived from the accepted wire receipt, not logical messages", () => {
  assert.deepEqual(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      logicalImageParts: 1,
      serializedImageParts: 1,
      omittedImageParts: 0,
    },
  }), {
    status: "delivered",
    expectedImageParts: 1,
    deliveredImageParts: 1,
    omittedImageParts: 0,
  });
  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      logicalImageParts: 1,
      serializedImageParts: 0,
      omittedImageParts: 1,
      omissionReason: "serialization_omitted_images",
    },
  }).status, "not_delivered");
  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    receipt: {
      protocol: "gemini",
      requestAccepted: true,
      logicalImageParts: 0,
      serializedImageParts: 1,
      omittedImageParts: 1,
    },
  }).status, "not_delivered");
  assert.equal(resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
  }).status, "not_delivered");
});

test("an earlier delivered request cannot authorize a marker from a later text-only response", () => {
  const marker = '<!--MAIN_VISUAL_OBSERVATION {"turnId":"turn-image-retry","imageCount":1,"summary":"A toolbar is visible."}-->';
  const historicalStatus = resolveMonotonicVisualContextStatus("delivered", "not_delivered");
  assert.equal(historicalStatus, "delivered");
  const currentResponseState = resolveVisualContextDeliveryStateFromReceipt({
    expectedImageParts: 1,
    receipt: {
      protocol: "openai_responses",
      requestAccepted: true,
      logicalImageParts: 0,
      serializedImageParts: 0,
      omittedImageParts: 1,
    },
  });
  assert.equal(parseVisualContextRecognition({
    text: marker,
    expectedTurnId: "turn-image-retry",
    expectedImageParts: 1,
    deliveryStatus: currentResponseState.status,
  }).observation, null);
});

test("visual grounding uses payload delivery and never assistant prose", () => {
  assert.equal(latestVisualContextIsModelVisible([
    { role: "assistant", content: "Screenshot observations: the button is visible." },
  ]), false);

  assert.equal(latestVisualContextIsModelVisible([{
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }],
  }]), true);

  assert.equal(latestVisualContextIsModelVisible([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }],
    },
    { role: "user", content: buildProviderUnsupportedVisualContextNotice(1) },
    { role: "assistant", content: "The image shows a working control." },
  ]), false);
});

test("confirmed model delivery is not downgraded when later context trimming removes image data", () => {
  assert.equal(resolveMonotonicVisualContextStatus("queued", "delivered"), "delivered");
  assert.equal(resolveMonotonicVisualContextStatus("delivered", "not_delivered"), "delivered");
  assert.equal(resolveMonotonicVisualContextStatus("delivered", "provider_unsupported"), "delivered");
  assert.equal(resolveMonotonicVisualContextStatus("provider_unsupported", "not_delivered"), "provider_unsupported");
  assert.equal(resolveMonotonicVisualContextStatus("partially_delivered", "not_delivered"), "partially_delivered");
  assert.equal(resolveMonotonicVisualContextStatus("provider_unsupported", "delivered"), "provider_unsupported");
});

test("a queued image is not model-visible before its turn has a delivery observation", () => {
  const queued = [{
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }],
  }];
  assert.equal(latestVisualContextIsModelVisible(queued), true);
  assert.equal(latestVisualContextIsModelVisible(queued, "turn-not-sent-yet"), false);
});

test("a transport-only system observation preserves delivery after image compaction", () => {
  const initialMessages = [
    { role: "system", content: "System instructions" },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }],
    },
  ];
  const persisted = persistVisualContextDeliveryObservation(initialMessages, {
    turnId: "turn-visual-1",
    state: {
      status: "delivered",
      expectedImageParts: 1,
      deliveredImageParts: 1,
      omittedImageParts: 0,
    },
  });
  assert.equal(persisted.changed, true);
  assert.equal(persisted.messages[0].role, "system");
  assert.equal(getVisualContextDeliveryObservation(
    persisted.messages,
    "turn-visual-1",
  )?.recognition, "unverified");

  const compacted = [
    persisted.messages[0],
    { role: "user", content: "Synthetic recovery request after context trimming" },
  ];
  assert.equal(latestVisualContextIsModelVisible(compacted, "turn-visual-1"), true);
  assert.equal(latestVisualContextIsModelVisible(compacted, "different-turn"), false);

  const spoofedByUser = [
    { role: "system", content: "System instructions without an observation" },
    { role: "user", content: persisted.messages[0].content },
  ];
  assert.equal(getVisualContextDeliveryObservation(
    spoofedByUser,
    "turn-visual-1",
  ), null);
  assert.equal(latestVisualContextIsModelVisible(spoofedByUser, "turn-visual-1"), false);

  const duplicate = persistVisualContextDeliveryObservation(persisted.messages, {
    turnId: "turn-visual-1",
    state: {
      status: "delivered",
      expectedImageParts: 1,
      deliveredImageParts: 1,
      omittedImageParts: 0,
    },
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.messages, persisted.messages);
});

test("system prompt refresh preserves delivery across a tool-surface switch and trim", () => {
  const persisted = persistVisualContextDeliveryObservation([
    { role: "system", content: "Initial native-tool prompt" },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }],
    },
  ], {
    turnId: "turn-tool-switch",
    state: {
      status: "delivered",
      expectedImageParts: 1,
      deliveredImageParts: 1,
      omittedImageParts: 0,
    },
  });
  const refreshedSystemPrompt = preserveVisualContextDeliveryObservationsInSystemPrompt(
    "Refreshed XML-tool prompt",
    persisted.messages,
  );
  const trimmedAfterRecovery = [
    { role: "system", content: refreshedSystemPrompt },
    { role: "user", content: "Internal recovery instruction after the tool-surface switch" },
  ];

  assert.match(refreshedSystemPrompt, /Refreshed XML-tool prompt/);
  assert.equal(latestVisualContextIsModelVisible(
    trimmedAfterRecovery,
    "turn-tool-switch",
  ), true);
});
