import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

test('identity guard accepts only the configured account and tenant', async () => {
  const { validateIdentity } = await import('../src/model.mjs');
  const expected = { tenantId: 'tenant-workshop', account: 'learner@example.com' };
  assert.deepEqual(validateIdentity({ tid: expected.tenantId, upn: expected.account }, expected), {
    tenantId: expected.tenantId, account: expected.account,
  });
  assert.throws(() => validateIdentity({ tid: 'wrong', upn: expected.account }, expected), /tenant/i);
  assert.throws(() => validateIdentity({ tid: expected.tenantId, upn: 'another@example.com' }, expected), /account/i);
  assert.throws(() => validateIdentity({ tid: expected.tenantId }, expected), /account/i);
});

test('model pacing uses the verified Sol request and token limits', async () => {
  const { requestSpacing } = await import('../src/model.mjs');
  const { config } = await import('../src/config.mjs');
  assert.equal(config.requestsPerMinute, 50);
  assert.equal(config.tokensPerMinute, 50000);
  assert.equal(requestSpacing(1000), 1700);
  assert.equal(requestSpacing(14896), 17876);
  assert.equal(requestSpacing(25000), 30000);
  assert.equal(requestSpacing(50000), 60000);
});

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const documentsDir = path.join(directory, 'docs');
  await mkdir(documentsDir);
  await writeFile(path.join(documentsDir, 'brief.md'), 'Local workshop for 20 participants.');
  const { createTools } = await import('../src/tools.mjs');
  return { directory, tools: createTools({ documentsDir, dataDir: directory, runId: 'test-run', memoryEnabled: true }) };
}

const toolCall = (name, args = {}) => ({ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('travel research uses the configured WebIQ connector and never substitutes sample results', async context => {
  const { directory, tools: unconfigured } = await fixture(context);
  const { createTools } = await import('../src/tools.mjs');
  const requests = [];
  const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'travel-test', connectors: {
    webiq: { async callTool(name, args) {
      requests.push({ name, args });
      return { webResults: [{ title: 'Tourism test source', url: 'https://example.com/tourism', content: 'Contract test only.' }] };
    } },
  } });
  const result = await tools.execute(toolCall('search_destination', { destination: 'Singapore', interests: 'museums and public transport' }));
  assert.equal(requests[0].name, 'web');
  assert.match(requests[0].args.query, /Singapore/);
  assert.equal(result.provider, 'WebIQ');
  assert.equal(result.data.webResults[0].url, 'https://example.com/tourism');
  await assert.rejects(unconfigured.execute(toolCall('search_destination', { destination: 'Singapore', interests: 'museums' })), /WebIQ.*connect/i);
  await assert.rejects(tools.execute(toolCall('search_destination', { destination: 'Singapore', interests: 'museums', url: 'http://localhost' })), /unrecognized/i);
});

const itinerary = {
  title: 'Singapore museum weekend', destination: 'Singapore', startDate: '2026-09-19', endDate: '2026-09-20', timeZone: 'Asia/Singapore',
  weather: 'Forecast not verified in this unit test.',
  days: [{ date: '2026-09-19', plan: 'Visit a museum using public transport.' }, { date: '2026-09-20', plan: 'Explore the city at a relaxed pace.' }],
  sources: [{ title: 'Test source', url: 'https://example.com/tourism' }],
};

test('Foundry tool schemas expose valid next actions without unsupported URI formats', async context => {
  const { directory } = await fixture(context);
  const { createTools } = await import('../src/tools.mjs');
  const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'schema-test', memoryEnabled: false, connectors: { sequential: {} } });
  assert.doesNotMatch(JSON.stringify(tools.definitions), /"format":"uri"/);
  const unsupported = ['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems'];
  JSON.parse(JSON.stringify(tools.definitions), (key, value) => {
    assert.ok(!unsupported.includes(key), `Unsupported model schema keyword: ${key}`);
    return value;
  });
  const planning = tools.definitions.find(tool => tool.function.name === 'sequential_thinking').function;
  assert.deepEqual(planning.parameters.properties.nextStep.enum, [...tools.definitions.map(tool => tool.function.name), 'reply']);
  assert.match(planning.description, /without a planning prerequisite/i);
  assert.ok(!planning.parameters.properties.nextStep.enum.includes('save_memory'));
  const local = createTools({ documentsDir: directory, dataDir: directory, runId: 'url-test' });
  await assert.rejects(local.execute(toolCall('export_itinerary_pdf', { ...itinerary, sources: [{ title: 'Invalid', url: 'ftp://example.com' }] }), { approve: async () => { assert.fail('Invalid URL must fail before approval.'); } }), /URL|protocol/i);
  await assert.rejects(local.execute(toolCall('send_itinerary_email', { recipient: 'not-an-email' }), { approve: async () => { assert.fail('Invalid recipient must fail before approval.'); } }), /email/i);
});

test('optional sequential planning still calls the actual local MCP server', async context => {
  const { directory } = await fixture(context);
  const { createSequentialThinking } = await import('../src/connectors.mjs');
  const sequential = createSequentialThinking();
  context.after(() => sequential.close());
  const { createTools } = await import('../src/tools.mjs');
  const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'planning-test', connectors: { sequential } });
  assert.equal(tools.requiresPlanning, false);
  await assert.rejects(tools.execute(toolCall('search_destination', { destination: 'Singapore', interests: 'museums' })), /WebIQ is not connected/i);
  const result = await tools.execute(toolCall('sequential_thinking', { summary: 'Plan: research the destination and dated weather, then prepare a sourced itinerary. No delivery is requested.', nextStep: 'search_destination', complete: false }));
  assert.equal(result.provider, 'Sequential Thinking MCP');
  assert.equal(result.data.thoughtNumber, 1);
  assert.equal(result.data.thoughtHistoryLength, 1);
  assert.equal(tools.planningComplete, true);
  const revised = await tools.execute(toolCall('sequential_thinking', { summary: 'Research connector unavailable. Report this limitation; do not invent travel facts.', nextStep: 'reply', complete: true }));
  assert.equal(revised.data.thoughtNumber, 2);
  assert.equal(revised.data.nextThoughtNeeded, false);
});

test('travel weather validates calendar dates and preserves forecast uncertainty', async context => {
  const { directory } = await fixture(context);
  const { createTools } = await import('../src/tools.mjs');
  const requests = [];
  const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'weather-test', connectors: {
    webiq: { async callTool(name, args) { requests.push(args); return { webResults: [] }; } },
  } });
  const result = await tools.execute(toolCall('search_weather', { destination: 'Singapore', startDate: '2026-09-19', endDate: '2026-09-20' }));
  assert.match(requests[0].query, /2026-09-19.*2026-09-20/);
  assert.equal(result.forecastVerified, false);
  assert.match(result.guidance, /seasonal/i);
  for (const dates of [['2026-02-30', '2026-03-01'], ['2026-09-20', '2026-09-19']]) {
    await assert.rejects(tools.execute(toolCall('search_weather', { destination: 'Singapore', startDate: dates[0], endDate: dates[1] })), /date|end/i);
  }
  assert.equal(requests.length, 1);
});

test('harness permits direct WebIQ research without a planning prerequisite', async context => {
  const { directory } = await fixture(context);
  const { createTools } = await import('../src/tools.mjs');
  const { runHarness } = await import('../src/harness.mjs');
  for (const [name, args] of [
    ['search_destination', { destination: 'Singapore', interests: 'museums' }],
    ['search_weather', { destination: 'Singapore', startDate: '2026-09-19', endDate: '2026-09-20' }],
  ]) {
    let searches = 0;
    let calls = 0;
    const events = [];
    const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'direct-search', memoryEnabled: false, connectors: {
      sequential: { record() { assert.fail('Simple research must not need planning.'); } },
      webiq: { async callTool(tool, input) { searches++; assert.equal(tool, 'web'); assert.match(input.query, /Singapore/); return { webResults: [] }; } },
    } });
    const result = await runHarness({ tools, prompt: `Use ${name} for Singapore.`, emit: async event => events.push(event), model: { async complete(messages, definitions, options) {
      calls++;
      assert.ok(definitions.some(tool => tool.function.name === name));
      assert.ok(definitions.some(tool => tool.function.name === 'sequential_thinking'));
      assert.equal(options.toolChoice, undefined);
      if (calls === 1) return { message: { role: 'assistant', tool_calls: [toolCall(name, args)] } };
      assert.equal(JSON.parse(messages.at(-1).content).provider, 'WebIQ');
      return { message: { role: 'assistant', content: 'No verified results available.' } };
    } } });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(searches, 1);
    assert.equal(events.find(event => event.type === 'model_request').planningRequired, false);
  }
});

test('harness supports optional planning and direct clarification', async context => {
  const { directory } = await fixture(context);
  const { createSequentialThinking } = await import('../src/connectors.mjs');
  const { createTools } = await import('../src/tools.mjs');
  const { runHarness } = await import('../src/harness.mjs');
  const sequential = createSequentialThinking();
  context.after(() => sequential.close());
  const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'optional-plan', connectors: { sequential } });
  let calls = 0;
  const model = { async complete(messages, definitions, options) {
    calls++;
    if (calls === 1) {
      assert.ok(definitions.some(tool => tool.function.name === 'sequential_thinking'));
      assert.ok(definitions.some(tool => tool.function.name === 'search_weather'));
      assert.equal(options.toolChoice, undefined);
      assert.match(messages[0].content, /Sequential Thinking MCP is optional/);
      return { message: { role: 'assistant', tool_calls: [toolCall('sequential_thinking', { summary: 'Missing destination and trip dates. Ask for these before researching.', nextStep: 'reply', complete: true })] } };
    }
    assert.ok(definitions.some(tool => tool.function.name === 'search_destination'));
    assert.equal(options.toolChoice, undefined);
    return { message: { role: 'assistant', content: 'Which destination and travel dates?' } };
  } };
  const result = await runHarness({ model, tools, prompt: 'Plan my trip.', maxSteps: 3 });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  const unplannedTools = createTools({ documentsDir: directory, dataDir: directory, runId: 'direct-reply', connectors: { sequential } });
  const clarification = await runHarness({ model: { async complete() { return { message: { role: 'assistant', content: 'Which destination and travel dates?' } }; } }, tools: unplannedTools, prompt: 'Plan my trip.' });
  assert.equal(clarification.status, 'completed');
  assert.equal(clarification.steps, 1);
});

test('WebIQ cancellation aborts a stalled initialized notification', async context => {
  const { directory } = await fixture(context);
  const { createWebIQ } = await import('../src/connectors.mjs');
  const configFile = path.join(directory, 'mcp.json');
  await writeFile(configFile, JSON.stringify({ servers: { 'WebIQ-MCP': { url: 'https://api.microsoft.ai/v3/mcp', headers: { 'x-apikey': 'test-only' } } } }));
  const controller = new AbortController();
  const stalled = Promise.withResolvers();
  let notificationSignal;
  const connector = createWebIQ({ configFile, fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }), { headers: { 'content-type': 'application/json' } });
    assert.equal(request.method, 'notifications/initialized');
    notificationSignal = init.signal;
    stalled.resolve();
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  context.after(() => connector.close());
  const operation = connector.callTool('web', { query: 'test' }, { signal: controller.signal });
  operation.catch(() => {});
  await stalled.promise;
  controller.abort(new Error('Cancelled test run.'));
  await new Promise(setImmediate);
  assert.equal(notificationSignal.aborted, true);
  await assert.rejects(operation, /Cancelled test run/);
});

test('travel PDF is real, approval-gated and delivery uses only the saved itinerary', async context => {
  const { directory } = await fixture(context);
  const { createTools } = await import('../src/tools.mjs');
  const calls = [];
  const tools = createTools({ documentsDir: directory, dataDir: directory, runId: 'pdf-test', connectors: {
    workiq: { async callTool(name, args) { calls.push({ name, args }); return { id: 'test-event', status: 201 }; } },
  } });
  const exportCall = toolCall('export_itinerary_pdf', itinerary);
  await assert.rejects(tools.execute(exportCall), /approval/i);
  assert.equal((await tools.execute(exportCall, { approve: async () => false })).denied, true);
  await assert.rejects(readFile(path.join(directory, 'reports', 'pdf-test.pdf')), { code: 'ENOENT' });
  const exported = await tools.execute(exportCall, { approve: async () => true });
  assert.equal(exported.saved, true);
  const pdf = await readFile(path.join(directory, 'reports', 'pdf-test.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1000);
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(tools.execute(toolCall('send_itinerary_email', { recipient: 'not-an-email' })), /email/i);
  const invite = toolCall('create_trip_calendar', { recipient: 'traveler@example.com' });
  assert.equal((await tools.execute(invite, { approve: async () => false })).denied, true);
  assert.equal(calls.length, 0);
  let preview;
  const created = await tools.execute(invite, { approve: async proposal => { preview = proposal.args; return true; } });
  assert.equal(created.submitted, true);
  assert.equal(preview.recipient, 'traveler@example.com');
  assert.equal(preview.itinerary.title, itinerary.title);
  assert.equal(calls[0].name, 'create_entity');
  assert.equal(calls[0].args.jsonBody.end.dateTime, '2026-09-21T00:00:00');
  assert.equal(calls[0].args.jsonBody.start.timeZone, 'Singapore Standard Time');
  await assert.rejects(tools.execute(invite, { approve: async () => true }), /already|duplicate/i);
  const email = await tools.execute(toolCall('send_itinerary_email', { recipient: 'traveler@example.com' }), { approve: async () => true });
  assert.equal(email.submitted, true);
  assert.equal(calls[1].name, 'do_action');
  assert.equal(calls[1].args.actionUrl, '/me/sendMail');
  assert.equal(calls[1].args.jsonBody.Message.attachments[0].contentBytes, pdf.toString('base64'));
  await assert.rejects(tools.execute(toolCall('export_itinerary_pdf', { ...itinerary, endDate: '2026-09-18' }), { approve: async () => true }), /date|end/i);
  let attempts = 0;
  const settings = { documentsDir: directory, dataDir: directory, runId: 'ambiguous-delivery', connectors: { workiq: { async callTool() { attempts++; throw new Error('Connection lost after submission.'); } } } };
  const ambiguous = createTools(settings);
  await ambiguous.execute(exportCall, { approve: async () => true });
  const mail = toolCall('send_itinerary_email', { recipient: 'traveler@example.com' });
  await assert.rejects(ambiguous.execute(mail, { approve: async () => true }), /Connection lost/);
  await assert.rejects(createTools(settings).execute(mail, { approve: async () => true }), /already attempted/);
  assert.equal(attempts, 1);
});

test('atomic JSON replacement tolerates transient locks and preserves old data on persistent failure', async context => {
  const { directory } = await fixture(context);
  const { writeJson, readJson } = await import('../src/store.mjs');
  const file = path.join(directory, 'state.json');
  await writeJson(file, { revision: 1 });
  const originalRename = fs.rename;
  let attempts = 0;
  let persistent = false;
  const replacement = context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === file && (++attempts <= 2 || persistent)) throw Object.assign(new Error('File is locked'), { code: 'EPERM' });
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  context.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
  await writeJson(file, { revision: 2 });
  assert.equal(attempts, 3);
  assert.deepEqual(await readJson(file), { revision: 2 });
  persistent = true;
  attempts = 0;
  await assert.rejects(writeJson(file, { revision: 3 }), { code: 'EPERM' });
  assert.equal(attempts, 5);
  assert.deepEqual(await readJson(file), { revision: 2 });
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('real file tools reject traversal and unknown arguments', async context => {
  const { tools } = await fixture(context);
  assert.match((await tools.execute(toolCall('read_document', { name: 'brief.md' }))).content, /20 participants/);
  await assert.rejects(tools.execute(toolCall('read_document', { name: '../package.json' })), /invalid|file/i);
  await assert.rejects(tools.execute(toolCall('read_document', { name: 'brief.md', extra: true })), /unrecognized/i);
  await assert.rejects(tools.execute(toolCall('run_shell', { command: 'whoami' })), /unknown/i);
});

test('calculator computes actual costs and rejects invalid input', async context => {
  const { tools } = await fixture(context);
  const result = await tools.execute(toolCall('calculate_budget', { budget: 1000000, items: [{ label: 'Meals', quantity: 20, unitCost: 35000 }] }));
  assert.equal(result.total, 700000);
  assert.equal(result.remaining, 300000);
  await assert.rejects(tools.execute(toolCall('calculate_budget', { budget: 100, items: [{ label: 'Invalid', quantity: -1, unitCost: 2 }] })), /small|greater/i);
});

test('writes require approval; memory survives recreation of tool registry', async context => {
  const { tools, directory } = await fixture(context);
  const call = toolCall('save_memory', { key: 'language', value: 'English' });
  await assert.rejects(tools.execute(call), /approval/i);
  assert.deepEqual(await tools.execute(call, { approve: async () => false }), { denied: true, message: 'The user denied this action. Do not claim it was saved.' });
  await tools.execute(call, { approve: async () => true });
  const { createTools } = await import('../src/tools.mjs');
  const reloaded = createTools({ documentsDir: directory, dataDir: directory, runId: 'next-run', memoryEnabled: true });
  assert.equal((await reloaded.execute(toolCall('read_memory'))).language.value, 'English');
  const disabled = createTools({ documentsDir: directory, dataDir: directory, runId: 'no-memory', memoryEnabled: false });
  await assert.rejects(disabled.execute(toolCall('read_memory')), /disabled/i);
  await tools.execute(toolCall('write_report', { content: '# Actual report' }), { approve: async () => true });
  assert.equal(await readFile(path.join(directory, 'reports', 'test-run.md'), 'utf8'), '# Actual report');
});

test('harness feeds real tool results back, then stops on final response', async context => {
  const { tools } = await fixture(context);
  const { runHarness } = await import('../src/harness.mjs');
  let calls = 0;
  const model = { async complete(messages) {
    calls++;
    assert.match(messages[0].content, /Respond in English\./);
    assert.match(messages[0].content, /To request approval, call the write tool/);
    if (calls === 1) return { message: { role: 'assistant', content: null, tool_calls: [toolCall('read_document', { name: 'brief.md' })] }, usage: { total_tokens: 10 } };
    assert.match(messages.at(-1).content, /20 participants/);
    assert.equal(messages.at(-1).tool_call_id, 'call-read_document');
    return { message: { role: 'assistant', content: '20 participants.' }, usage: { total_tokens: 5 } };
  } };
  const events = [];
  const result = await runHarness({ model, tools, prompt: 'Read the brief.', maxSteps: 3, emit: async event => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.tokens, 15);
  assert.equal(calls, 2);
  assert.ok(events.some(event => event.type === 'tool_result'));
});

test('harness continuation retains the reviewed itinerary and still requires exact approval', async context => {
  const { tools, directory } = await fixture(context);
  const { runHarness } = await import('../src/harness.mjs');
  const history = [
    { role: 'user', content: 'Plan a Singapore museum weekend and prepare a PDF for review.' },
    { role: 'assistant', content: null, tool_calls: [toolCall('search_destination', { destination: 'Singapore', interests: 'museums' })] },
    { role: 'tool', tool_call_id: 'call-search_destination', content: JSON.stringify({ source: itinerary.sources[0] }) },
    { role: 'assistant', content: JSON.stringify(itinerary) },
  ];
  const original = structuredClone(history);
  let requests = 0;
  let approvals = 0;
  const result = await runHarness({
    tools, history, prompt: 'Export the previous itinerary.',
    model: { async complete(messages) {
      requests++;
      if (requests === 1) {
        assert.deepEqual(messages.slice(1, -1), original);
        assert.equal(messages.at(-1).content, 'Export the previous itinerary.');
        return { message: { role: 'assistant', content: null, tool_calls: [toolCall('export_itinerary_pdf', itinerary)] } };
      }
      assert.equal(JSON.parse(messages.at(-1).content).denied, true);
      return { message: { role: 'assistant', content: 'Export denied. No PDF was saved.' } };
    } },
    approve: async proposal => {
      approvals++;
      assert.equal(proposal.name, 'export_itinerary_pdf');
      assert.deepEqual(proposal.args, itinerary);
      return false;
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(approvals, 1);
  assert.deepEqual(history, original);
  await assert.rejects(readFile(path.join(directory, 'reports', 'test-run.pdf')), { code: 'ENOENT' });
});

test('harness stops repeated calls at maxSteps and handles cancelled runs', async context => {
  const { tools } = await fixture(context);
  const { runHarness } = await import('../src/harness.mjs');
  let calls = 0;
  const model = { async complete() { calls++; return { message: { role: 'assistant', tool_calls: [toolCall('list_documents')] }, usage: { total_tokens: 1 } }; } };
  const result = await runHarness({ model, tools, prompt: 'List', maxSteps: 2 });
  assert.equal(result.status, 'limited');
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runHarness({ model, tools, prompt: 'List', signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(calls, 2);
});

test('harness default token budget allows longer runs and stops at 100000', async context => {
  const { tools } = await fixture(context);
  const { runHarness } = await import('../src/harness.mjs');
  for (const total of [99999, 100000, 100050]) {
    let calls = 0;
    const events = [];
    const limited = total >= 100000;
    const model = { async complete() {
      calls++;
      return {
        message: calls === 1 || limited
          ? { role: 'assistant', tool_calls: [toolCall('list_documents')] }
          : { role: 'assistant', content: 'Documents listed.' },
        usage: { total_tokens: calls === 1 ? 50000 : total - 50000 },
      };
    } };
    const result = await runHarness({ model, tools, prompt: 'List documents.', maxSteps: 2, emit: async event => events.push(event) });
    assert.equal(result.status, limited ? 'limited' : 'completed');
    assert.equal(result.tokens, total);
    assert.equal(calls, 2);
    assert.equal(events.find(event => event.type === 'run_started').maxTokens, 100000);
    assert.equal(events.filter(event => event.type === 'tool_result').length, 1);
    if (limited) assert.equal(result.reason, 'token_budget');
  }
});

test('harness returns tool errors to model and enforces token budget', async context => {
  const { tools } = await fixture(context);
  const { runHarness } = await import('../src/harness.mjs');
  const events = [];
  const model = { async complete() { return { message: { role: 'assistant', tool_calls: [toolCall('read_document', { name: '../secret' })] }, usage: { total_tokens: 100 } }; } };
  const result = await runHarness({ model, tools, prompt: 'Read', maxSteps: 3, maxTokens: 150, emit: async event => events.push(event) });
  assert.equal(result.status, 'limited');
  assert.equal(result.tokens, 200);
  assert.ok(events.some(event => event.type === 'tool_result' && event.result.error));
});

test('conversation history restores linked completed runs without replaying actions', async context => {
  const { directory } = await fixture(context);
  const { readConversation, writeJson } = await import('../src/store.mjs');
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const source = { observed: 'Source evidence', url: itinerary.sources[0].url };
  const first = { id: firstId, status: 'completed', prompt: 'Plan Singapore.', answer: JSON.stringify(itinerary), events: [
    { type: 'model_response', message: { role: 'assistant', content: null, tool_calls: [toolCall('search_destination', { destination: 'Singapore', interests: 'museums' })] } },
    { type: 'tool_result', callId: 'call-search_destination', name: 'search_destination', result: source },
    { type: 'model_response', message: { role: 'assistant', content: JSON.stringify(itinerary) } },
  ] };
  const second = { id: secondId, parentRunId: firstId, status: 'completed', prompt: 'Keep the relaxed pace.', answer: 'The draft is unchanged.', events: [
    { type: 'model_response', message: { role: 'assistant', content: 'The draft is unchanged.' } },
  ] };
  const firstFile = path.join(directory, 'runs', `${firstId}.json`);
  await writeJson(firstFile, first);
  await writeJson(path.join(directory, 'runs', `${secondId}.json`), second);
  const restored = await readConversation(directory, secondId);
  assert.equal(restored.conversationId, firstId);
  assert.deepEqual(restored.history.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
  assert.deepEqual(JSON.parse(restored.history[2].content), source);
  assert.equal(restored.history[2].tool_call_id, 'call-search_destination');
  assert.deepEqual(JSON.parse(restored.history[3].content), itinerary);
  assert.deepEqual(JSON.parse(await readFile(firstFile, 'utf8')), first);
  await assert.rejects(readConversation(directory, '../escape'), /invalid/i);
  await assert.rejects(readConversation(directory, '33333333-3333-4333-8333-333333333333'), /not found/i);
  await writeJson(firstFile, { ...first, status: 'awaiting_approval' });
  await assert.rejects(readConversation(directory, firstId), /completed/i);
  await writeJson(firstFile, { ...first, events: first.events.filter(event => event.type !== 'tool_result') });
  await assert.rejects(readConversation(directory, firstId), /incomplete/i);
  await writeJson(firstFile, { ...first, parentRunId: secondId });
  await assert.rejects(readConversation(directory, secondId), /cycle/i);
  await writeJson(firstFile, { ...first, prompt: 'x'.repeat(80001) });
  await assert.rejects(readConversation(directory, firstId), /too large/i);
});

test('local HTTP API rejects cross-origin, missing session token and malformed requests', async context => {
  const { directory } = await fixture(context);
  const { createApplication } = await import('../src/server.mjs');
  const server = await createApplication({ dataDir: directory, model: { identity: { account: 'test' } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/state`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const state = await (await fetch(`${origin}/api/state`)).json();
  const headers = { 'content-type': 'application/json', 'x-harness-token': state.sessionToken };
  assert.equal((await fetch(`${origin}/api/runs`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${origin}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', maxSteps: 0, memoryEnabled: true }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/runs/not-a-run`)).status, 404);
  const guide = await fetch(`${origin}/l400`);
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /^# Agent Harness: L400 Engineering Guide/);
  assert.match(await (await fetch(`${origin}/workshop`)).text(), /^# Workshop: Understanding the Agent Harness/);
});

test('HTTP continuation restores a persisted draft and binds approval to the new run', { timeout: 30000 }, async context => {
  const { directory } = await fixture(context);
  const { writeJson } = await import('../src/store.mjs');
  const { createApplication } = await import('../src/server.mjs');
  const parentId = '44444444-4444-4444-8444-444444444444';
  const draft = JSON.stringify(itinerary);
  await writeJson(path.join(directory, 'runs', `${parentId}.json`), {
    id: parentId, prompt: 'Plan a Singapore trip.', status: 'completed', startedAt: '2026-01-01T00:00:00Z', answer: draft,
    events: [{ type: 'model_response', message: { role: 'assistant', content: draft } }],
  });
  const model = { async complete(messages, definitions, options) {
    const continuation = messages.filter(message => message.role === 'user').at(-1).content === 'Export it.';
    assert.equal(messages.some(message => message.content === draft), continuation);
    assert.equal(options.toolChoice, undefined);
    if (continuation && messages.at(-1).role === 'user') {
      return { message: { role: 'assistant', tool_calls: [toolCall('export_itinerary_pdf', itinerary)] } };
    }
    if (continuation) assert.equal(JSON.parse(messages.at(-1).content).denied, true);
    return { message: { role: 'assistant', content: continuation ? 'No PDF saved.' : 'New conversation.' } };
  } };
  const server = await createApplication({ dataDir: directory, model });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.planning.required, false);
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-token': state.sessionToken }, body: JSON.stringify(body) });
  const waitFor = async (route, predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await (await fetch(`${base}${route}`)).json();
      if (predicate(value)) return value;
    }
    assert.fail(`Timed out waiting for ${route}`);
  };
  assert.equal((await post('/api/runs', { prompt: 'Export it.', maxSteps: 3, memoryEnabled: false, parentRunId: '../escape' })).status, 400);
  assert.equal((await post('/api/runs', { prompt: 'Export it.', maxSteps: 3, memoryEnabled: false, parentRunId: '55555555-5555-4555-8555-555555555555' })).status, 409);
  const response = await post('/api/runs', { prompt: 'Export it.', maxSteps: 3, memoryEnabled: false, parentRunId: parentId });
  assert.equal(response.status, 202, await response.clone().text());
  const { id } = await response.json();
  const pending = await waitFor(`/api/runs/${id}`, run => run.status === 'awaiting_approval' || run.status === 'failed');
  assert.equal(pending.status, 'awaiting_approval', pending.error);
  assert.equal(pending.conversationId, parentId);
  assert.equal(pending.parentRunId, parentId);
  assert.deepEqual(pending.pending.args, itinerary);
  assert.equal(pending.steps, 1);
  assert.equal(pending.events.find(event => event.type === 'model_request').planningRequired, false);
  assert.equal(pending.events.find(event => event.type === 'run_started').historyMessageCount, 2);
  assert.equal((await post(`/api/runs/${parentId}/approval`, { approvalId: pending.pending.id, allow: true })).status, 409);
  assert.equal((await post(`/api/runs/${id}/approval`, { approvalId: parentId, allow: true })).status, 409);
  assert.equal((await post(`/api/runs/${id}/approval`, { approvalId: pending.pending.id, allow: false })).status, 200);
  assert.equal((await post(`/api/runs/${id}/approval`, { approvalId: pending.pending.id, allow: true })).status, 409);
  await waitFor('/api/state', snapshot => !snapshot.activeId);
  const finished = await (await fetch(`${base}/api/runs/${id}`)).json();
  assert.equal(finished.status, 'completed', finished.error);
  await assert.rejects(readFile(path.join(directory, 'reports', `${id}.pdf`)), { code: 'ENOENT' });
  const freshResponse = await post('/api/runs', { prompt: 'Start fresh.', maxSteps: 3, memoryEnabled: false });
  assert.equal(freshResponse.status, 202);
  const fresh = await freshResponse.json();
  await waitFor('/api/state', snapshot => !snapshot.activeId);
  const freshRun = await (await fetch(`${base}/api/runs/${fresh.id}`)).json();
  assert.equal(freshRun.status, 'completed', freshRun.error);
  assert.equal(freshRun.conversationId, fresh.id);
  assert.equal(freshRun.events.find(event => event.type === 'run_started').historyMessageCount, 0);
});

test('dashboard discards a stale run response after history selection changes', async () => {
  class Element {
    constructor() {
      this.children = []; this.textContent = ''; this.clientWidth = 280;
      this.dataset = {}; this.style = {}; this.value = '';
      this.classList = { toggle() {}, remove() {}, add() {} };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    focus() {}
    addEventListener() {}
    querySelectorAll() { return []; }
    getContext() { return { scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} }; }
  }
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const makeRun = id => ({ id, prompt: id, status: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', steps: 1, maxSteps: 12, answer: id, events: [{ type: 'run_started', at: '2026-01-01T00:00:00Z', sequence: 1, name: id }] });
  const firstRun = makeRun('history-A');
  const secondRun = makeRun('history-B');
  const snapshot = { config: { deployment: 'test', dataDir: 'test' }, memory: {}, activeId: null, runs: [firstRun, secondRun] };
  const requestStarted = Promise.withResolvers();
  const firstResponse = Promise.withResolvers();
  const submissions = [];
  let delayedSubmission;
  const responseFor = value => ({ ok: true, json: async () => structuredClone(value) });
  const context = vm.createContext({
    document: { getElementById: getElement, createElement: () => new Element(), querySelectorAll: () => [], documentElement: { dataset: { theme: 'light' } } },
    window: { devicePixelRatio: 1, addEventListener() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    setInterval() {}, clearInterval() {},
    fetch: async (route, options) => {
      if (route === '/api/runs' && options?.method === 'POST') {
        submissions.push(JSON.parse(options.body));
        return delayedSubmission ? delayedSubmission.promise : responseFor({ id: secondRun.id });
      }
      if (route === '/api/state') return responseFor(snapshot);
      if (route === '/api/runs/history-A') { requestStarted.resolve(); return firstResponse.promise; }
      if (route === '/api/runs/history-B') return responseFor(secondRun);
      throw new Error(`Unexpected request: ${route}`);
    },
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await requestStarted.promise;
  vm.runInContext("selectedId = 'history-B'; currentRun = null; eventCount = 0;", context);
  firstResponse.resolve(responseFor(firstRun));
  await new Promise(setImmediate);
  assert.notEqual(vm.runInContext('currentRun?.id', context), firstRun.id);
  await vm.runInContext('refresh()', context);
  assert.equal(vm.runInContext('currentRun.id', context), secondRun.id);
  const traceOrigins = getElement('trace').children.map(row => JSON.parse(row.children.at(-1).textContent).name);
  assert.deepEqual(traceOrigins, [secondRun.id]);
  assert.equal(vm.runInContext("eventNode({type: 'model_request'})", context), 'context');
  assert.equal(vm.runInContext("eventNode({type: 'approval_requested'})", context), 'approval');
  assert.equal(vm.runInContext("eventNode({type: 'tool_call', call: {function: {name: 'read_memory'}}})", context), 'memory');
  assert.equal(vm.runInContext("eventNode({type: 'tool_result', name: 'sequential_thinking'})", context), 'planning');
  assert.equal(vm.runInContext("eventNode({type: 'completed'})", context), 'reply');
  assert.equal(vm.runInContext("eventNode({type: 'limit_reached'})", context), 'guard');
  getElement('continue-run').onclick();
  getElement('prompt').value = 'Export the previous itinerary.';
  getElement('max-steps').value = '12';
  getElement('memory-enabled').checked = false;
  await getElement('task-form').onsubmit({ preventDefault() {} });
  assert.equal(submissions.at(-1).parentRunId, secondRun.id);
  assert.equal(submissions.at(-1).prompt, 'Export the previous itinerary.');
  assert.equal(getElement('prompt').value, '');
  getElement('new-run').onclick();
  await vm.runInContext('refresh()', context);
  getElement('prompt').value = 'Unrelated trip.';
  await getElement('task-form').onsubmit({ preventDefault() {} });
  assert.equal(Object.hasOwn(submissions.at(-1), 'parentRunId'), false);
  await getElement('history').children[0].onclick();
  assert.equal(vm.runInContext('composeParentId', context), firstRun.id);
  delayedSubmission = Promise.withResolvers();
  getElement('prompt').value = 'Export this draft.';
  const sending = getElement('task-form').onsubmit({ preventDefault() {} });
  getElement('new-run').onclick();
  getElement('prompt').value = 'A different trip I am still typing.';
  delayedSubmission.resolve(responseFor({ id: secondRun.id }));
  await sending;
  assert.equal(getElement('prompt').value, 'A different trip I am still typing.');
  assert.equal(vm.runInContext('composeParentId', context), null);
  assert.equal(vm.runInContext('selectedId', context), firstRun.id);
});