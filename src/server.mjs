import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { config, root } from './config.mjs';
import { createModel } from './model.mjs';
import { createTools } from './tools.mjs';
import { createSequentialThinking, createWebIQ } from './connectors.mjs';
import { runHarness } from './harness.mjs';
import { listRuns, readConversation, readJson, readMemory, writeJson } from './store.mjs';

const runInput = z.strictObject({ prompt: z.string().trim().min(1).max(4000), maxSteps: z.number().int().min(1).max(16), memoryEnabled: z.boolean(), parentRunId: z.string().uuid().optional() });
const approvalInput = z.strictObject({ approvalId: z.string().uuid(), allow: z.boolean() });
const idPattern = /^[a-f0-9-]{36}$/;
const liveStates = new Set(['running', 'awaiting_approval']);

export async function createApplication({ dataDir = config.dataDir, model = createModel() } = {}) {
  const sessionToken = randomBytes(24).toString('hex');
  const nonce = randomBytes(16).toString('base64');
  let active;
  const runFile = id => path.join(dataDir, 'runs', `${id}.json`);
  for (const run of await listRuns(dataDir)) {
    if (liveStates.has(run.status)) {
      run.status = 'interrupted';
      run.pending = null;
      run.error = 'The server stopped before the run finished. Runs are not resumed automatically.';
      await writeJson(runFile(run.id), run);
    }
  }

  async function execute(run, controller, history) {
    const sequential = createSequentialThinking();
    const webiq = createWebIQ();
    let persist = Promise.resolve();
    const emit = async event => {
      if (event.type === 'run_started') event = { ...event, conversationId: run.conversationId, parentRunId: run.parentRunId || null };
      run.events.push({ ...event, sequence: run.events.length + 1 });
      if (event.type === 'model_response') run.tokens = event.tokens;
      run.steps = event.step || run.steps;
      persist = persist.then(() => writeJson(runFile(run.id), run));
      await persist;
    };
    const approve = async proposal => {
      controller.signal.throwIfAborted();
      const decision = Promise.withResolvers();
      decision.promise.catch(() => {});
      const aborted = () => decision.reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
      run.pending = { ...proposal, id: randomUUID() };
      run.status = 'awaiting_approval';
      active.resolveApproval = decision.resolve;
      try {
        await emit({ type: 'approval_requested', at: new Date().toISOString(), proposal: run.pending });
        const allow = await decision.promise;
        await emit({ type: 'approval_resolved', at: new Date().toISOString(), name: proposal.name, allow });
        return allow;
      } finally {
        controller.signal.removeEventListener('abort', aborted);
        run.pending = null;
        run.status = 'running';
        active.resolveApproval = null;
      }
    };
    const timeout = setTimeout(() => controller.abort(new Error('Run timeout (15 minutes).')), 15 * 60 * 1000);
    try {
      const tools = createTools({ documentsDir: config.documentsDir, dataDir, runId: run.id, memoryEnabled: run.memoryEnabled, connectors: { sequential, webiq } });
      const result = await runHarness({ model, tools, prompt: run.prompt, history, maxSteps: run.maxSteps, signal: controller.signal, emit, approve });
      Object.assign(run, result);
    } catch (error) {
      run.status = 'failed';
      run.error = error.message;
    } finally {
      clearTimeout(timeout);
      await sequential.close().catch(() => {});
      await webiq.close().catch(() => {});
      run.pending = null;
      run.finishedAt = new Date().toISOString();
      try { await writeJson(runFile(run.id), run); }
      finally { active = null; }
    }
  }

  const server = http.createServer(async (request, response) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` });
      response.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const allowedHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
      if (!allowedHosts.includes(request.headers.host)) return send(403, { error: 'Invalid local Host.' });
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'Cross-origin request denied.' });
      const url = new URL(request.url, origin);
      const route = url.pathname;
      let body;
      if (request.method === 'POST') {
        if (request.headers['x-harness-token'] !== sessionToken) return send(403, { error: 'Invalid local session token. Refresh dashboard.' });
        if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Expected application/json.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 20000) return send(413, { error: 'Request too large.' });
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return send(400, { error: 'Invalid JSON.' }); }
      }
      if (request.method === 'GET' && route === '/api/state') {
        const runs = await listRuns(dataDir);
        return send(200, { sessionToken, config: { ...config, dataDir }, identity: model.identity || null, planning: { provider: 'Sequential Thinking MCP', transport: 'local Node.js stdio', required: false, maxUpdates: 8, scope: 'per run when selected; conversation context retained' }, memory: await readMemory(dataDir), activeId: active?.run.id || null, runs: runs.map(({ id, conversationId, parentRunId, prompt, status, startedAt, tokens, steps }) => ({ id, conversationId: conversationId || id, parentRunId, prompt, status, startedAt, tokens, steps })) });
      }
      if (request.method === 'POST' && route === '/api/runs') {
        const parsed = runInput.safeParse(body);
        if (!parsed.success) return send(400, { error: parsed.error.message });
        if (active) return send(409, { error: 'A run is still active. Finish or cancel it first.' });
        let conversation = { history: [] };
        if (parsed.data.parentRunId) {
          try { conversation = await readConversation(dataDir, parsed.data.parentRunId); }
          catch (error) { return send(409, { error: error.message }); }
        }
        if (active) return send(409, { error: 'A run is still active. Finish or cancel it first.' });
        const run = { id: randomUUID(), ...parsed.data, startedAt: new Date().toISOString(), status: 'running', tokens: 0, steps: 0, events: [], pending: null };
        run.conversationId = conversation.conversationId || run.id;
        const controller = new AbortController();
        active = { run, controller, resolveApproval: null };
        try { await writeJson(runFile(run.id), run); }
        catch (error) { active = null; throw error; }
        void execute(run, controller, conversation.history).catch(error => console.error('Run persistence failed:', error.message));
        return send(202, { id: run.id });
      }
      const match = route.match(/^\/api\/runs\/([^/]+)(?:\/(approval|cancel|trace|report|pdf))?$/);
      if (match) {
        const [, id, action] = match;
        if (!idPattern.test(id)) return send(404, { error: 'Run not found.' });
        const run = active?.run.id === id ? active.run : await readJson(runFile(id), null);
        if (!run) return send(404, { error: 'Run not found.' });
        if (request.method === 'GET' && !action) return send(200, run);
        if (request.method === 'GET' && action === 'trace') {
          response.setHeader('Content-Disposition', `attachment; filename="trace-${id}.json"`);
          return send(200, run);
        }
        if (request.method === 'GET' && action === 'pdf') {
          try {
            const content = await readFile(path.join(dataDir, 'reports', `${id}.pdf`));
            response.setHeader('Content-Disposition', `attachment; filename="itinerary-${id}.pdf"`);
            return send(200, content, 'application/pdf');
          } catch (error) { if (error.code === 'ENOENT') return send(404, { error: 'No itinerary PDF has been saved.' }); throw error; }
        }
        if (request.method === 'GET' && action === 'report') {
          try {
            const content = await readFile(path.join(dataDir, 'reports', `${id}.md`), 'utf8');
            response.setHeader('Content-Disposition', `attachment; filename="report-${id}.md"`);
            return send(200, content, 'text/markdown; charset=utf-8');
          } catch (error) { if (error.code === 'ENOENT') return send(404, { error: 'No report has been saved.' }); throw error; }
        }
        if (request.method === 'POST' && action === 'cancel') {
          if (active?.run.id !== id) return send(409, { error: 'The run is not active.' });
          active.controller.abort(new Error('Cancelled by user.'));
          return send(200, { cancelling: true });
        }
        if (request.method === 'POST' && action === 'approval') {
          const parsed = approvalInput.safeParse(body);
          if (!parsed.success) return send(400, { error: 'Invalid approval.' });
          if (active?.run.id !== id || run.pending?.id !== parsed.data.approvalId || !active.resolveApproval) return send(409, { error: 'Approval expired or was already decided.' });
          const resolve = active.resolveApproval;
          active.resolveApproval = null;
          resolve(parsed.data.allow);
          return send(200, { accepted: true });
        }
      }
      const assets = {
        '/': ['public/index.html', 'text/html; charset=utf-8'],
        '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
        '/lucide.js': ['node_modules/lucide/dist/umd/lucide.js', 'text/javascript; charset=utf-8'],
        '/workshop': ['docs/WORKSHOP.md', 'text/plain; charset=utf-8'],
        '/l400': ['docs/L400.md', 'text/plain; charset=utf-8'],
      };
      if (request.method === 'GET' && Object.hasOwn(assets, route)) {
        const [file, type] = assets[route];
        const content = (await readFile(path.join(root, file), 'utf8')).replaceAll('__NONCE__', nonce);
        return send(200, content, type);
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      if (!response.headersSent) send(500, { error: error.message });
      else response.end();
    }
  });
  server.on('close', () => active?.controller.abort(new Error('Server shutdown.')));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const model = createModel();
  await model.verify();
  await stat(path.join(root, 'public/index.html'));
  const server = await createApplication({ model });
  let port = config.port;
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && port < config.port + 20) server.listen(++port, '127.0.0.1');
    else { console.error(error.message); process.exitCode = 1; }
  });
  server.on('listening', () => console.log(`Agent Harness Lab: http://127.0.0.1:${server.address().port}\nFoundry: ${config.deployment} | ${model.identity.account}\nRuntime: ${config.dataDir}`));
  server.listen(port, '127.0.0.1');
}