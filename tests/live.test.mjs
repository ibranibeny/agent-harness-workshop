import test from 'node:test';
import assert from 'node:assert/strict';

test('LIVE: Foundry returns a real tool call and consumes its real result', { timeout: 180_000 }, async () => {
  const { createModel } = await import('../src/model.mjs');
  const model = createModel();
  const messages = [{ role: 'user', content: 'Call add_numbers with left=17 and right=25. After the tool result, answer only the numeric result.' }];
  const tools = [{ type: 'function', function: {
    name: 'add_numbers', description: 'Add two numbers using local JavaScript.', strict: true,
    parameters: { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } }, required: ['left', 'right'], additionalProperties: false },
  } }];
  const first = await model.complete(messages, tools);
  const call = first.message.tool_calls?.[0];
  assert.equal(call?.function.name, 'add_numbers');
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.left + args.right, 42);
  messages.push(first.message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result: args.left + args.right }) });
  const second = await model.complete(messages, tools);
  assert.match(second.message.content, /42/);
  assert.ok(first.usage.total_tokens > 0);
  console.log(JSON.stringify({ evidence: 'REAL_FOUNDRY', account: model.identity.account, tenant: model.identity.tenantId, requestIds: [first.requestId, second.requestId], responseIds: [first.id, second.id], model: first.model, tool: call.function.name, answer: second.message.content, tokens: first.usage.total_tokens + second.usage.total_tokens }));
});