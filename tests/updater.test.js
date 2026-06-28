'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const updater = require('../lib/core/updater');

const ROOT = path.resolve(__dirname, '..');

function hasGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeRepo(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-git-'));
  fs.writeFileSync(path.join(tmp, 'server.js'), "console.log('server');\n");
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2));
  fs.writeFileSync(path.join(tmp, 'control-center.manifest.json'), JSON.stringify({
    imageOwned: ['server.js', 'docs/**', 'package.json', 'control-center.manifest.json'],
    generated: ['data/**'],
  }, null, 2));
  git(tmp, ['init']);
  git(tmp, ['add', '.']);
  git(tmp, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial']);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

test('updater compares semantic versions', () => {
  assert.equal(updater.compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(updater.compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  assert.equal(updater.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(updater.isNewerVersion('v1.0.1', '1.0.0'), true);
});

test('imageOwnedChanges reports source changes and ignores generated files', { skip: !hasGit() }, (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server.js'), "console.log('changed');\n");
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'publishing.md'), '# docs\n');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data', 'tasks.db'), 'private');

  const result = updater.imageOwnedChanges(repo);
  assert.equal(result.ok, false);
  const paths = result.changes.map((change) => change.path).sort();
  assert.deepEqual(paths, ['docs/publishing.md', 'server.js']);
});

test('backupInstance copies config and checkpointed database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-backup-'));
  const home = path.join(tmp, 'home');
  const data = path.join(home, 'data');
  const backups = path.join(home, 'backups');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'update_channel: stable\n');
  const dbPath = path.join(data, 'tasks.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE sample (id TEXT PRIMARY KEY); INSERT INTO sample (id) VALUES (\'one\');');
  db.close();

  try {
    const backup = updater.backupInstance({ appHome: home, dbPath, backupDir: backups, label: 'test' });
    assert.equal(fs.existsSync(path.join(backup.path, 'config.yaml')), true);
    assert.equal(fs.existsSync(path.join(backup.path, 'tasks.db')), true);
    assert.equal(fs.existsSync(path.join(backup.path, 'backup.json')), true);
    const copied = new Database(path.join(backup.path, 'tasks.db'), { readonly: true });
    try {
      assert.equal(copied.prepare('SELECT id FROM sample').get().id, 'one');
    } finally {
      copied.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dryRunMigration migrates a copy without modifying the source database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-dryrun-'));
  const dbPath = path.join(tmp, 'legacy.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      session_id TEXT,
      parent_task_id TEXT,
      parent_session_id TEXT,
      col_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    INSERT INTO tasks (id, title, project_path, created_at, updated_at)
    VALUES ('t1', 'legacy', '/tmp/project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  try {
    const result = updater.dryRunMigration({ root: ROOT, dbPath });
    assert.equal(result.ok, true, result.stderr || result.stdout);

    const original = new Database(dbPath, { readonly: true });
    try {
      const row = original.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'`).get();
      assert.equal(row, undefined);
    } finally {
      original.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updater blocks extension conflicts unless explicitly allowed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-ext-'));
  const writeExt = (folder, manifest) => {
    const dir = path.join(tmp, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.yaml'), manifest);
  };
  writeExt('one', `
id: alpha
settingsPanels:
  - id: status
    title: Status
    path: status.html
`);
  writeExt('two', `
id: alpha
settingsPanels:
  - id: status
    title: Status
    path: status.html
`);

  try {
    assert.throws(
      () => updater.ensureExtensionConflictsAllowed({ extensionsDir: tmp }),
      /extension conflicts/,
    );
    const allowed = updater.ensureExtensionConflictsAllowed({ extensionsDir: tmp, allowExtensionConflicts: true });
    assert.ok(allowed.conflicts.length >= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
