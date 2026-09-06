'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const ROOT = path.resolve(__dirname, '..');

test('fresh Git Workflow enablement works before and after restart under a parent repository', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-enable-'));
  const parent = path.join(dir, 'parent');
  fs.mkdirSync(parent);
  assert.equal(spawnSync('git', ['init', parent]).status, 0);
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let child;
  async function stop() {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const exited = once(child, 'exit');
    child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    await exited;
    clearTimeout(timer);
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
      env: { ...process.env, PORT: String(port), CONTROL_CENTER_HOME: dir,
        CC_DB_PATH: path.join(dir, 'data', 'tasks.db'), CC_WORKSPACE_ROOT: dir,
        CC_CODEX_BIN: path.join(dir, 'missing-codex'), CC_CLAUDE_BIN: path.join(dir, 'missing-claude') },
      stdio: 'ignore' });
    for (let i = 0; i < 300; i++) {
      assert.equal(child.exitCode, null);
      try { if ((await fetch(base + '/api/ready')).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('server did not become ready');
  }
  async function request(url, method = 'GET', body) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    assert.ok(res.ok, JSON.stringify(data));
    return data;
  }
  await start();
  let settings = await request('/api/extensions');
  const installed = settings.platform.catalog.find((e) => e.id === 'git-workflow').installed;
  if (!installed) await request('/api/extensions/bundled/git-workflow/install', 'POST', { enable: false });
  await request('/api/extensions/git-workflow/disable', 'POST', {});
  await request('/api/extensions/ownership/git', 'PUT', { owner: 'legacy' });
  await stop();
  await start();
  const enabled = await request('/api/extensions/git-workflow/enable', 'POST', {});
  assert.equal(enabled.restartRequired, false);
  assert.equal(enabled.extensions.platform.ownership.git.activeOwner, 'git-workflow');
  const parentConfig = fs.readFileSync(path.join(parent, '.git/config'), 'utf8');
  for (const name of ['before-restart', 'after-restart', 'reenabled']) {
    if (name === 'after-restart') { await stop(); await start(); }
    if (name === 'reenabled') {
      await request('/api/extensions/git-workflow/disable', 'POST', {});
      await request('/api/extensions/git-workflow/enable', 'POST', {});
    }
    settings = await request('/api/extensions');
    assert.equal(settings.platform.ownership.git.activeOwner, 'git-workflow');
    const projectPath = path.join(parent, name);
    fs.mkdirSync(projectPath);
    const created = await request('/api/projects', 'POST', { path: projectPath, graphify_enabled: false });
    const project = created.project || created;
    const endpoint = `/api/extensions/git-workflow/projects/${project.id}`;
    assert.equal((await request(endpoint + '/status')).git.git_repo_kind, 'parent');
    const initialized = await request(endpoint + '/init', 'POST', {});
    assert.equal(initialized.git.git_repo_kind, 'own');
    assert.equal((await request(endpoint + '/init', 'POST', {})).init.initialized, false);
  }
  assert.equal(fs.readFileSync(path.join(parent, '.git/config'), 'utf8'), parentConfig);
});

test('Git contributions appear only for the active owner', async () => {
  const window = { dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/extensions-runtime.js'), 'utf8'), {
    window, CustomEvent: function () {},
  });
  const runtime = window.ControlCenterExtensions;
  for (const activeOwner of ['legacy', 'git-workflow', 'legacy']) {
    await runtime.configure({ extensions: [{ id: 'git-workflow', enabled: true, ownership: ['git'],
      contributes: { projectBadges: [{ id: 'git-status' }], projectFields: [{ id: 'init' }] } }],
      platform: { ownership: { git: { activeOwner } } } });
    const expected = activeOwner === 'git-workflow' ? 1 : 0;
    assert.equal(runtime.contributions('projectBadges').length, expected);
    assert.equal(runtime.contributions('projectFields').length, expected);
  }
});
