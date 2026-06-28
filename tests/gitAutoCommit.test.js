'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autoCommitTaskProject, sanitizeCommitSubject } = require('../lib/gitAutoCommit');

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-git-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'Initial commit']);
  return repo;
}

test('sanitizeCommitSubject keeps automatic commit subjects short', () => {
  assert.equal(sanitizeCommitSubject('  Fix login\n\nflow  '), 'Fix login flow');
  assert.equal(sanitizeCommitSubject(''), 'Task completed');
  assert.ok(sanitizeCommitSubject('x'.repeat(100)).length <= 72);
});

test('autoCommitTaskProject commits current project changes when a task is done', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const repo = makeRepo();

  fs.writeFileSync(path.join(repo, 'feature.txt'), 'done\n');
  const result = await autoCommitTaskProject({
    id: 'task-123',
    title: 'Ship automatic commits',
    project_path: repo,
  });

  assert.equal(result.ok, true);
  assert.match(result.hash, /^[0-9a-f]+$/);
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']), 'Task done: Ship automatic commits');
  assert.match(git(repo, ['log', '-1', '--pretty=%b']), /Dashboard task: task-123/);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('autoCommitTaskProject limits commits to task-scoped files', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const repo = makeRepo();

  fs.writeFileSync(path.join(repo, 'task.txt'), 'task change\n');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'other change\n');
  const result = await autoCommitTaskProject({
    id: 'task-scoped',
    title: 'Commit scoped files',
    project_path: repo,
  }, {
    cwd: repo,
    files: ['task.txt'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.pathspecs, ['task.txt']);
  assert.equal(git(repo, ['show', '--name-only', '--pretty=', 'HEAD']).trim(), 'task.txt');
  assert.equal(git(repo, ['status', '--porcelain']), '?? unrelated.txt');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('autoCommitTaskProject skips clean and non-git projects', async (t) => {
  if (!gitAvailable()) return t.skip('git is not installed');
  const repo = makeRepo();
  const clean = await autoCommitTaskProject({
    id: 'task-clean',
    title: 'Clean',
    project_path: repo,
  });
  assert.equal(clean.ok, false);
  assert.equal(clean.skipped, 'no_changes');

  const emptyScope = await autoCommitTaskProject({
    id: 'task-empty',
    title: 'Empty scope',
    project_path: repo,
  }, {
    files: [],
  });
  assert.equal(emptyScope.ok, false);
  assert.equal(emptyScope.skipped, 'no_task_files');

  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-no-git-'));
  const missing = await autoCommitTaskProject({
    id: 'task-missing',
    title: 'Missing repo',
    project_path: noRepo,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.skipped, 'not_git_repo');

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(noRepo, { recursive: true, force: true });
});
