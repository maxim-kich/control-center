'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function unloadDbModule() {
  delete require.cache[require.resolve('../lib/db')];
}

function loadDb(dbPath) {
  process.env.CC_DB_PATH = dbPath;
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
  assert.fail(`project did not reach expected state: ${JSON.stringify(db.getProject(id))}`);
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

function loadGraphifyExtension(db, tmp, opts = {}) {
  const { ExtensionPlatform } = require('../lib/core/extensionPlatform');
  const { loadExtensions } = require('../lib/core/extensions');
  const paths = require('../lib/core/paths');
  const extensionsDir = path.join(tmp, 'extensions');
  const platform = new ExtensionPlatform({
    db,
    bundledDir: path.join(ROOT, 'bundled-extensions'),
    extensionsDir,
  });
  platform.prepare();
  platform.installBundled('graphify', { enable: true });
  if (opts.active !== false) platform.switchOwnership('graphify', 'graphify');
  const manager = loadExtensions({
    extensionsDir,
    context: { db, paths, workspaceRoot: tmp },
    platform,
  });
  return { platform, manager };
}

test('bundled Graphify extension owns lifecycle work and imports compatibility state', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-graphify-extension-'));
  const projectPath = path.join(tmp, 'project');
  const logPath = path.join(tmp, 'graphify.log');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  process.env.CC_GRAPHIFY_BIN = writeFakeGraphify(tmp, logPath);
  process.env.CC_GRAPHIFY_WATCH = '0';
  process.env.CC_GRAPHIFY_BOOTSTRAP = '0';
  process.env.CC_GRAPHIFY_SEMANTIC_AUTO = '0';
  process.env.CC_GRAPHIFY_PROVIDERS = 'codex';

  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { platform, manager } = loadGraphifyExtension(db, tmp);
  const project = db.createProject({ name: 'Project', path: projectPath });

  try {
    assert.equal(platform.owner('graphify'), 'graphify');
    await manager.notify('app.started', { workspaceRoot: tmp });
    await manager.notify('project.created', { project, provider: null });

    const updated = await waitForProject(db, project.id, (p) => p.graphify_status === 'current');
    assert.equal(updated.graphify_hook_status, 'installed');
    assert.equal(fs.existsSync(path.join(projectPath, 'graphify-out', 'graph.json')), true);

    const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).args.join(' '));
    assert.deepEqual(calls, [
      '--version',
      'install --project --platform codex',
      'hook install',
      'update .',
    ]);
    const imported = db.listExtensionState('graphify', 'project', project.id);
    assert.equal(imported.importedFrom, 'legacy-project-columns');
    assert.equal(imported.compatibility.graphify_enabled, 1);
    assert.equal(platform.diagnostics().processes.running.length, 0);
  } finally {
    await manager.shutdown({ reason: 'test' });
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CC_GRAPHIFY_BIN;
    delete process.env.CC_GRAPHIFY_WATCH;
    delete process.env.CC_GRAPHIFY_BOOTSTRAP;
    delete process.env.CC_GRAPHIFY_SEMANTIC_AUTO;
    delete process.env.CC_GRAPHIFY_PROVIDERS;
  }
});

test('bundled Graphify extension stays inert while legacy owns the domain', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-graphify-extension-legacy-'));
  const projectPath = path.join(tmp, 'project');
  const logPath = path.join(tmp, 'graphify.log');
  fs.mkdirSync(projectPath, { recursive: true });
  process.env.CC_GRAPHIFY_BIN = writeFakeGraphify(tmp, logPath);
  process.env.CC_GRAPHIFY_WATCH = '0';
  process.env.CC_GRAPHIFY_BOOTSTRAP = '0';
  process.env.CC_GRAPHIFY_PROVIDERS = 'codex';

  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { platform, manager } = loadGraphifyExtension(db, tmp, { active: false });
  const project = db.createProject({ name: 'Project', path: projectPath });

  try {
    assert.equal(platform.owner('graphify'), 'legacy');
    await manager.notify('app.started', { workspaceRoot: tmp });
    await manager.notify('project.created', { project, provider: null });
    await sleep(100);
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(db.getProject(project.id).graphify_status, 'pending');
  } finally {
    await manager.shutdown({ reason: 'test' });
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CC_GRAPHIFY_BIN;
    delete process.env.CC_GRAPHIFY_WATCH;
    delete process.env.CC_GRAPHIFY_BOOTSTRAP;
    delete process.env.CC_GRAPHIFY_PROVIDERS;
  }
});
