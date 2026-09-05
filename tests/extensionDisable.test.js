'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');

test('disabling an extension preserves other live instances and excludes disabled hooks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-disable-'));
  const eventsFile = path.join(dir, 'events.jsonl');
  for (const id of ['observer', 'target']) {
    const ext = path.join(dir, 'extensions', id);
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'extension.json'), JSON.stringify({
      apiVersion: 1, id, name: id, version: '1.0.0', server: 'server.js',
      permissions: ['hooks:lifecycle'],
      hooks: { 'app.started': {}, 'app.stopping': {}, 'project.created': {} },
    }));
    fs.writeFileSync(path.join(ext, 'server.js'), `
      const fs = require('node:fs');
      let running = false;
      const log = (event) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ id: '${id}', event, running }) + '\\n');
      exports.register = () => log('registered');
      exports.hooks = {
        'app.started'() { running = true; log('started'); },
        'app.stopping'() { running = false; log('stopped'); },
        'project.created'() { log('project'); },
      };
    `);
  }
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CONTROL_CENTER_HOME: dir,
      CC_DB_PATH: path.join(dir, 'data', 'tasks.db'), CC_WORKSPACE_ROOT: dir,
      CC_CODEX_BIN: path.join(dir, 'missing-codex'), CC_CLAUDE_BIN: path.join(dir, 'missing-claude') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const events = () => fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const deadline = Date.now() + 15000;
  while (!events().some((e) => e.id === 'observer' && e.event === 'started') && Date.now() < deadline) {
    assert.equal(child.exitCode, null, errors);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.ok(events().some((e) => e.id === 'observer' && e.event === 'started'));
  const base = `http://127.0.0.1:${port}`;
  const post = (url, body = {}) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const before = events().length;
  assert.equal((await post('/api/extensions/missing/disable')).status, 400);
  assert.equal(events().length, before, 'invalid requests must leave all runtimes alone');
  const response = await post('/api/extensions/target/disable');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.extensions.extensions.find((e) => e.id === 'observer').enabled, true);
  assert.equal(payload.extensions.extensions.find((e) => e.id === 'target').enabled, false);
  assert.deepEqual(events().slice(before), [{ id: 'target', event: 'stopped', running: false }]);
  assert.equal((await post('/api/extensions/target/disable')).status, 200);
  assert.equal(events().length, before + 1, 'repeated disable must not stop an extension twice');
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath);
  assert.equal((await post('/api/projects', { path: projectPath, graphify_enabled: false })).status, 201);
  assert.deepEqual(events().slice(before + 1), [{ id: 'observer', event: 'project', running: true }]);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.deepEqual(events().at(-1), { id: 'observer', event: 'stopped', running: false });
  assert.equal(events().slice(before).filter((e) => e.id === 'target' && e.event === 'stopped').length, 1);
});
