'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function unloadDbModule() {
  delete require.cache[require.resolve('../lib/db')];
}

function loadDb(dbPath) {
  process.env.CC_DB_PATH = dbPath;
  delete process.env.CC_DB_BACKUP_RETENTION_COUNT;
  delete process.env.CC_DB_BACKUP_MAX_TOTAL_BYTES;
  unloadDbModule();
  return require('../lib/db');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProject(db, id, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const project = db.getProject(id);
    if (predicate(project)) return project;
    await sleep(25);
  }
  const project = db.getProject(id);
  assert.fail(`project did not reach expected state: ${JSON.stringify(project)}`);
}

async function waitForLog(logPath, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).args.join(' '));
      if (predicate(calls)) return calls;
    }
    await sleep(25);
  }
  const calls = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).args.join(' '))
    : [];
  assert.fail(`log did not reach expected state: ${JSON.stringify(calls)}`);
}

async function waitForPathAbsent(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(file)) return;
    await sleep(25);
  }
  assert.equal(fs.existsSync(file), false);
}


function writeFakeGraphify(tmp, logPath) {
  const script = path.join(tmp, 'fake-graphify.js');
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === '--version') {
  console.log('graphify 0.fake');
  process.exit(0);
}
if (args.join(' ') === 'install --project --platform codex') {
  fs.mkdirSync(path.join(process.cwd(), '.codex', 'skills', 'graphify'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.codex', 'skills', 'graphify', 'SKILL.md'), 'graphify skill');
  fs.writeFileSync(path.join(process.cwd(), '.codex', 'hooks.json'), '{}');
  fs.writeFileSync(path.join(process.cwd(), 'AGENTS.md'), 'graphify');
  process.exit(0);
}
if (args.join(' ') === 'hook install') {
  console.log('hooks installed');
  process.exit(0);
}
if (args.join(' ') === 'hook uninstall') {
  console.log('hooks removed');
  process.exit(0);
}
if (args.join(' ') === 'uninstall --project --platform codex') {
  fs.rmSync(path.join(process.cwd(), '.codex'), { recursive: true, force: true });
  process.exit(0);
}
if (args.join(' ') === 'update .') {
  fs.mkdirSync(path.join(process.cwd(), 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'graphify-out', 'graph.json'), '{"nodes":[]}\\n');
  process.exit(0);
}
console.error('unexpected args: ' + args.join(' '));
process.exit(2);
`);
  fs.chmodSync(script, 0o755);
  return script;
}

test('GraphifyManager installs project Codex integration and updates graph state', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-graphify-'));
  const projectPath = path.join(tmp, 'project');
  const logPath = path.join(tmp, 'graphify.log');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });

  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { GraphifyManager } = require('../lib/graphify');
  const fakeGraphify = writeFakeGraphify(tmp, logPath);
  const project = db.createProject({ name: 'Project', path: projectPath });
  const manager = new GraphifyManager(db, {
    bin: fakeGraphify,
    watch: false,
    bootstrap: false,
    semanticAuto: false,
    debounceMs: 0,
    setupTimeoutMs: 2000,
    timeoutMs: 2000,
  });

  try {
    manager.enqueue(project.id, 'project-created', { immediate: true });
    const updated = await waitForProject(db, project.id, (p) => p.graphify_status === 'current');

    assert.equal(updated.graphify_hook_status, 'installed');
    assert.ok(updated.graphify_last_success_at);
    assert.equal(updated.graphify_last_error, null);
    assert.equal(fs.existsSync(path.join(projectPath, 'graphify-out', 'graph.json')), true);

    const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).args.join(' '));
    assert.deepEqual(calls, [
      '--version',
      'install --project --platform codex',
      'hook install',
      'update .',
    ]);
  } finally {
    manager.shutdown();
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GraphifyManager marks projects missing when the graphify CLI is unavailable', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-graphify-missing-'));
  const projectPath = path.join(tmp, 'project');
  fs.mkdirSync(projectPath, { recursive: true });

  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { GraphifyManager } = require('../lib/graphify');
  const project = db.createProject({ name: 'Project', path: projectPath });
  const manager = new GraphifyManager(db, {
    bin: path.join(tmp, 'missing-graphify'),
    watch: false,
    bootstrap: false,
    semanticAuto: false,
    debounceMs: 0,
    setupTimeoutMs: 500,
    timeoutMs: 500,
  });

  try {
    manager.enqueue(project.id, 'project-created', { immediate: true });
    const updated = await waitForProject(db, project.id, (p) => p.graphify_status === 'missing');

    assert.match(updated.graphify_last_error, /graphify CLI not found/);
    assert.equal(updated.graphify_last_success_at, null);
  } finally {
    manager.shutdown();
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GraphifyManager skips disabled projects and can clean up project integration', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-graphify-disabled-'));
  const projectPath = path.join(tmp, 'project');
  const logPath = path.join(tmp, 'graphify.log');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });

  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { GraphifyManager } = require('../lib/graphify');
  const fakeGraphify = writeFakeGraphify(tmp, logPath);
  const project = db.createProject({ name: 'Project', path: projectPath, graphify_enabled: 0 });
  const manager = new GraphifyManager(db, {
    bin: fakeGraphify,
    watch: false,
    bootstrap: false,
    semanticAuto: false,
    debounceMs: 0,
    setupTimeoutMs: 2000,
    timeoutMs: 2000,
  });

  try {
    manager.enqueue(project.id, 'manual', { immediate: true });
    await sleep(50);
    assert.equal(db.getProject(project.id).graphify_status, 'disabled');
    assert.equal(fs.existsSync(logPath), false);

    db.updateProject(project.id, { graphify_enabled: 1 });
    manager.enqueue(project.id, 'manual', { immediate: true });
    await waitForProject(db, project.id, (p) => p.graphify_status === 'current');
    assert.equal(fs.existsSync(path.join(projectPath, '.codex', 'skills', 'graphify', 'SKILL.md')), true);

    db.updateProject(project.id, { graphify_enabled: 0 });
    manager.disableProject(project.id, { uninstall: true });
    await waitForProject(db, project.id, (p) => p.graphify_status === 'disabled');
    const calls = await waitForLog(logPath, (entries) =>
      entries.includes('hook uninstall') && entries.includes('uninstall --project --platform codex'));
    assert.equal(calls.includes('hook uninstall'), true);
    assert.equal(calls.includes('uninstall --project --platform codex'), true);
    await waitForPathAbsent(path.join(projectPath, '.codex'));
  } finally {
    manager.shutdown();
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
