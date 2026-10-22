import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const root = process.cwd();
function loadStreaming(invoke, listen, entry = 'src/lib/streaming.ts') {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const localRequire = createRequire(file); const module = { exports: {} }; cache.set(file, module.exports);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file }).outputText;
    new Function('exports', 'module', 'require', output)(module.exports, module, (name) => {
      if (name === '@tauri-apps/api/core') return { invoke };
      if (name === '@tauri-apps/api/event') return { listen };
      return name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : localRequire(name);
    });
    return module.exports;
  }
  return load(path.join(root, entry));
}
const messages = [{ role: 'system', content: 'Return a JSON object only.' }, { role: 'user', content: 'Inspect the requested operation.' }];
const settings = { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', model: 'fixture', provider: 'OMLX', apiProtocol: 'openai', useRustProxy: true };
async function nativeRequest({ settings: overrides = {}, responseFormat = { type: 'json_object' }, tools = [], fail, afterOutput = false, hidden = false, abort = false, content = '{"ok":true}', tolerateError = false } = {}) {
  const bodies = []; const listeners = new Map(); const errors = []; const lifecycle = []; let done = 0; const controller = new AbortController();
  const api = loadStreaming(async (name, args) => {
    if (name === 'cancel_chat_stream') return;
    assert.equal(name, 'start_chat_stream'); bodies.push(JSON.parse(args.body));
    const failure = fail?.(bodies.length);
    queueMicrotask(() => {
      if (abort) controller.abort();
      if (failure && !afterOutput) { listeners.get('chat-stream-done')?.({ payload: { stream_id: args.streamId, status: 'error', error: failure } }); return; }
      const chunk = overrides.provider === 'Ollama' ? JSON.stringify({ message: { content }, done: true, done_reason: 'stop' }) + '\n'
        : 'data: ' + JSON.stringify({ choices: [{ delta: hidden ? { reasoning_content: 'hidden progress' } : { content }, finish_reason: failure ? null : 'stop' }] }) + '\n\n';
      listeners.get('chat-stream-chunk')?.({ payload: { stream_id: args.streamId, chunk } });
      listeners.get('chat-stream-done')?.({ payload: { stream_id: args.streamId, status: failure ? 'error' : 'success', ...(failure ? { error: failure } : {}) } });
    });
  }, async (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); });
  let result; let error;
  try { result = await api.streamChatCompletion(messages, { ...settings, ...overrides }, { onToken() {}, onDone() { done++; }, onError(error) { errors.push(error.message); }, onLifecycle(event) { lifecycle.push(event); } }, controller.signal, tools, 512, { responseFormat, reasoningOnlyCharLimit: null, contextOwnership: 'caller' }); }
  catch (caught) { if (!tolerateError) throw caught; error = caught; }
  return { bodies, errors, done, result, error, api, listeners, lifecycle };
}
test('native OpenAI-compatible request carries the caller JSON output contract', async () => {
  const { bodies, result } = await nativeRequest();
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.deepEqual(bodies[0].messages, messages); assert.equal(bodies[0].max_tokens, 512); assert.equal(result.content, '{"ok":true}');
});
test('native Ollama maps JSON mode to its format string', async () => {
  const { bodies } = await nativeRequest({ settings: { provider: 'Ollama', baseUrl: 'http://127.0.0.1:11434' } });
  assert.equal(bodies[0].format, 'json'); assert.equal(bodies[0].options.num_predict, 512); assert.equal(bodies[0].response_format, undefined);
});
test('adapter advertises JSON options without widening unsupported cloud protocols', async () => {
  const api = loadStreaming(async () => {}, async () => () => {});
  assert.deepEqual(api.resolveJsonObjectOutputOptions(settings), { responseFormat: { type: 'json_object' } });
  for (const apiProtocol of ['anthropic', 'gemini']) assert.deepEqual(api.resolveJsonObjectOutputOptions({ ...settings, apiProtocol }), {});
});

test('native optional format rejection retries once without leaking a failed terminal callback', async () => {
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read source', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  const { bodies, errors, done, lifecycle, listeners } = await nativeRequest({ tools, fail: (n) => n === 1 ? 'HTTP 400: unsupported parameter response_format' : null });
  assert.equal(bodies.length, 2); const { response_format, ...first } = bodies[0]; assert.deepEqual(response_format, { type: 'json_object' });
  assert.deepEqual(bodies[1], first, 'only the optional format constraint changes; messages, tools, budget and reasoning remain exact');
  assert.equal(bodies[1].tools[0].function.name, 'read_file');
  assert.deepEqual(errors, []); assert.equal(done, 1); assert.equal(lifecycle.filter(x => x.phase === 'stream_error').length, 0); assert.equal(listeners.size, 0);
});
test('native format fallback does not repeat and final errors are delivered once', async () => {
  const r = await nativeRequest({ fail: () => 'HTTP 422: unsupported response_format', tolerateError: true });
  assert.equal(r.bodies.length, 2); assert.equal(r.errors.length, 1); assert.equal(r.done, 0); assert.equal(r.listeners.size, 0);
});
test('invalid schema, unrelated HTTP errors and interrupted streams never withdraw the format contract', async () => {
  for (const message of ['HTTP 400: invalid schema in response_format', 'HTTP 400: invalid_json_schema for response_format', 'HTTP 400: messages invalid', 'HTTP 400: messages contain unsupported role; response_format=json_object', 'HTTP 400: response_format.json_schema uses unsupported keyword anyOf', 'HTTP 500: response_format unsupported', 'HTTP 500: backend error 400 response_format unsupported', 'stream interrupted response_format unsupported']) {
    const r = await nativeRequest({ fail: () => message, tolerateError: true });
    assert.equal(r.bodies.length, 1, message); assert.equal(r.errors.length, 1); assert.equal(r.done, 0);
  }
});
test('visible output, hidden output and cancellation all fence optional-format retries', async () => {
  for (const options of [{ afterOutput: true }, { afterOutput: true, hidden: true }, { abort: true }]) {
    const r = await nativeRequest({ ...options, fail: () => 'HTTP 400: response_format is not supported', tolerateError: true });
    assert.equal(r.bodies.length, 1); assert.equal(r.errors.length, 1); assert.equal(r.done, 0); assert.equal(r.listeners.size, 0);
  }
});
test('a successful prose response is returned to the original strict validator without transport retry', async () => {
  const r = await nativeRequest({ content: 'unstructured prose' });
  assert.equal(r.result.content, 'unstructured prose'); assert.equal(r.bodies.length, 1); assert.equal(r.done, 1);
});
test('calls without a formatting request retain the original error path', async () => {
  const r = await nativeRequest({ responseFormat: null, fail: () => 'HTTP 400: response_format unsupported', tolerateError: true });
  assert.equal(r.bodies.length, 1); assert.equal(r.bodies[0].response_format, undefined); assert.equal(r.errors.length, 1);
});
test('Ollama schema formatting unwraps the OpenAI envelope instead of sending it as a schema', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const r = await nativeRequest({ settings: { provider: 'Ollama', baseUrl: 'http://127.0.0.1:11434' }, responseFormat: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } } });
  assert.deepEqual(r.bodies[0].format, schema);
});

test('Responses wire maps JSON formatting and preserves an explicit output cap across compatibility fallback', async () => {
  const bodies = []; const errors = []; let done = 0;
  const api = loadStreaming(async (name, args) => {
    assert.equal(name, 'proxy_request'); const body = JSON.parse(args.body); bodies.push(body);
    if (bodies.length === 1) throw new Error('HTTP 400: unsupported parameter text.format');
    return JSON.stringify({ status: 'completed', output_text: '{"ok":true}' });
  }, async () => () => {});
  const result = await api.streamChatCompletion(messages, { ...settings, apiFormat: 'responses' }, { onToken() {}, onDone() { done++; }, onError(error) { errors.push(error.message); } }, undefined, [], 512, { responseFormat: { type: 'json_object' }, contextOwnership: 'caller' });
  assert.equal(result.content, '{"ok":true}'); assert.equal(bodies.length, 2); assert.deepEqual(bodies[0].text, { format: { type: 'json_object' } });
  assert.equal(bodies[0].max_output_tokens, 512); assert.equal(bodies[1].max_output_tokens, 512);
  const { text, ...first } = bodies[0]; assert.deepEqual(bodies[1], first); assert.equal(done, 1); assert.deepEqual(errors, []);
});
test('Responses schema mapping unwraps the envelope and leaves a missing explicit cap unchanged', async () => {
  const bodies = [];
  const api = loadStreaming(async (_name, args) => { bodies.push(JSON.parse(args.body)); return JSON.stringify({ output_text: '{"ok":true}' }); }, async () => () => {});
  const json_schema = { name: 'result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
  await api.streamChatCompletion(messages, { ...settings, apiFormat: 'responses' }, { onToken() {}, onDone() {}, onError() {} }, undefined, [], undefined, { responseFormat: { type: 'json_schema', json_schema } });
  assert.deepEqual(bodies[0].text.format, { type: 'json_schema', ...json_schema }); assert.equal(bodies[0].max_output_tokens, undefined);
});
test('frontend OpenAI and Ollama sends the same protocol-specific formatting contract', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const provider of ['OMLX', 'Ollama']) {
      const bodies = [];
      globalThis.fetch = async (_url, options) => {
        bodies.push(JSON.parse(options.body)); const data = provider === 'Ollama' ? JSON.stringify({ message: { content: '{"ok":true}' }, done: true, done_reason: 'stop' }) + '\n'
          : 'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) + '\n\n';
        return new Response(data, { status: 200 });
      };
      const api = loadStreaming(async () => { throw new Error('unexpected native request'); }, async () => () => {});
      await api.streamChatCompletion(messages, { ...settings, provider, useRustProxy: false }, { onToken() {}, onDone() {}, onError(error) { throw error; } }, undefined, [], 512, { responseFormat: { type: 'json_object' } });
      if (provider === 'Ollama') assert.equal(bodies[0].format, 'json'); else assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
    }
  } finally { globalThis.fetch = originalFetch; }
});
test('actual preflight preserves JSON mode and approval semantics through a native format compatibility retry', async () => {
  const listeners = new Map(); const bodies = [];
  const semantic = { semantic: { objective: 'Run pwd after individual approval', workType: 'operate', answerFormat: 'report', requiredCapabilities: ['workspace_read', 'command'], forbiddenCapabilities: [] }, confidence: 0.98, needsUserChoice: false };
  const api = loadStreaming(async (name, args) => {
    assert.equal(name, 'start_chat_stream'); bodies.push(JSON.parse(args.body));
    if (bodies.length === 1) {
      queueMicrotask(() => listeners.get('chat-stream-done')?.({ payload: { stream_id: args.streamId, status: 'error', error: 'HTTP 400: unsupported parameter response_format' } }));
      return;
    }
    queueMicrotask(() => {
      listeners.get('chat-stream-chunk')?.({ payload: { stream_id: args.streamId, chunk: 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(semantic) }, finish_reason: 'stop' }] }) + '\n\n' } });
      listeners.get('chat-stream-done')?.({ payload: { stream_id: args.streamId, status: 'success' } });
    });
  }, async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); }, 'src/lib/intentPreflight.ts');
  const result = await api.runIntentPreflight({ input: 'Run pwd only after its individual approval.', language: 'en', mainModeKey: 'main_mode', hasWorkspace: true, config: { activeProfile: 'local', local: { endpoint: 'http://127.0.0.1:8000/v1', model: 'fixture', provider: 'OMLX' } } });
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[0].response_format, { type: 'json_object' }); assert.equal(bodies[1].response_format, undefined);
  for (const body of bodies) { assert.equal(body.messages.length, 2); assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 512); }
  assert.equal(result.intent, 'execute'); assert.equal(result.requiresApproval, true); assert.equal(result.approved, undefined); assert.equal(result.commandDirective.exactCommand, undefined);
});

test('frontend format compatibility retries only the rejected field and reports one terminal outcome', async () => {
  const originalFetch = globalThis.fetch; const bodies = []; const errors = []; let done = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) return new Response('unsupported parameter response_format', { status: 422 });
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) + '\n\n', { status: 200 });
    };
    const api = loadStreaming(async () => { throw new Error('unexpected native fallback'); }, async () => () => {});
    await api.streamChatCompletion(messages, { ...settings, useRustProxy: false }, { onToken() {}, onDone() { done++; }, onError(error) { errors.push(error.message); } }, undefined, [], 512, { responseFormat: { type: 'json_object' }, contextOwnership: 'caller' });
    assert.equal(bodies.length, 2); const { response_format, ...first } = bodies[0]; assert.deepEqual(bodies[1], first); assert.equal(done, 1); assert.deepEqual(errors, []);
  } finally { globalThis.fetch = originalFetch; }
});
test('non-streaming compatibility Chat sends the requested output format', async () => {
  const bodies = [];
  const api = loadStreaming(async (name, args) => { assert.equal(name, 'proxy_request'); bodies.push(JSON.parse(args.body)); return JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }); }, async () => () => {});
  await api.streamChatCompletion([{ role: 'system', content: '[PROVIDER_COMPATIBILITY_MODE] transcript_mode=true' }, ...messages], settings, { onToken() {}, onDone() {}, onError(error) { throw error; } }, undefined, [], 512, { responseFormat: { type: 'json_object' } });
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' }); assert.equal(bodies[0].stream, false);
});

test('actual preflight Responses wire keeps a long current request complete with the same explicit cap', async () => {
  const bodies = []; const input = 'Only run the requested command after approval. '.repeat(200) + 'CURRENT_REQUEST_TAIL_SENTINEL';
  const semantic = { semantic: { objective: 'Inspect after approval', workType: 'operate', answerFormat: 'report', requiredCapabilities: ['command'], forbiddenCapabilities: [] }, confidence: 0.95, needsUserChoice: false };
  const api = loadStreaming(async (name, args) => { assert.equal(name, 'proxy_request'); bodies.push(JSON.parse(args.body)); return JSON.stringify({ status: 'completed', output_text: JSON.stringify(semantic) }); }, async () => () => {}, 'src/lib/intentPreflight.ts');
  const result = await api.runIntentPreflight({ input, language: 'en', mainModeKey: 'main_mode', hasWorkspace: true, config: { activeProfile: 'cloud', cloud: { endpoint: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture', protocol: 'openai', apiFormat: 'responses' } } });
  assert.equal(result.intent, 'execute'); assert.equal(result.requiresApproval, true); assert.equal(bodies.length, 1);
  assert.equal(bodies[0].max_output_tokens, 512); assert.deepEqual(bodies[0].text.format, { type: 'json_object' });
  const user = bodies[0].input.find(x => x.role === 'user'); const content = typeof user.content === 'string' ? user.content : user.content.map(x => x.text || '').join('');
  assert.equal(JSON.parse(content).currentRequest, input); assert.doesNotMatch(content, /CONTEXT MEMORY|memory summary|truncated/i); assert.equal(bodies[0].tools, undefined);
});
