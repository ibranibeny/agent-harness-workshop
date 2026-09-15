const element = id => document.getElementById(id);
const scenarios = {
  travel: 'Plan a relaxed Singapore museum trip from 2026-09-19 to 2026-09-20, time zone Asia/Singapore. Read my travel preferences if relevant and use WebIQ for destination and exact-date weather research. Use Sequential Thinking only if this multi-step itinerary benefits from a plan. Cite sources and label any unavailable forecast honestly. Export the itinerary as a PDF after I review and approve it. Do not email, create calendar events, or save new memory.',
  budget: 'Read workshop-brief.md and prices.json. Calculate the workshop budget using the tool. Create a concise Markdown report with line costs, remaining budget and a 120-minute agenda. Save it after I approve.',
  memory: 'Remember my travel preferences: English itineraries, museums, public transport and a relaxed pace. Save as travel_preference after I approve. Do not perform research or create files.',
  recall: 'Read saved memory and state my saved travel preferences. Explain how they would affect a future itinerary, without inventing destination or weather facts. Do not save anything or send anything.',
  custom: '',
};
const labels = { run_started: 'Run started', model_request: 'Context submitted', rate_wait: 'Quota pacing', model_response: 'Foundry response', tool_call: 'Tool call', tool_result: 'Tool result', approval_requested: 'Approval required', approval_resolved: 'Human decision', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', limit_reached: 'Limit reached' };
const statuses = { running: 'Running', awaiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', limited: 'Limit reached', interrupted: 'Interrupted' };
let state;
let selectedId;
let currentRun;
let composeParentId;
let composerRevision = 0;
let busy = false;
let eventCount = 0;
let approvalId;
let selectedNode = 'context';
let replayIndex = null;
const number = value => new Intl.NumberFormat('en-US').format(value || 0);
const time = value => new Date(value).toLocaleTimeString('en-GB');
const icons = () => window.lucide?.createIcons();
const nodeInfo = {
  gateway: ['Gateway', 'Local entry boundary', 'The server validates the prompt, origin, session token and one-active-run constraint before starting the harness.', 'src/server.mjs / createApplication'],
  context: ['Working context', 'Retained across conversation turns', 'System instructions, linked conversation history, the prompt and tool results form context. tool_call_id binds each result to its request. Replies restore the selected conversation; New conversation starts empty. History is not write permission.', 'src/harness.mjs + src/store.mjs'],
  llm: ['LLM agent', 'Microsoft Foundry / cloud', 'The model proposes text or tool calls. It cannot execute local filesystem operations itself. Request IDs and token usage come from actual API responses, not simulated reasoning.', 'src/model.mjs / complete'],
  tools: ['Travel tools', 'WebIQ research / local PDF / WorkIQ delivery', 'Zod validates arguments and the registry enforces the allowlist. WebIQ supplies external source data; PDFKit writes a local itinerary after approval. Calendar and email require separate approvals and a connected WorkIQ service. Results or errors return to context.', 'src/tools.mjs + src/travel.mjs'],
  planning: ['Sequential Thinking', 'Optional local Node.js MCP', 'Optional public planning for multi-step itineraries and complex revisions. Simple weather and attractions research can call WebIQ directly. Planning does not search the web, execute next actions or grant approval. Maximum eight updates when used. No private chain-of-thought is requested.', 'src/connectors.mjs / createSequentialThinking'],
  approval: ['Human approval', 'Permission for one proposed action', 'A validated proposal waits for an explicit decision bound to the run and proposal ID. Denial returns denied:true without writing. Replaying an event never grants permission.', 'src/server.mjs / approve'],
  reply: ['Reply', 'Grounded in observations', 'A nonempty response without tool calls ends the loop. A successful-save claim needs saved:true evidence. The model can still make mistakes, so inspect the result.', 'src/harness.mjs / completed'],
  guard: ['Execution limits', 'Harness-owned controls', 'Iteration limits, a 100,000-token soft budget, a 15-minute timeout and cancellation bound execution. Cancellation does not roll back completed writes. No shell tool is exposed.', 'src/harness.mjs + src/server.mjs'],
  instructions: ['System instructions', 'Static rules, not learned memory', 'Instructions enter every new run. This is not procedural skill retrieval. Documents and stored preferences are untrusted data, not permission to override policy or add tools.', 'src/harness.mjs / instructions'],
  memory: ['Preference memory', 'Durable, explicitly retrieved', 'save_memory writes JSON after approval. read_memory brings stored values into a new run. There is no FTS, embedding or probabilistic retrieval gate. Disabling memory removes its tools and rejects their execution.', 'src/tools.mjs + src/store.mjs'],
  trace: ['Trace & history', 'Audit evidence and conversation continuity', 'Events record request IDs, usage, tool calls/results and human decisions. Replay is read-only. A reply restores messages from its linked completed runs, without re-executing tools or reviving approvals.', 'src/server.mjs / emit + src/store.mjs'],
};

function eventNode(event) {
  const name = event.name || event.call?.function?.name;
  if (event.type === 'approval_requested' || event.type === 'approval_resolved') return 'approval';
  if ((event.type === 'tool_call' || event.type === 'tool_result') && name === 'sequential_thinking') return 'planning';
  if (event.type === 'tool_call' || event.type === 'tool_result') return ['read_memory', 'save_memory'].includes(name) ? 'memory' : 'tools';
  return { run_started: 'gateway', model_request: 'context', model_response: 'llm', rate_wait: 'guard', completed: 'reply', failed: 'guard', cancelled: 'guard', limit_reached: 'guard' }[event.type] || 'trace';
}

function renderArchitecture(run) {
  const events = run?.events || [];
  const index = replayIndex === null ? events.length - 1 : Math.min(replayIndex, events.length - 1);
  const event = events[index];
  const activeNode = event ? eventNode(event) : null;
  const observed = new Set(events.slice(0, index + 1).map(eventNode));
  for (const button of document.querySelectorAll('[data-node]')) {
    button.classList.toggle('observed', observed.has(button.dataset.node));
    button.classList.toggle('current', button.dataset.node === activeNode);
    button.classList.toggle('selected', button.dataset.node === selectedNode);
    button.setAttribute('aria-pressed', String(button.dataset.node === selectedNode));
  }
  const toolName = event?.name || event?.call?.function?.name;
  element('execution-phase').textContent = event ? `${labels[event.type] || event.type}${toolName ? ` / ${toolName}` : ''}` : 'No recorded events';
  element('playback-mode').textContent = replayIndex === null ? 'Live / latest event' : 'Replay / no inference';
  element('event-position').textContent = event ? `${index + 1} / ${events.length}` : '0 / 0';
  element('event-slider').max = Math.max(0, events.length - 1);
  element('event-slider').value = Math.max(0, index);
  element('event-slider').disabled = !events.length;
  element('event-prev').disabled = index <= 0;
  element('event-next').disabled = index >= events.length - 1;
  element('event-live').setAttribute('aria-pressed', String(replayIndex === null));
  const info = nodeInfo[selectedNode];
  element('inspector-title').textContent = info[0];
  element('inspector-kind').textContent = info[1];
  element('inspector-description').textContent = info[2];
  element('inspector-source').textContent = info[3];
  const evidence = events.slice(0, index + 1).filter(entry => selectedNode === 'trace' || eventNode(entry) === selectedNode).at(-1);
  element('inspector-evidence').textContent = evidence ? JSON.stringify(evidence, null, 2) : 'No component event recorded at this position.';
  const contextEvent = events.slice(0, index + 1).filter(entry => entry.type === 'model_request').at(-1);
  element('context-size').textContent = contextEvent ? `${contextEvent.messageCount} messages / ${number(contextEvent.contextChars)} chars` : 'Not assembled yet';
}

function showError(error) {
  element('error').hidden = !error;
  element('error').textContent = error?.message || '';
}

function setComposer(parentRunId) {
  composerRevision++;
  composeParentId = parentRunId;
  element('prompt').value = '';
  element('scenario').value = 'custom';
  element('prompt-label').textContent = parentRunId ? `Reply to run ${parentRunId.slice(0, 8)}` : 'New conversation message';
  element('start-label').textContent = parentRunId ? 'Send reply' : 'Run';
}

async function api(route, data) {
  const options = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-token': state?.sessionToken || '' }, body: JSON.stringify(data) };
  const response = await fetch(route, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function displayIdentity() {
  element('model-name').textContent = state.config.deployment;
  element('connection').textContent = state.identity ? `Foundry / ${state.identity.account}` : 'Identity not verified';
  element('connection').classList.toggle('verified', Boolean(state.identity));
  element('runtime-path').textContent = state.config.dataDir;
  const values = { Account: state.config.account, Tenant: state.config.tenantId, Endpoint: state.config.baseURL, Deployment: state.config.deployment, Planning: state.planning ? `${state.planning.provider} / ${state.planning.required ? 'required' : 'optional'} / ${state.planning.scope} / ${state.planning.maxUpdates} updates` : 'Not reported', WebIQ: 'Existing server configuration; verify each call in Trace', WorkIQ: 'Unavailable: production write connector is not implemented' };
  element('identity').replaceChildren();
  for (const [key, value] of Object.entries(values)) {
    const term = document.createElement('dt'); term.textContent = key;
    const description = document.createElement('dd'); description.textContent = value;
    element('identity').append(term, description);
  }
}

function renderMemory() {
  const entries = Object.entries(state.memory);
  element('memory-count').textContent = number(entries.length);
  const container = element('memory');
  container.replaceChildren();
  if (!entries.length) { container.textContent = 'No saved preferences.'; container.className = 'empty'; return; }
  container.className = '';
  for (const [key, entry] of entries) {
    const item = document.createElement('div'); item.className = 'memory-item';
    const heading = document.createElement('strong'); heading.textContent = key;
    const value = document.createElement('p'); value.textContent = entry.value;
    const stamp = document.createElement('small'); stamp.textContent = new Date(entry.updatedAt).toLocaleString('en-GB');
    item.append(heading, value, stamp); container.append(item);
  }
}

function renderHistory() {
  const container = element('history');
  container.replaceChildren();
  if (!state.runs.length) { container.textContent = 'No runs yet.'; return; }
  for (const run of state.runs) {
    const button = document.createElement('button'); button.className = `history-item${run.id === selectedId ? ' selected' : ''}`;
    const title = document.createElement('span'); title.textContent = run.prompt;
    const meta = document.createElement('small'); meta.textContent = `${time(run.startedAt)} / ${statuses[run.status] || run.status}`;
    button.append(title, meta);
    button.title = run.prompt;
    button.onclick = async () => { selectedId = run.id; currentRun = null; setComposer(run.id); element('start').disabled = true; eventCount = 0; replayIndex = null; element('trace').replaceChildren(); element('approval').hidden = true; await guardedRefresh(); };
    container.append(button);
  }
}

function renderChart(events) {
  const canvas = element('usage-chart');
  const context = canvas.getContext('2d');
  const samples = events.filter(event => event.type === 'model_response').map(event => event.usage?.total_tokens || 0);
  const styles = getComputedStyle(document.documentElement);
  const width = canvas.clientWidth || 250;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio; canvas.height = 120 * ratio;
  context.scale(ratio, ratio);
  context.fillStyle = styles.getPropertyValue('--cp-surface-soft'); context.fillRect(0, 0, width, 120);
  context.strokeStyle = styles.getPropertyValue('--cp-border'); context.beginPath(); context.moveTo(8, 100); context.lineTo(width - 8, 100); context.stroke();
  const max = Math.max(...samples, 1);
  const track = (width - 24) / Math.max(samples.length, 4);
  samples.forEach((value, index) => {
    const height = value / max * 72;
    context.fillStyle = styles.getPropertyValue('--cp-accent'); context.fillRect(12 + index * track, 100 - height, Math.min(track - 6, 36), height);
    context.fillStyle = styles.getPropertyValue('--cp-text-muted'); context.font = '10px Consolas'; context.fillText(String(index + 1), 15 + index * track, 114);
  });
  element('usage-caption').textContent = samples.length ? `${samples.length} responses / ${number(samples.reduce((sum, value) => sum + value, 0))} tokens` : 'No usage recorded.';
}

function renderRun(run) {
  if (currentRun?.id !== run.id) eventCount = 0;
  currentRun = run;
  if (composeParentId === undefined) setComposer(run.id);
  element('continue-run').disabled = Boolean(state.activeId) || run.status !== 'completed';
  element('start').disabled = Boolean(state.activeId) || Boolean(composeParentId && (composeParentId !== run.id || run.status !== 'completed'));
  element('run-title').textContent = `Run ${run.id.slice(0, 8)}`;
  element('run-status').textContent = statuses[run.status] || run.status;
  element('run-status').className = `status ${run.status}`;
  element('tokens').textContent = number(run.tokens);
  element('steps').textContent = `${run.steps} / ${run.maxSteps}`;
  const seconds = Math.max(0, Math.floor((new Date(run.finishedAt || Date.now()) - new Date(run.startedAt)) / 1000));
  element('elapsed').textContent = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  element('answer').textContent = run.answer || run.error || (run.status === 'limited' ? `Limit reached: ${run.reason}.` : 'No final answer yet.');
  element('chat-user').textContent = run.prompt;
  element('model-calls').textContent = number(run.events.filter(event => event.type === 'model_response').length);
  element('tool-calls').textContent = number(run.events.filter(event => event.type === 'tool_call').length);
  element('event-count').textContent = number(run.events.length);
  element('chat-status').textContent = statuses[run.status] || run.status;
  element('download-trace').hidden = false;
  element('download-trace').href = `/api/runs/${run.id}/trace`;
  const reportSaved = run.events.some(event => event.type === 'tool_result' && event.name === 'write_report' && event.result.saved);
  element('download-report').hidden = !reportSaved;
  element('download-report').href = `/api/runs/${run.id}/report`;
  const pdfSaved = run.events.some(event => event.type === 'tool_result' && event.name === 'export_itinerary_pdf' && event.result.saved);
  element('download-pdf').hidden = !pdfSaved;
  element('download-pdf').href = `/api/runs/${run.id}/pdf`;
  if (!eventCount) element('trace').replaceChildren();
  for (const event of run.events.slice(eventCount)) {
    const details = document.createElement('details'); details.className = `event ${event.type}`;
    const summary = document.createElement('summary');
    const count = document.createElement('small'); count.textContent = String(event.sequence).padStart(2, '0');
    const title = document.createElement('strong'); title.textContent = labels[event.type] || event.type;
    const detail = document.createElement('small'); detail.textContent = event.name || event.call?.function.name || (event.milliseconds ? `${Math.ceil(event.milliseconds / 1000)}s` : event.step ? `iteration ${event.step}` : '');
    const stamp = document.createElement('time'); stamp.textContent = time(event.at);
    const body = document.createElement('pre'); body.textContent = JSON.stringify(event, null, 2);
    summary.onclick = () => { replayIndex = run.events.indexOf(event); selectedNode = eventNode(event); renderArchitecture(currentRun); };
    summary.append(count, title, detail, stamp); details.append(summary, body); element('trace').append(details);
  }
  if (eventCount !== run.events.length) renderChart(run.events);
  eventCount = run.events.length;
  element('last-event').textContent = run.events.length ? `Event ${eventCount} / ${time(run.events.at(-1).at)}` : '-';
  const pending = run.pending && state.activeId === run.id;
  element('approval').hidden = !pending;
  if (pending) {
    approvalId = run.pending.id;
    element('approval-name').textContent = run.pending.name;
    element('approval-preview').textContent = JSON.stringify(run.pending.args, null, 2);
    element('approve').disabled = false; element('deny').disabled = false;
  } else approvalId = null;
  renderArchitecture(run);
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    state = await api('/api/state');
    displayIdentity(); renderMemory();
    if (!selectedId) selectedId = state.activeId || state.runs[0]?.id;
    renderHistory();
    element('start').disabled = Boolean(state.activeId);
    element('cancel').disabled = !state.activeId;
    const requestedId = selectedId;
    if (requestedId) {
      const run = await api(`/api/runs/${requestedId}`);
      if (selectedId === requestedId) renderRun(run);
    } else { renderChart([]); renderArchitecture(null); }
  } finally { busy = false; }
}

async function guardedRefresh() { try { await refresh(); showError(null); } catch (error) { showError(error); element('connection').textContent = 'Disconnected'; element('connection').classList.remove('verified'); } }
element('scenario').onchange = () => { const scenario = element('scenario').value; setComposer(null); element('scenario').value = scenario; element('prompt').value = scenarios[scenario]; element('start').disabled = Boolean(state?.activeId); };
element('prompt').value = scenarios.travel;
element('prompt').oninput = () => { composerRevision++; };
element('task-form').onsubmit = async event => {
  event.preventDefault(); element('start').disabled = true;
  const submittedRevision = composerRevision;
  try {
    if (composeParentId && (currentRun?.id !== composeParentId || currentRun.status !== 'completed')) throw new Error('Select a completed run to continue, or start a new conversation.');
    const result = await api('/api/runs', { prompt: element('prompt').value, maxSteps: Number(element('max-steps').value), memoryEnabled: element('memory-enabled').checked, ...(composeParentId ? { parentRunId: composeParentId } : {}) });
    if (composerRevision === submittedRevision) {
      selectedId = result.id; setComposer(result.id); eventCount = 0; replayIndex = null; element('trace').replaceChildren();
    }
    await refresh(); showError(null);
  } catch (error) { showError(error); element('start').disabled = Boolean(state?.activeId); }
};
element('cancel').onclick = async () => { try { await api(`/api/runs/${state.activeId}/cancel`, {}); await guardedRefresh(); } catch (error) { showError(error); } };
async function decide(allow) {
  element('approve').disabled = true; element('deny').disabled = true;
  try { await api(`/api/runs/${selectedId}/approval`, { approvalId, allow }); await guardedRefresh(); } catch (error) { showError(error); }
}
element('approve').onclick = () => decide(true);
element('deny').onclick = () => decide(false);
element('refresh').onclick = guardedRefresh;
for (const name of ['overview', 'trace', 'memory', 'runtime']) element(`tab-${name}`).onclick = () => {
  for (const other of ['overview', 'trace', 'memory', 'runtime']) {
    element(`${other}-panel`).hidden = other !== name;
    element(`tab-${other}`).classList.toggle('active', other === name);
    element(`tab-${other}`).setAttribute('aria-pressed', String(other === name));
  }
  renderChart(currentRun?.events || []);
};
for (const button of document.querySelectorAll('[data-node]')) button.onclick = () => { selectedNode = button.dataset.node; renderArchitecture(currentRun); };
element('event-slider').oninput = () => { replayIndex = Number(element('event-slider').value); selectedNode = eventNode(currentRun.events[replayIndex]); renderArchitecture(currentRun); };
element('event-prev').onclick = () => { replayIndex = Math.max(0, (replayIndex ?? currentRun.events.length - 1) - 1); selectedNode = eventNode(currentRun.events[replayIndex]); renderArchitecture(currentRun); };
element('event-next').onclick = () => { replayIndex = Math.min(currentRun.events.length - 1, (replayIndex ?? currentRun.events.length - 1) + 1); selectedNode = eventNode(currentRun.events[replayIndex]); renderArchitecture(currentRun); };
element('event-live').onclick = () => { replayIndex = null; renderArchitecture(currentRun); };
element('new-run').onclick = () => { setComposer(null); element('start').disabled = Boolean(state?.activeId); element('prompt').focus(); };
element('continue-run').onclick = () => { setComposer(selectedId); element('prompt').focus(); };
element('theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; renderChart(currentRun?.events || []); };
window.addEventListener('resize', () => renderChart(currentRun?.events || []));
icons();
void guardedRefresh();
setInterval(guardedRefresh, 1500);