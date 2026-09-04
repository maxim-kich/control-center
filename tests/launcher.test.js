'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const launcher = fs.readFileSync(path.join(__dirname, '../scripts/launch_macos_app.sh'), 'utf8');

async function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launcher-'));
  const home = path.join(root, 'runtime');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  // Only suppress native UI in the test copy; use real curl, nc, bash and Node.
  fs.writeFileSync(path.join(root, 'launcher.sh'), launcher
    .replaceAll('/usr/bin/osascript', '/usr/bin/true')
    .replace('/usr/bin/open "$URL"', 'printf "%s\\n" "$URL" >> "$CONTROL_CENTER_HOME/opened"'));
  fs.writeFileSync(path.join(root, 'server.js'), `
    const fs = require('node:fs');
    const http = require('node:http');
    fs.appendFileSync(process.env.CONTROL_CENTER_HOME + '/starts', 'start\\n');
    const readyAt = Date.now() + (process.env.MODE === 'warming' ? 1200 : 0);
    const server = http.createServer((req, res) => {
      fs.appendFileSync(process.env.CONTROL_CENTER_HOME + '/requests', req.url + '\\n');
      if (req.url === '/api/health') return; // Diagnostic never completes.
      if (process.env.MODE === 'unrelated') return res.end('unrelated app');
      if (process.env.MODE === 'unready' || Date.now() < readyAt) {
        res.writeHead(503); return res.end('starting');
      }
      if (req.url === '/api/ready') return res.end('control-center\\n');
      res.writeHead(404); res.end();
    });
    setTimeout(() => server.listen(Number(process.env.PORT), '127.0.0.1', () => {
      if (process.send) process.send('listening');
    }), process.env.MODE === 'delayed' ? 1200 : 0);
  `);
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const env = { ...process.env, CONTROL_CENTER_HOME: home, CC_DASHBOARD_ROOT: root,
    NODE_BIN: process.execPath, PORT: String(port), MODE: mode, SHELL: '/bin/bash' };
  let existing;
  const pidFile = path.join(home, 'data/control-center.pid');
  t.after(async () => {
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : existing?.pid;
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
    if (existing && existing.exitCode == null && existing.signalCode == null) await once(existing, 'exit');
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (mode !== 'delayed') {
    existing = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await once(existing, 'message');
    // Even a matching node server.js process and PID file do not authorize killing.
    fs.writeFileSync(pidFile, String(existing.pid));
  }
  const child = spawn('/bin/bash', [path.join(root, 'launcher.sh')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  t.after(() => clearTimeout(timer));
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(pid, 0), 'launcher must leave the server alive');
  assert.equal(fs.readFileSync(path.join(home, 'starts'), 'utf8'), 'start\n', 'must not start a duplicate');
  const requests = fs.readFileSync(path.join(home, 'requests'), 'utf8').trim().split('\n');
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => url === '/api/ready'), 'must never invoke diagnostics');
  return { code, errors, opened: fs.existsSync(path.join(home, 'opened')), requests };
}

test('macOS launcher readiness', { skip: process.platform !== 'darwin', concurrency: true }, async (t) => {
  await Promise.all([
    t.test('waits for delayed startup', async (t) => {
      const result = await fixture(t, 'delayed');
      assert.equal(result.code, 0, result.errors);
      assert.equal(result.opened, true);
    }),
    t.test('reuses an already-running server that is still warming up', async (t) => {
      const result = await fixture(t, 'warming');
      assert.equal(result.code, 0, result.errors);
      assert.equal(result.opened, true);
      assert.ok(result.requests.length > 1);
    }),
    t.test('rejects an unrelated listener without killing or opening it', async (t) => {
      const result = await fixture(t, 'unrelated');
      assert.equal(result.code, 1, result.errors);
      assert.equal(result.opened, false);
    }),
    t.test('readiness timeout leaves an existing server alive', async (t) => {
      const result = await fixture(t, 'unready');
      assert.equal(result.code, 1, result.errors);
      assert.equal(result.opened, false);
    }),
  ]);
});
