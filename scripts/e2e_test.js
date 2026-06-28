'use strict';

// Optional full-stack smoke test. Requires a running server at BASE.
// It only launches real Codex when CC_REAL_CODEX=1 is set.

const WebSocket = require('ws');

const BASE = process.env.CC_DASHBOARD_BASE || 'http://127.0.0.1:3000';
const PROJ = process.env.CC_E2E_PROJECT || process.cwd();

const j = async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const health = await j('GET', '/api/health');
  console.log('server:', BASE);
  console.log('codex:', health.codexBin, health.codexVersion || '(not found)');
  console.log('workspace:', health.workspaceRoot);

  if (process.env.CC_REAL_CODEX !== '1') {
    console.log('Real Codex launch skipped. Set CC_REAL_CODEX=1 to run the full smoke test.');
    process.exit(0);
  }

  const task = await j('POST', '/api/tasks', {
    title: 'E2E Codex probe',
    description: 'Reply with the single word PONG and nothing else. Do not use tools.',
    project_path: PROJ,
    model: process.env.CC_E2E_MODEL || 'gpt-5.4-mini',
    effort: 'low',
    yolo: false,
  });
  console.log('task:', task.id);
  await j('POST', `/api/tasks/${task.id}/start`);

  let out = '';
  const ws = new WebSocket(`ws://${new URL(BASE).host}/pty?taskId=${task.id}`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 32 })));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.t === 'data') out += m.d;
    } catch {}
  });

  const deadline = Date.now() + 90000;
  let current = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    const tasks = await j('GET', '/api/tasks');
    current = tasks.find((x) => x.id === task.id);
    if (current && current.session_id && /PONG/i.test(out)) break;
  }

  console.log('\n--- RESULTS ---');
  console.log('task.status:', current && current.status);
  console.log('task.session_id:', current && current.session_id);
  console.log('terminal saw PONG:', /PONG/i.test(out));

  if (current && current.session_id) {
    const conv = await j('GET', `/api/tasks/${task.id}/conversation`);
    console.log('transcript:', conv.transcriptPath);
    console.log('events:', conv.events && conv.events.length);
    console.log('tool calls:', conv.counts && conv.counts.toolCalls);
  }

  await j('POST', `/api/tasks/${task.id}/done`);
  await sleep(500);
  await j('POST', `/api/tasks/${task.id}/archive`);
  try { ws.close(); } catch {}
  process.exit(current && current.session_id ? 0 : 1);
})().catch((err) => {
  console.error('E2E error:', err);
  process.exit(1);
});
