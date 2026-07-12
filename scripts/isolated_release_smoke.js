#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const PREVIOUS_REF = process.env.CC_SMOKE_PREVIOUS_REF || 'v0.1.0';
const KEEP = process.env.CC_SMOKE_KEEP === '1';
const MIGRATION_LEDGER_KEY = 'updates.bundled_integration_migration.ledger.v1';

function run(cwd, command, args, opts = {}) {
  process.stdout.write(`[smoke] ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    stdio: opts.inherit ? 'inherit' : 'pipe',
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} failed with exit code ${result.status}\n${detail}`);
  }
  return String(result.stdout || '').trim();
}

function copyCurrentSnapshot(destination) {
  const files = run(ROOT, 'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  for (const rel of files) {
    const source = path.join(ROOT, rel);
    const target = path.join(destination, rel);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: false, force: true });
  }
  const deleted = run(ROOT, 'git', ['diff', '--name-only', '--diff-filter=D', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const rel of deleted) fs.rmSync(path.join(destination, rel), { recursive: true, force: true });
}

function createReleaseRemote(tmp) {
  const build = path.join(tmp, 'release-build');
  const remote = path.join(tmp, 'release.git');
  run(tmp, 'git', ['clone', '--no-local', ROOT, build]);
  run(build, 'git', ['checkout', PREVIOUS_REF]);
  run(build, 'git', ['switch', '-c', 'smoke-release-build']);
  copyCurrentSnapshot(build);
  run(build, 'git', ['add', '-A']);
  run(build, 'git', ['-c', 'user.name=Control Center Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'Synthetic release candidate']);
  const target = run(build, 'git', ['rev-parse', 'HEAD']);
  run(build, 'git', ['tag', '-f', 'smoke-release', target]);
  run(tmp, 'git', ['clone', '--bare', build, remote]);
  return { remote, target };
}

function initRepo(project) {
  fs.mkdirSync(project, { recursive: true });
  run(project, 'git', ['init']);
  run(project, 'git', ['config', 'user.name', 'Smoke']);
  run(project, 'git', ['config', 'user.email', 'smoke@localhost']);
  fs.writeFileSync(path.join(project, 'tracked.txt'), 'before\n');
  run(project, 'git', ['add', 'tracked.txt']);
  run(project, 'git', ['commit', '-m', 'fixture']);
}

function seedPreviousRelease(install, home, projectsRoot) {
  const dbPath = path.join(home, 'data', 'tasks.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(home, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'update_channel: stable\n');

  const own = path.join(projectsRoot, 'own-repository');
  const disabled = path.join(projectsRoot, 'graphify-disabled');
  const parent = path.join(projectsRoot, 'parent-repository');
  const child = path.join(parent, 'child-project');
  const plain = path.join(projectsRoot, 'non-git');
  initRepo(own);
  initRepo(parent);
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(disabled, { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  fs.mkdirSync(path.join(own, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(own, 'graphify-out', 'graph.json'), '{"nodes":[]}\n');
  fs.writeFileSync(path.join(own, 'tracked.txt'), 'dirty\n');

  run(install, process.execPath, ['-e', "require('./lib/db').db.close()"], {
    env: { CONTROL_CENTER_HOME: home, CC_DB_PATH: dbPath },
  });

  const db = new Database(dbPath);
  const insert = db.prepare(`
    INSERT INTO projects (
      id, name, description, path, archived, graphify_enabled, graphify_status,
      graphify_last_success_at, graphify_hook_status, created_at, updated_at
    ) VALUES (
      @id, @name, '', @path, 0, @graphify_enabled, @graphify_status,
      @graphify_last_success_at, @graphify_hook_status, @created_at, @updated_at
    )
  `);
  const now = '2026-01-01T00:00:00.000Z';
  const fixtures = [
    { id: 'own', name: 'Own repository', path: own, graphify_enabled: 1, graphify_status: 'current', graphify_last_success_at: now, graphify_hook_status: 'installed' },
    { id: 'disabled', name: 'Graphify disabled', path: disabled, graphify_enabled: 0, graphify_status: 'disabled', graphify_last_success_at: null, graphify_hook_status: null },
    { id: 'parent', name: 'Parent repository child', path: child, graphify_enabled: 0, graphify_status: 'disabled', graphify_last_success_at: null, graphify_hook_status: null },
    { id: 'plain', name: 'Non Git', path: plain, graphify_enabled: 0, graphify_status: 'disabled', graphify_last_success_at: null, graphify_hook_status: null },
  ];
  const tx = db.transaction(() => fixtures.forEach((fixture) => insert.run({ ...fixture, created_at: now, updated_at: now })));
  tx();
  db.close();
  return { dbPath, own };
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${pathname} returned ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      return await requestJson(port, '/api/health');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not become ready: ${lastError && lastError.message}`);
}

async function withServer(install, home, dbPath, verify) {
  const probe = http.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: install,
    env: {
      ...process.env,
      CONTROL_CENTER_HOME: home,
      CC_DB_PATH: dbPath,
      CC_WORKSPACE_ROOT: path.dirname(home),
      PORT: String(port),
      CC_GRAPHIFY_BIN: path.join(home, 'missing-graphify-cli'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  try {
    const health = await waitForServer(port, child);
    await verify({ port, health });
  } catch (error) {
    error.message += `\nServer output:\n${output.join('')}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function readMeta(dbPath, key) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-update-smoke-'));
  process.stdout.write(`[smoke] fixture root ${tmp}\n`);
  try {
    const { remote, target } = createReleaseRemote(tmp);
    const install = path.join(tmp, 'install');
    const home = path.join(tmp, 'home');
    run(tmp, 'git', ['clone', remote, install]);
    run(install, 'git', ['checkout', PREVIOUS_REF]);
    run(install, 'npm', ['install'], { inherit: true });
    const fixture = seedPreviousRelease(install, home, path.join(tmp, 'projects'));

    run(install, process.execPath, ['scripts/update.js', 'update', '--target', 'smoke-release', '--home', home, '--db-path', fixture.dbPath], { inherit: true });
    assert.equal(run(install, 'git', ['rev-parse', 'HEAD']), target, 'real updater did not install release candidate');
    assert.equal(readMeta(fixture.dbPath, MIGRATION_LEDGER_KEY), null, 'old updater unexpectedly ran new migration code');

    await withServer(install, home, fixture.dbPath, async ({ port }) => {
      const diagnostics = await requestJson(port, '/api/extensions/diagnostics');
      assert.equal(diagnostics.ownership.graphify.activeOwner, 'graphify');
      assert.equal(diagnostics.ownership.git.activeOwner, 'git-workflow');
      assert.deepEqual(diagnostics.duplicateOwnership, []);
      const payload = await requestJson(port, '/api/projects');
      const own = payload.projects.find((project) => project.id === 'own');
      assert.ok(own && Object.hasOwn(own, 'graphify_status'), 'Graphify compatibility fields missing');
      assert.ok(own && Object.hasOwn(own, 'git_repo_kind'), 'Git compatibility fields missing');
      const welcome = await requestJson(port, '/api/migration/welcome');
      assert.equal(welcome.variant, 'migrated');
    });

    const completed = JSON.parse(readMeta(fixture.dbPath, MIGRATION_LEDGER_KEY));
    assert.equal(completed.status, 'completed');
    run(install, process.execPath, ['scripts/update.js', 'rollback', '--home', home, '--db-path', fixture.dbPath], { inherit: true });
    assert.equal(run(install, 'git', ['describe', '--tags', '--exact-match']), PREVIOUS_REF);
    await withServer(install, home, fixture.dbPath, async ({ port }) => {
      const payload = await requestJson(port, '/api/projects');
      assert.ok(payload.projects.find((project) => project.id === 'own'), 'legacy release could not read migrated database');
    });

    run(install, process.execPath, ['scripts/update.js', 'update', '--target', 'smoke-release', '--home', home, '--db-path', fixture.dbPath], { inherit: true });
    await withServer(install, home, fixture.dbPath, async ({ port }) => {
      const diagnostics = await requestJson(port, '/api/extensions/diagnostics');
      assert.equal(diagnostics.ownership.graphify.activeOwner, 'graphify');
      assert.equal(diagnostics.ownership.git.activeOwner, 'git-workflow');
      assert.deepEqual(diagnostics.duplicateOwnership, []);
    });
    const reupdated = JSON.parse(readMeta(fixture.dbPath, MIGRATION_LEDGER_KEY));
    assert.equal(reupdated.completedAt, completed.completedAt, 're-update reran completed migration');
    process.stdout.write('[smoke] update, startup migration, rollback, legacy restart, and re-update passed\n');
  } finally {
    if (KEEP) process.stdout.write(`[smoke] retained fixture ${tmp}\n`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
