'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error('Timed out waiting for review flow');
}

test('approval gates task mutations, survives review cancellation, and permits a launch without bypass', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-flow-'));
  const home = path.join(dir, 'codex');
  fs.mkdirSync(home);
  const fake = path.join(dir, 'codex-cli');
  fs.writeFileSync(fake, '#!/usr/bin/env node\n' + fs.readFileSync(path.join(__dirname, 'fixtures/hookAwareCodex.cjs'), 'utf8'), { mode: 0o755 });
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), CONTROL_CENTER_HOME: path.join(dir, 'cc'),
      CC_WORKSPACE_ROOT: dir, CC_DB_PATH: path.join(dir, 'tasks.db'), CODEX_HOME: home, CC_CODEX_BIN: fake,
      CC_GRAPHIFY_ENABLED: 'false', CC_GRAPHIFY_WATCH: 'false' }, stdio: 'ignore',
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    const stopped = once(child, 'exit');
    child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped; clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await request('/api/projects', 'POST', { path: dir, graphify_enabled: false })).status, 201);
  const { data: task } = await request('/api/tasks', 'POST', { title: 'Hook approval test', project_path: dir, model: 'gpt-5.6-sol', mode: 'build', yolo: true });
  assert.ok(task.id, JSON.stringify(task));
  const blocked = await request(`/api/tasks/${task.id}/start`, 'POST');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'HOOK_TRUST_REQUIRED');
  const readTask = async () => (await request('/api/tasks')).data.find((item) => item.id === task.id);
  assert.equal((await readTask()).status, 'backlog');
  assert.equal((await readTask()).started_at, null);
  const openReview = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hook-review?taskId=${task.id}`, { origin: base });
    sockets.push(ws);
    let output = '';
    ws.on('message', (raw) => { output += raw.toString(); });
    await until(() => output.includes('Hooks need review'));
    return ws;
  };
  const first = await openReview();
  first.close();
  await until(() => fs.existsSync(path.join(home, 'review-stopped')));
  assert.equal((await readTask()).status, 'backlog');
  assert.equal((await request('/api/tasks')).data.length, 1, 'review must not create a task');
  assert.equal((await request(`/api/tasks/${task.id}/hook-trust`)).data.ready, false);
  const second = await openReview();
  second.send(JSON.stringify({ t: 'data', d: 'approve\r' }));
  await until(async () => (await request(`/api/tasks/${task.id}/hook-trust`)).data.ready);
  second.close();
  assert.equal((await request(`/api/tasks/${task.id}/start`, 'POST')).status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?taskId=${task.id}`, { origin: base });
  sockets.push(ws);
  await until(async () => (await readTask()).live);
  await until(() => fs.readFileSync(path.join(home, 'launches.jsonl'), 'utf8').includes('"review":false'));
  const launches = fs.readFileSync(path.join(home, 'launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(launches.filter((launch) => launch.review).length, 2);
  const actual = launches.find((launch) => !launch.review);
  assert.ok(actual);
  for (const launch of launches) assert.ok(!launch.args.includes('--dangerously-bypass-hook-trust'));
  for (const launch of launches.filter((launch) => launch.review)) {
    assert.equal(launch.taskId, undefined);
    assert.ok(!launch.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  }
  assert.ok(actual.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  // Trust revoked between sessions must gate direct terminal reconnects too.
  ws.send(JSON.stringify({ t: 'stop' }));
  await until(async () => !(await readTask()).live);
  execFileSync(process.execPath, [path.join(ROOT, '.codex-dashboard/hooks/task_event.js'), 'SessionStart'], {
    env: { ...process.env, CC_TASK_ID: task.id, CC_DB_PATH: path.join(dir, 'tasks.db') },
    input: JSON.stringify({ session_id: 'test-resume-session', cwd: dir }),
  });
  fs.unlinkSync(path.join(home, 'trusted'));
  for (const action of ['resume', 'fork']) {
    const result = await request(`/api/tasks/${task.id}/${action}`, 'POST');
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'HOOK_TRUST_REQUIRED');
  }
  assert.equal((await request('/api/tasks')).data.length, 1, 'blocked fork must not create a child');
  const reconnect = new WebSocket(`ws://127.0.0.1:${port}/pty?taskId=${task.id}`, { origin: base });
  sockets.push(reconnect);
  let blockedReconnect = false;
  reconnect.on('message', (raw) => { if (JSON.parse(raw).t === 'hook-trust-required') blockedReconnect = true; });
  await until(() => blockedReconnect);
  assert.equal((await readTask()).live, false);
});
