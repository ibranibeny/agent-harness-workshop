import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); return; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(50 * 2 ** attempt);
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readMemory(dataDir) {
  return readJson(path.join(dataDir, 'memory.json'), {});
}

export async function readConversation(dataDir, parentRunId) {
  const visited = new Set();
  let history = [];
  let conversationId;
  while (parentRunId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parentRunId)) throw new Error('Invalid conversation run ID.');
    if (visited.has(parentRunId)) throw new Error('Conversation history contains a cycle.');
    if (visited.size >= 16) throw new Error('Conversation has too many turns. Start a new conversation.');
    visited.add(parentRunId);
    const run = await readJson(path.join(dataDir, 'runs', `${parentRunId}.json`), null);
    if (!run) throw new Error('Conversation run not found.');
    if (run.id !== parentRunId || run.status !== 'completed') throw new Error('Continue a completed run; pending or interrupted approvals cannot be resumed.');
    const messages = [{ role: 'user', content: run.prompt }];
    let pending;
    let results = [];
    for (const event of run.events) {
      if (event.type === 'model_response') {
        if (pending) throw new Error('Conversation has incomplete tool results.');
        const message = { role: 'assistant', content: event.message.content ?? null };
        if (event.message.tool_calls?.length) {
          message.tool_calls = event.message.tool_calls;
          if (new Set(message.tool_calls.map(call => call.id)).size !== message.tool_calls.length) throw new Error('Conversation has incomplete tool correlation.');
          pending = message;
        } else {
          messages.push(message);
        }
      } else if (event.type === 'tool_result') {
        const call = pending?.tool_calls.find(call => call.id === event.callId && call.function.name === event.name);
        if (!call || results.some(result => result.tool_call_id === event.callId)) throw new Error('Conversation has incomplete tool correlation.');
        results.push({ role: 'tool', tool_call_id: event.callId, content: JSON.stringify(event.result) });
        if (results.length === pending.tool_calls.length) {
          messages.push(pending, ...results);
          pending = null;
          results = [];
        }
      }
    }
    if (pending) throw new Error('Conversation has incomplete tool results.');
    history = [...messages, ...history];
    if (JSON.stringify(history).length > 80000) throw new Error('Conversation history is too large (80,000 characters). Start a new conversation; nothing was silently discarded.');
    conversationId = run.id;
    parentRunId = run.parentRunId;
  }
  return { conversationId, history };
}

export async function listRuns(dataDir) {
  const directory = path.join(dataDir, 'runs');
  await mkdir(directory, { recursive: true });
  const files = (await readdir(directory)).filter(name => /^[\w-]+\.json$/.test(name));
  const runs = await Promise.all(files.map(name => readJson(path.join(directory, name))));
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}