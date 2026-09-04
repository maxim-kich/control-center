'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { projectGitApiFields, clearProjectGitCache } = require('../lib/gitRoots');
const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('page bootstrap restores provider configuration without invoking slow CLI diagnostics', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reload-'));
  const marker = path.join(tmp, 'doctor-called');
  const cli = path.join(tmp, 'codex');
  fs.writeFileSync(cli, '#!/bin/sh\nif [ "$1" = "doctor" ]; then\n  touch "$CC_TEST_DOCTOR_MARKER"\n  sleep 1\n  echo \'{"checks":{"auth.credentials":{"status":"ok"}}}\'\nelse\n  echo codex-test\nfi\n', { mode: 0o755 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CONTROL_CENTER_HOME: tmp,
      CC_DB_PATH: path.join(tmp, 'data', 'tasks.db'), CC_WORKSPACE_ROOT: tmp,
      CODEX_HOME: path.join(tmp, 'codex-home'), CC_CODEX_BIN: cli,
      CC_TEST_DOCTOR_MARKER: marker, CC_GRAPHIFY_ENABLED: 'false', CC_GRAPHIFY_WATCH: 'false' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15000;
  let boot;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, errors);
    try {
      const response = await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { boot = await response.json(); break; }
    } catch { /* waiting for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(boot, errors);
  assert.ok(boot.bootId);
  assert.equal(boot.modelConfiguration.activeProvider, 'codex');
  assert.equal(boot.modelConfiguration.providers.find((p) => p.id === 'claude').modes.includes('auto'), true);
  assert.equal(boot.modelConfiguration.providers.find((p) => p.active).defaultModel, 'gpt-5.6-sol');
  assert.equal('codexAuthConfigured' in boot, false);
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${base}/api/bootstrap`);
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal(fs.existsSync(marker), false, 'reload must not run doctor, regardless of its cache');
  const ready = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1000) });
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), 'control-center\n');
  assert.equal(fs.existsSync(marker), false, 'readiness must not run CLI diagnostics');
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(fs.existsSync(marker), true, 'fixture must exercise real diagnostics on health');
  assert.equal(health.codexAuthConfigured, true, 'existing diagnostic contract is preserved');
});

test('startup fetches concurrently but restores tasks and tabs after projects and extensions', async () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const init = app.slice(app.indexOf('async function init() {'), app.indexOf('let startupComplete = false;'));
  const started = [];
  const finished = [];
  const resolvers = {};
  const pending = (key) => {
    started.push(key);
    return new Promise((resolve) => { resolvers[key] = () => { finished.push(key); resolve(key === 'tasks' ? [{ id: 'task' }] : undefined); }; });
  };
  const context = {
    showRestoreLoading() {}, enhanceCustomSelect() {}, $() {}, notifier: { init() {} },
    async loadHealth() {}, restoreUiStateForBoot() {}, restoreLoadingStep() {},
    loadExtensions: () => pending('extensions'), loadProjects: () => pending('projects'),
    api: { get: () => pending('tasks') }, archivesAreVisible: () => true,
    loadArchived: () => pending('archive'), syncArchiveToggles() {},
    sessionStorage: { getItem() {} }, safeJsonParse() {}, applyCollapsedProjectSections() {},
    UI_STATE_KEY: 'state', currentPage: 'dashboard',
    async refresh(force, tasks) {
      assert.equal(force, true);
      assert.equal(tasks[0].id, 'task');
      assert.equal(finished.length, 4);
      started.push('restore');
    },
    setPage() { assert.equal(started.at(-1), 'restore'); },
    persistUiState() {}, hideRestoreLoading() {}, setTimeout() {}, loadMigrationWelcome() {},
  };
  vm.createContext(context);
  vm.runInContext(init, context);
  const result = context.init();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['extensions', 'projects', 'tasks', 'archive']);
  resolvers.tasks(); resolvers.archive(); resolvers.projects(); resolvers.extensions();
  await result;
});

test('Git metadata cache returns copies, expires, and detects repository creation', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-cache-'));
  t.after(() => { clearProjectGitCache(); fs.rmSync(tmp, { recursive: true, force: true }); });
  clearProjectGitCache();
  assert.equal(projectGitApiFields(tmp).git_initialized, 0);
  execFileSync('git', ['init', '-q', tmp]);
  const fields = projectGitApiFields(tmp);
  assert.equal(fields.git_initialized, 1);
  fields.git_repo_root = 'modified by consumer';
  assert.equal(projectGitApiFields(tmp).git_repo_root, fs.realpathSync(tmp));
  const originalNow = Date.now;
  t.mock.method(Date, 'now', () => originalNow() + 6000);
  assert.equal(projectGitApiFields(tmp).git_initialized, 1);
  clearProjectGitCache();
  fs.rmSync(path.join(tmp, '.git'), { recursive: true });
  assert.equal(projectGitApiFields(tmp).git_initialized, 0);
});
