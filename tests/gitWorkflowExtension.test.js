'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-git-workflow-repo-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'Initial commit']);
  return repo;
}

function unloadDbModule() {
  delete require.cache[require.resolve('../lib/db')];
}

function loadDb(dbPath) {
  process.env.CC_DB_PATH = dbPath;
  unloadDbModule();
  return require('../lib/db');
}

function loadGitWorkflow(db, tmp, opts = {}) {
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
  platform.installBundled('git-workflow', { enable: true });
  if (opts.active !== false) platform.switchOwnership('git', 'git-workflow');
  const manager = loadExtensions({
    app: opts.app,
    extensionsDir,
    context: { db, paths, workspaceRoot: tmp },
    platform,
  });
  return { platform, manager };
}

test('Git Workflow extension commits task-scoped files as the active Git owner', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-git-workflow-'));
  const repo = makeRepo();
  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { platform, manager } = loadGitWorkflow(db, tmp);
  const project = db.createProject({ name: 'Repo', path: repo });
  const task = {
    id: 'task-git-extension',
    title: 'Commit scoped extension files',
    project_id: project.id,
    project_path: repo,
    provider: 'codex',
    status: 'done',
  };
  fs.writeFileSync(path.join(repo, 'task.txt'), 'task change\n');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'other change\n');

  try {
    assert.equal(platform.owner('git'), 'git-workflow');
    const result = await manager.notify('task.completed', {
      task,
      project,
      gitAutoCommitPolicy: { decision: 'abstain' },
      gitCommitScope: { cwd: repo, files: ['task.txt'] },
    });
    const outcome = result.results.find((item) => item.extensionId === 'git-workflow');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.git_commit.ok, true);
    assert.deepEqual(outcome.result.git_commit.pathspecs, ['task.txt']);
    assert.equal(git(repo, ['show', '--name-only', '--pretty=', 'HEAD']).trim(), 'task.txt');
    assert.equal(git(repo, ['status', '--porcelain']), '?? unrelated.txt');
    const state = db.listExtensionState('git-workflow', 'project', project.id);
    assert.equal(state.lastCommit.taskId, task.id);
  } finally {
    await manager.shutdown({ reason: 'test' });
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('Git setup endpoint creates a project repository inside a parent without changing the parent', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-git-init-'));
  const parent = makeRepo();
  const projectPath = path.join(parent, 'child');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, 'note.txt'), 'project content\n');
  const db = loadDb(path.join(tmp, 'tasks.db'));
  const app = require('express')();
  const { manager } = loadGitWorkflow(db, tmp, { app });
  const project = db.createProject({ name: 'Child', path: projectPath });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/extensions/git-workflow/projects/${project.id}`;
  try {
    const before = await (await fetch(`${endpoint}/status`)).json();
    assert.equal(before.git.git_repo_kind, 'parent');
    const parentHead = git(parent, ['rev-parse', 'HEAD']);
    const parentStatus = git(parent, ['status', '--porcelain']);
    const parentConfig = fs.readFileSync(path.join(parent, '.git', 'config'), 'utf8');
    const response = await fetch(`${endpoint}/init`, { method: 'POST' });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.init.initialized, true);
    assert.equal(result.git.git_repo_kind, 'own');
    assert.equal(result.git.git_initialized, 1);
    assert.equal(result.git.git_parent_repo_root, null);
    assert.equal(fs.realpathSync(git(projectPath, ['rev-parse', '--show-toplevel'])), fs.realpathSync(projectPath));
    assert.equal(git(parent, ['rev-parse', 'HEAD']), parentHead);
    assert.equal(git(parent, ['status', '--porcelain']), parentStatus);
    assert.equal(fs.readFileSync(path.join(parent, '.git', 'config'), 'utf8'), parentConfig);
    const after = await (await fetch(`${endpoint}/status`)).json();
    assert.equal(after.git.git_repo_kind, 'own');
    const repeated = await (await fetch(`${endpoint}/init`, { method: 'POST' })).json();
    assert.equal(repeated.init.initialized, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await manager.shutdown({ reason: 'test' });
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('Git Workflow extension honors auto-commit policy denial', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-git-workflow-policy-'));
  const repo = makeRepo();
  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { manager } = loadGitWorkflow(db, tmp);
  const project = db.createProject({ name: 'Repo', path: repo });
  const task = { id: 'task-denied', title: 'Denied', project_id: project.id, project_path: repo, provider: 'codex' };
  fs.writeFileSync(path.join(repo, 'denied.txt'), 'do not commit\n');

  try {
    const result = await manager.notify('task.completed', {
      task,
      project,
      gitAutoCommitPolicy: { decision: 'deny', reason: 'manual checkpoint' },
      gitCommitScope: { cwd: repo, files: ['denied.txt'] },
    });
    const outcome = result.results.find((item) => item.extensionId === 'git-workflow');
    assert.equal(outcome.result.git_commit.skipped, true);
    assert.match(outcome.result.git_commit.reason, /manual checkpoint/);
    assert.match(git(repo, ['status', '--porcelain']), /denied.txt/);
    assert.equal(git(repo, ['log', '--oneline']).split('\n').length, 1);
  } finally {
    await manager.shutdown({ reason: 'test' });
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('Git Workflow extension is inert while legacy owns Git', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-git-workflow-legacy-'));
  const repo = makeRepo();
  const db = loadDb(path.join(tmp, 'tasks.db'));
  const { platform, manager } = loadGitWorkflow(db, tmp, { active: false });
  const project = db.createProject({ name: 'Repo', path: repo });
  const task = { id: 'task-legacy-owner', title: 'Legacy owner', project_id: project.id, project_path: repo, provider: 'codex' };
  fs.writeFileSync(path.join(repo, 'legacy.txt'), 'legacy should own\n');

  try {
    assert.equal(platform.owner('git'), 'legacy');
    const result = await manager.notify('task.completed', {
      task,
      project,
      gitAutoCommitPolicy: { decision: 'abstain' },
      gitCommitScope: { cwd: repo, files: ['legacy.txt'] },
    });
    const outcome = result.results.find((item) => item.extensionId === 'git-workflow');
    assert.equal(outcome.result.skipped, 'inactive_owner');
    assert.match(git(repo, ['status', '--porcelain']), /legacy.txt/);
    assert.equal(git(repo, ['log', '--oneline']).split('\n').length, 1);
  } finally {
    await manager.shutdown({ reason: 'test' });
    db.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
