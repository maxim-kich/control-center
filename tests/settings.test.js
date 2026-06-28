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

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}

test('general settings persist and report caffeinate status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-settings-'));
  const workspace = path.join(tmp, 'workspace');
  const codexHome = path.join(tmp, 'codex-home');
  const dbPath = path.join(tmp, 'tasks.db');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const db = loadDb(dbPath);
  db.setMetaValue('settings.caffeinate_enabled', '0');
  db.db.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const stderr = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CC_WORKSPACE_ROOT: workspace,
      CC_DB_PATH: dbPath,
      CODEX_HOME: codexHome,
      CC_CODEX_STATE_DB: path.join(codexHome, 'state_5.sqlite'),
      CC_CODEX_BIN: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForHealth(base, child, stderr);

    let settings = await jsonFetch(`${base}/api/settings/general`);
    assert.equal(settings.caffeinateEnabled, false);
    assert.equal(settings.caffeinate.enabled, false);
    assert.equal(settings.caffeinate.active, false);

    settings = await jsonFetch(`${base}/api/settings/general`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caffeinate_enabled: true }),
    });
    assert.equal(settings.caffeinateEnabled, true);
    assert.equal(settings.caffeinate.enabled, true);
    assert.equal(settings.caffeinate.command, process.platform === 'darwin' ? `/usr/bin/caffeinate -dims -w ${child.pid}` : null);
    if (process.platform === 'darwin') assert.equal(settings.caffeinate.supported, fs.existsSync('/usr/bin/caffeinate'));

    const health = await jsonFetch(`${base}/api/health`);
    assert.equal(health.caffeinate.enabled, true);

    settings = await jsonFetch(`${base}/api/settings/general`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caffeinate_enabled: false }),
    });
    assert.equal(settings.caffeinateEnabled, false);
    assert.equal(settings.caffeinate.active, false);

    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.prepare(`SELECT value FROM app_meta WHERE key = ?`).get('settings.caffeinate_enabled');
      assert.equal(row.value, '0');
    } finally {
      raw.close();
    }
  } finally {
    await stopServer(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
