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
