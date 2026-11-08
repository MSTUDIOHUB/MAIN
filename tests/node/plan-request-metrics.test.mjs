import test from 'node:test';
import assert from 'node:assert/strict';
import { createTsModuleLoader } from './tsModuleLoader.mjs';
const load = createTsModuleLoader();
const { planRequestMetrics } = load('src/store/runtimeV2/planRequestMetrics.ts');
const { estimateMessagesTokens, estimateTokens } = load('src/lib/contextTrim.ts');

test('plan request metrics account for repeated submission arguments and declaration schemas', () => {
  const call = { id: 'submit', type: 'function', function: { name: 'submit_runtime_v2_work_plan', arguments: JSON.stringify({ planMarkdown: 'PRIVATE_PLAN_BODY'.repeat(100) }) } };
  const messages = [{ role: 'user', content: 'Objective' }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: 'submit', content: 'WORK_PLAN_REJECTED' }];
  const tools = [{ type: 'function', function: { name: 'submit_runtime_v2_work_plan', parameters: { type: 'object' } } }];
  const responseFormat = { type: 'json_schema', json_schema: { name: 'plan' } };
  const result = planRequestMetrics({ messages, tools, responseFormat });
  assert.equal(result.promptChars, 'ObjectiveWORK_PLAN_REJECTED'.length, 'retain the legacy content-only metric');
  assert.equal(result.promptCharsScope, 'message_content_only');
  assert.equal(result.promptToolArgumentChars, call.function.arguments.length);
  assert.equal(result.promptToolCallChars, JSON.stringify([call]).length);
  assert.equal(result.promptSerializedMessageChars, JSON.stringify(messages).length);
  assert.equal(result.toolSchemaChars, JSON.stringify(tools).length);
  assert.equal(result.responseSchemaChars, JSON.stringify(responseFormat).length);
  assert.equal(result.estimatedInputTokens, estimateMessagesTokens(messages) + estimateTokens(JSON.stringify(tools)) + estimateTokens(JSON.stringify(responseFormat)));
  const next = planRequestMetrics({ messages: [...messages, messages[1], messages[2]], tools });
  assert.ok(next.estimatedInputTokens > planRequestMetrics({ messages, tools }).estimatedInputTokens + 500);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PLAN_BODY|Objective|WORK_PLAN_REJECTED/);
});

test('text envelope declaration content is counted once and absent native schemas cost no tokens', () => {
  const messages = [{ role: 'system', content: '<tool-catalog>read_file</tool-catalog>' }];
  const result = planRequestMetrics({ messages, tools: [] });
  assert.equal(result.toolSchemaChars, 0);
  assert.equal(result.responseSchemaChars, 0);
  assert.equal(result.estimatedInputTokens, estimateMessagesTokens(messages));
});
