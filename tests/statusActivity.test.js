'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');

function unloadDbModule() {
  delete require.cache[require.resolve('../lib/db')];
}

function loadDb(dbPath) {
  process.env.CC_DB_PATH = dbPath;
  unloadDbModule();
  return require('../lib/db');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, stderr) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${stderr.join('')}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* server not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${stderr.join('')}`);
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function writeFakeCodex(file) {
  fs.writeFileSync(file, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-codex 1.0.0');
  process.exit(0);
}
if (args[0] === 'doctor') {
  console.log(JSON.stringify({ checks: { 'auth.credentials': { status: 'ok' } } }));
  process.exit(0);
}
if (args[0] === 'app-server') {
  require(${JSON.stringify(path.join(__dirname, 'fixtures/hookAwareCodex.cjs'))}).serveHooks({ trusted: true });
} else {
console.log('fake codex ready');
process.stdin.resume();
setInterval(() => {}, 1000);
}
`);
  fs.chmodSync(file, 0o755);
}

function readTask(dbPath, taskId) {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  } finally {
    raw.close();
  }
}

async function fetchTask(base, taskId) {
  const r = await fetch(`${base}/api/tasks`);
  if (r.status !== 200) assert.equal(r.status, 200, await r.text());
  const tasks = await r.json();
  return tasks.find((t) => t.id === taskId);
}

test('Codex Stop and interruption reach needs-attention; subsequent prompts resume running', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-status-'));
  const workspace = path.join(tmp, 'workspace');
  const project = path.join(workspace, 'project');
  const codexHome = path.join(tmp, 'codex-home');
  const dbPath = path.join(tmp, 'tasks.db');
  const fakeCodex = path.join(tmp, 'fake-codex.js');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const rollout = path.join(tmp, 'rollout.jsonl');
  fs.writeFileSync(rollout, '');
  writeFakeCodex(fakeCodex);

  const db = loadDb(dbPath);
  db.createProject({ path: project, graphify_enabled: 0 });
  const task = db.createTask({ title: 'waiting for input', project_path: project, status: 'in_progress' });
  db.updateTask(task.id, {
    session_id: 'sess-1',
    started_at: db.now(),
    ended_at: null,
    activity: 'idle',
  });
  db.upsertSession({ session_id: 'sess-1', task_id: task.id, kind: 'start', cwd: project });
  db.db.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const stderr = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONTROL_CENTER_HOME: path.join(tmp, 'home'),
      CC_EXTENSIONS_DIR: path.join(tmp, 'extensions'),
      PORT: String(port),
      CC_WORKSPACE_ROOT: workspace,
      CC_DB_PATH: dbPath,
      CODEX_HOME: codexHome,
      CC_CODEX_STATE_DB: path.join(codexHome, 'state_5.sqlite'),
      CC_CODEX_BIN: fakeCodex,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForHealth(base, child, stderr);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?taskId=${encodeURIComponent(task.id)}`, {
      headers: { Origin: base },
    });
    await once(ws, 'open');

    const launchDeadline = Date.now() + 5000;
    while (!(await fetchTask(base, task.id)).live && Date.now() < launchDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    let listed = await fetchTask(base, task.id);
    assert.equal(listed.live, true);
    assert.equal(listed.displayStatus, 'needs_attention');

    const hook = async (event, input) => {
      const child = spawn(process.execPath, [path.join(ROOT, '.codex-dashboard/hooks/task_event.js'), event], {
        env: { ...process.env, CC_DB_PATH: dbPath, CC_TASK_ID: task.id, CC_LOG_DIR: path.join(tmp, 'logs') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stdin.end(JSON.stringify(input));
      const [code] = await once(child, 'close');
      assert.equal(code, 0);
      if (event === 'Stop') assert.deepEqual(JSON.parse(stdout), {});
    };
    await hook('UserPromptSubmit', { session_id: 'sess-1' });
    assert.equal((await fetchTask(base, task.id)).displayStatus, 'running');
    await hook('Stop', { hook_event_name: 'Stop', session_id: readTask(dbPath, task.id).session_id, last_assistant_message: 'Done', stop_hook_active: false });
    const deadline = Date.now() + 3000;
    do {
      listed = await fetchTask(base, task.id);
      if (listed.displayStatus === 'needs_attention') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(listed.displayStatus, 'needs_attention', 'Stop must become visible through the task API within 3 seconds');

    ws.send(JSON.stringify({ t: 'user-input' }));
    ws.send(JSON.stringify({ t: 'data', d: 'editing prompt only' }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    listed = await fetchTask(base, task.id);
    assert.equal(listed.displayStatus, 'needs_attention');
    assert.equal(readTask(dbPath, task.id).activity, 'idle');

    await hook('UserPromptSubmit', { session_id: 'sess-1' });
    assert.equal((await fetchTask(base, task.id)).displayStatus, 'running');

    await hook('SessionStart', { session_id: 'sess-1', transcript_path: rollout, cwd: project });
    await hook('UserPromptSubmit', { session_id: 'sess-1' });
    // Escape does not emit Stop. The provider writes an interruption record
    // while its interactive process stays alive.
    fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(),
      type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }) + '\n');
    const interruptDeadline = Date.now() + 3000;
    do {
      listed = await fetchTask(base, task.id);
      if (listed.displayStatus === 'needs_attention') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < interruptDeadline);
    assert.equal(listed.displayStatus, 'needs_attention');
    assert.equal(listed.activity, 'idle');
    assert.equal(listed.status, 'in_progress');
    assert.equal(listed.live, true);
    await hook('UserPromptSubmit', { session_id: 'sess-1' });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await fetchTask(base, task.id)).displayStatus, 'running', 'old interruption must not override a newer prompt');

    ws.close();
    await Promise.race([once(ws, 'close'), new Promise((resolve) => setTimeout(resolve, 500))]);
  } finally {
    await stopServer(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
