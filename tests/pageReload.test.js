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
const { projectGitApiFieldsAsync, clearProjectGitCache } = require('../lib/gitRoots');
const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function checkStartupDiagnostics(t, stalledVersion) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reload-'));
  const marker = path.join(tmp, 'doctor-called');
  const versionMarker = path.join(tmp, 'version-called');
  const cli = path.join(tmp, 'codex');
  fs.writeFileSync(cli, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  touch "$CC_TEST_VERSION_MARKER"\n  if [ "$CC_TEST_STALL_VERSION" != "true" ]; then echo codex-test; exit 0; fi\n  trap "" TERM\n  while :; do :; done\nfi\nif [ "$1" = "doctor" ]; then\n  touch "$CC_TEST_DOCTOR_MARKER"\n  sleep 1\n  echo \'{"checks":{"auth.credentials":{"status":"ok"}}}\'\nelse\n  echo codex-test\nfi\n', { mode: 0o755 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CONTROL_CENTER_HOME: tmp,
      CC_DB_PATH: path.join(tmp, 'data', 'tasks.db'), CC_WORKSPACE_ROOT: tmp,
      CODEX_HOME: path.join(tmp, 'codex-home'), CC_CODEX_BIN: cli,
      CC_TEST_DOCTOR_MARKER: marker, CC_TEST_VERSION_MARKER: versionMarker,
      CC_TEST_STALL_VERSION: String(stalledVersion), CC_GRAPHIFY_ENABLED: 'false', CC_GRAPHIFY_WATCH: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
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
  while (!output.includes('  db:') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(output.includes('  db:'), 'startup banner must finish');
  assert.equal(fs.existsSync(versionMarker), false, 'startup must not probe the CLI version');
  const tasks = await fetch(`${base}/api/tasks`, { signal: AbortSignal.timeout(1000) });
  assert.equal(tasks.status, 200);
  assert.deepEqual(await tasks.json(), []);
  const health = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(health.codexVersion, stalledVersion ? null : 'codex-test');
  assert.equal(fs.existsSync(versionMarker), true, 'health exercises the version fixture');
  assert.equal(fs.existsSync(marker), true, 'fixture must exercise real diagnostics on health');
  assert.equal(health.codexAuthConfigured, true, 'existing diagnostic contract is preserved');
}

for (const stalledVersion of [false, true]) {
  test(`startup and page bootstrap skip CLI diagnostics (stalled version: ${stalledVersion})`,
    (t) => checkStartupDiagnostics(t, stalledVersion));
}

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
    async loadHealth() {}, async loadModelCatalog() {}, restoreUiStateForBoot() {}, restoreLoadingStep() {},
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

test('Git metadata cache returns copies, expires, and detects repository creation', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-cache-'));
  t.after(() => { clearProjectGitCache(); fs.rmSync(tmp, { recursive: true, force: true }); });
  clearProjectGitCache();
  assert.equal((await projectGitApiFieldsAsync(tmp)).git_initialized, 0);
  execFileSync('git', ['init', '-q', tmp]);
  const fields = await projectGitApiFieldsAsync(tmp);
  assert.equal(fields.git_initialized, 1);
  fields.git_repo_root = 'modified by consumer';
  assert.equal((await projectGitApiFieldsAsync(tmp)).git_repo_root, fs.realpathSync(tmp));
  const originalNow = Date.now;
  t.mock.method(Date, 'now', () => originalNow() + 6000);
  assert.equal((await projectGitApiFieldsAsync(tmp)).git_initialized, 1);
  clearProjectGitCache();
  fs.rmSync(path.join(tmp, '.git'), { recursive: true });
  assert.equal((await projectGitApiFieldsAsync(tmp)).git_initialized, 0);
});

test('slow project Git probes leave readiness and bootstrap responsive after cache expiry', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-slow-git-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(tmp, 'git-calls');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'rev-parse') fs.appendFileSync(process.env.CC_TEST_GIT_MARKER, 'probe\\n');
setTimeout(() => {
  const result = spawnSync(process.env.CC_TEST_REAL_GIT, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}, 400);
`, { mode: 0o755 });
  const own = path.join(tmp, 'own');
  const parent = path.join(tmp, 'parent');
  const nested = path.join(parent, 'nested');
  const none = path.join(tmp, 'none');
  for (const dir of [own, nested, none]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [own, parent]) execFileSync(realGit, ['init', '-q', dir]);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: String(port),
      CONTROL_CENTER_HOME: tmp, CC_DB_PATH: path.join(tmp, 'data', 'tasks.db'),
      CC_WORKSPACE_ROOT: tmp, CODEX_HOME: path.join(tmp, 'codex-home'),
      CC_GRAPHIFY_ENABLED: 'false', CC_GRAPHIFY_WATCH: 'false',
      CC_TEST_GIT_MARKER: marker, CC_TEST_REAL_GIT: realGit },
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
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, errors);
    try {
      ready = (await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(500) })).ok;
      if (ready) break;
    } catch { /* waiting for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, errors);
  for (const dir of [own, nested, none]) {
    const response = await fetch(`${base}/api/projects`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, graphify_enabled: false }) });
    assert.equal(response.status, 201, await response.text());
  }
  const calls = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  for (const phase of ['cold', 'expired']) {
    if (phase === 'expired') await new Promise((resolve) => setTimeout(resolve, 5100));
    const before = calls();
    let finished = false;
    const started = performance.now();
    const projectsRequest = fetch(`${base}/api/projects`).then(async (response) => {
      assert.equal(response.status, 200);
      const body = await response.json();
      finished = true;
      return body.projects;
    });
    const probeDeadline = Date.now() + 3000;
    while (calls() === before && Date.now() < probeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(calls() > before, 'delayed Git fixture must be running');
    const concurrentRequest = fetch(`${base}/api/projects`).then((response) => response.json());
    const timings = {};
    for (const endpoint of ['ready', 'bootstrap']) {
      const start = performance.now();
      const response = await fetch(`${base}/api/${endpoint}`, { signal: AbortSignal.timeout(800) });
      assert.equal(response.status, 200);
      await response.text();
      timings[endpoint] = Math.round(performance.now() - start);
      assert.equal(finished, false, `${endpoint} must finish while Git metadata is pending`);
    }
    const projects = await projectsRequest;
    assert.deepEqual((await concurrentRequest).projects, projects);
    const projectMs = Math.round(performance.now() - started);
    assert.equal(calls() - before, 3, 'overlapping requests share one probe per project');
    const byPath = new Map(projects.map((project) => [project.path, project]));
    assert.equal(byPath.get(own).git_repo_kind, 'own');
    assert.equal(byPath.get(own).git_repo_root, fs.realpathSync(own));
    assert.equal(byPath.get(nested).git_repo_kind, 'parent');
    assert.equal(byPath.get(nested).git_parent_repo_root, fs.realpathSync(parent));
    assert.match(byPath.get(nested).git_warning, /will not run project Git operations/);
    assert.equal(byPath.get(none).git_repo_kind, 'none');
    const cachedStart = performance.now();
    const cached = await (await fetch(`${base}/api/projects`)).json();
    assert.deepEqual(cached.projects, projects);
    assert.equal(calls() - before, 3, 'warm requests do not spawn Git');
    t.diagnostic(`${phase}: projects=${projectMs}ms ready=${timings.ready}ms bootstrap=${timings.bootstrap}ms cached=${Math.round(performance.now() - cachedStart)}ms`);
  }
});

test('invalidating pending Git metadata prevents stale cache writes and failures fall back safely', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-inflight-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const probes = [];
  const context = {
    require(name) {
      if (name === 'child_process') return {
        execFile(command, args, options, callback) { probes.push(callback); },
      };
      return require(name);
    },
    module: { exports: {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'lib/gitRoots.js'), 'utf8'), context);
  const api = context.module.exports;
  const stale = api.projectGitApiFieldsAsync(tmp);
  const shared = api.projectGitApiFieldsAsync(tmp);
  assert.equal(probes.length, 1);
  api.clearProjectGitCache();
  const fresh = api.projectGitApiFieldsAsync(tmp);
  assert.equal(probes.length, 2);
  probes[1](new Error('Git failed or timed out'), '');
  assert.equal((await fresh).git_repo_kind, 'none');
  probes[0](null, path.dirname(tmp));
  assert.equal((await stale).git_repo_kind, 'parent');
  const sharedFields = await shared;
  sharedFields.git_repo_kind = 'consumer mutation';
  assert.equal((await stale).git_repo_kind, 'parent');
  assert.equal((await api.projectGitApiFieldsAsync(tmp)).git_repo_kind, 'none', 'old probe cannot replace fresh cache');
  assert.equal(probes.length, 2);
  fs.mkdirSync(path.join(tmp, '.git'));
  const own = api.projectGitApiFieldsAsync(tmp);
  assert.equal(probes.length, 3, 'repository creation bypasses cached absence');
  probes[2](new Error('Git failed or timed out'), '');
  assert.equal((await own).git_repo_kind, 'own');
  assert.equal((await own).git_repo_root, tmp);
});
