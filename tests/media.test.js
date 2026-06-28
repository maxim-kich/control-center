'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

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

function mediaUrl(base, project, name) {
  const q = new URLSearchParams({ project, name });
  return `${base}/api/media?${q}`;
}

async function assertStatus(r, status) {
  if (r.status !== status) assert.equal(r.status, status, await r.text());
}

test('media uploads save raw bytes for JSON-typed and empty files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-media-'));
  const workspace = path.join(tmp, 'workspace');
  const project = path.join(workspace, 'project');
  const codexHome = path.join(tmp, 'codex-home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const stderr = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CC_WORKSPACE_ROOT: workspace,
      CC_DB_PATH: path.join(tmp, 'tasks.db'),
      CODEX_HOME: codexHome,
      CC_CODEX_STATE_DB: path.join(codexHome, 'state_5.sqlite'),
      CC_CODEX_BIN: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForHealth(base, child, stderr);

    const validJson = '{"ok":true}\n';
    let r = await fetch(mediaUrl(base, project, 'data.json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validJson,
    });
    await assertStatus(r, 201);
    let item = await r.json();
    assert.equal(item.size, Buffer.byteLength(validJson));
    assert.equal(fs.readFileSync(path.join(project, 'USER_UPLOADS', 'data.json'), 'utf8'), validJson);

    const invalidJsonBytes = 'not-json\n';
    r = await fetch(mediaUrl(base, project, 'bad.json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: invalidJsonBytes,
    });
    await assertStatus(r, 201);
    item = await r.json();
    assert.equal(item.size, Buffer.byteLength(invalidJsonBytes));
    assert.equal(fs.readFileSync(path.join(project, 'USER_UPLOADS', 'bad.json'), 'utf8'), invalidJsonBytes);

    r = await fetch(mediaUrl(base, project, 'empty.txt'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '',
    });
    await assertStatus(r, 201);
    item = await r.json();
    assert.equal(item.size, 0);

    r = await fetch(`${base}/api/media?${new URLSearchParams({ project })}`);
    await assertStatus(r, 200);
    const list = await r.json();
    assert.deepEqual(list.files.map((f) => f.name).sort(), ['bad.json', 'data.json', 'empty.txt']);
  } finally {
    await stopServer(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
