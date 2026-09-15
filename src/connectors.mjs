import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse } from 'jsonc-parser';
import { z } from 'zod';

const planningResult = z.object({
  thoughtNumber: z.number().int().positive(), totalThoughts: z.number().int().positive(),
  nextThoughtNeeded: z.boolean(), thoughtHistoryLength: z.number().int().positive(),
});

export function createSequentialThinking() {
  const client = new Client({ name: 'travel-harness-planning', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js', import.meta.url))],
    env: { DISABLE_THOUGHT_LOGGING: 'true' }, stderr: 'ignore',
  });
  let connection;
  let closed = false;
  let count = 0;
  return {
    async record({ summary, nextStep, complete }, { signal } = {}) {
      signal?.throwIfAborted();
      if (closed) throw new Error('Sequential Thinking MCP session is closed.');
      if (count >= 8) throw new Error('Planning update limit reached (8).');
      connection ??= (async () => {
        await client.connect(transport, { timeout: 15000 });
        const { tools } = await client.listTools({}, { signal, timeout: 15000 });
        if (!tools.some(tool => tool.name === 'sequentialthinking')) throw new Error('Sequential Thinking MCP tool is unavailable.');
      })();
      await connection;
      signal?.throwIfAborted();
      const number = count + 1;
      const response = await client.callTool({ name: 'sequentialthinking', arguments: {
        thought: `${summary}\nNext action: ${nextStep}`, thoughtNumber: number,
        totalThoughts: complete ? number : Math.min(8, number + 1), nextThoughtNeeded: !complete,
      } }, undefined, { signal, timeout: 15000 });
      if (response.isError) throw new Error('Sequential Thinking MCP rejected the planning update.');
      const data = planningResult.parse(response.structuredContent ?? JSON.parse(response.content?.find(item => item.type === 'text')?.text || 'null'));
      if (data.thoughtNumber !== number || data.thoughtHistoryLength !== number || data.nextThoughtNeeded !== !complete) {
        throw new Error('Sequential Thinking MCP returned inconsistent planning evidence.');
      }
      count = number;
      return { provider: 'Sequential Thinking MCP', summary, nextStep, complete, data };
    },
    async close() {
      closed = true;
      await client.close();
    },
  };
}

export function createWebIQ({ configFile = path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json'), fetchImpl = globalThis.fetch } = {}) {
  const client = new Client({ name: 'travel-harness-research', version: '1.0.0' });
  let connection;
  let status = 'not contacted';
  return {
    get status() { return status; },
    async callTool(name, args, { signal } = {}) {
      if (name !== 'web') throw new Error('WebIQ operation is not allowed.');
      signal?.throwIfAborted();
      const deadline = new AbortController();
      const operationSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const abort = () => { void client.close().catch(() => {}); };
      operationSignal.addEventListener('abort', abort, { once: true });
      const callTimeout = setTimeout(() => deadline.abort(new Error('WebIQ call deadline exceeded.')), 80000);
      try {
        connection ??= (async () => {
          const handshakeTimeout = setTimeout(() => deadline.abort(new Error('WebIQ handshake deadline exceeded.')), 20000);
          try {
          const errors = [];
          const settings = parse(await readFile(configFile, 'utf8'), errors, { allowTrailingComma: true });
          const server = settings?.servers?.['WebIQ-MCP'];
          if (errors.length || server?.url !== 'https://api.microsoft.ai/v3/mcp' || typeof server.headers?.['x-apikey'] !== 'string' || !server.headers['x-apikey'] || server.headers['x-apikey'].includes('${')) {
            throw new Error('WebIQ configuration unavailable.');
          }
          const transport = new StreamableHTTPClientTransport(new URL(server.url), { fetch: fetchImpl, requestInit: { headers: { 'x-apikey': server.headers['x-apikey'] } } });
          operationSignal.throwIfAborted();
          await client.connect(transport, { signal: operationSignal, timeout: 20000 });
          operationSignal.throwIfAborted();
          const available = await client.listTools({}, { signal: operationSignal, timeout: 20000 });
          if (!available.tools.some(tool => tool.name === 'web')) throw new Error('WebIQ web tool unavailable.');
          } finally { clearTimeout(handshakeTimeout); }
        })();
        await connection;
        operationSignal.throwIfAborted();
        const response = await client.callTool({ name, arguments: args }, undefined, { signal: operationSignal, timeout: 60000 });
        if (response.isError) throw new Error('WebIQ returned an error.');
        const content = response.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
        let data = response.structuredContent;
        if (!data) {
          if (!content) throw new Error('WebIQ returned no content.');
          try { data = JSON.parse(content); } catch { data = { text: content }; }
        }
        status = 'verified by successful call';
        const serialized = JSON.stringify(data);
        return serialized.length <= 24000 ? data : { truncated: true, excerpt: serialized.slice(0, 24000) };
      } catch {
        status = 'unavailable';
        operationSignal.throwIfAborted();
        throw new Error('WebIQ request failed. Check the existing WebIQ-MCP configuration, credentials and network. No sample results were substituted.');
      } finally {
        clearTimeout(callTimeout);
        operationSignal.removeEventListener('abort', abort);
      }
    },
    close: () => client.close(),
  };
}