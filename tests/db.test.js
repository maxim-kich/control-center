'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unloadDbModule() {
  delete require.cache[require.resolve('../lib/db')];
}

function loadDb(dbPath, env = {}) {
  process.env.CC_DB_PATH = dbPath;
  if ('CC_DB_BACKUP_RETENTION_COUNT' in env) process.env.CC_DB_BACKUP_RETENTION_COUNT = env.CC_DB_BACKUP_RETENTION_COUNT;
  else delete process.env.CC_DB_BACKUP_RETENTION_COUNT;
  if ('CC_DB_BACKUP_MAX_TOTAL_BYTES' in env) process.env.CC_DB_BACKUP_MAX_TOTAL_BYTES = env.CC_DB_BACKUP_MAX_TOTAL_BYTES;
  else delete process.env.CC_DB_BACKUP_MAX_TOTAL_BYTES;
  unloadDbModule();
  return require('../lib/db');
}

function createLegacyTasksDb(dbPath) {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE tasks (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      project_path      TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'backlog',
      session_id        TEXT,
      parent_task_id    TEXT,
      parent_session_id TEXT,
      col_order         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      started_at        TEXT,
      ended_at          TEXT
    );
    INSERT INTO tasks (id, title, project_path, created_at, updated_at)
    VALUES ('legacy-task', 'legacy', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
}

function backupNames(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('tasks.db.bak-') || name.startsWith('tasks.db.fullbak-')).sort();
}

test('tasks track when they enter their current column', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-db-test-'));

  const db = loadDb(path.join(tmp, 'tasks.db'));
  const task = db.createTask({
    title: 'sort me',
    project_path: tmp,
  });

  assert.equal(task.column_changed_at, task.created_at);

  await sleep(5);
  const renamed = db.updateTask(task.id, { title: 'still same column' });
  assert.equal(renamed.column_changed_at, task.column_changed_at);

  await sleep(5);
  const moved = db.updateTask(task.id, { status: 'in_progress' });
  assert.equal(moved.status, 'in_progress');
  assert.ok(Date.parse(moved.column_changed_at) > Date.parse(task.column_changed_at));

  db.db.close();
});

test('migration backups are retained by count and stale zero-byte sidecars are removed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-db-backups-'));
  const dbPath = path.join(tmp, 'tasks.db');
  createLegacyTasksDb(dbPath);

  fs.writeFileSync(path.join(tmp, 'tasks.db.bak-2026-01-01T00-00-00-000Z'), 'oldest');
  fs.writeFileSync(path.join(tmp, 'tasks.db.bak-2026-01-01T00-00-00-000Z-wal'), '');
  fs.writeFileSync(path.join(tmp, 'tasks.db.bak-2026-01-01T00-00-00-000Z-shm'), 'stale shm');
  fs.writeFileSync(path.join(tmp, 'tasks.db.fullbak-2026-01-02T00-00-00-000Z'), 'older');
  fs.writeFileSync(path.join(tmp, 'tasks.db.fullbak-2026-01-02T00-00-00-000Z-wal'), '');
  fs.writeFileSync(path.join(tmp, 'tasks.db.fullbak-2026-01-02T00-00-00-000Z-shm'), 'stale shm');
  fs.writeFileSync(path.join(tmp, 'tasks.db.bak-2026-01-03T00-00-00-000Z'), 'newer');

  const db = loadDb(dbPath, {
    CC_DB_BACKUP_RETENTION_COUNT: '2',
    CC_DB_BACKUP_MAX_TOTAL_BYTES: String(1024 * 1024),
  });
  db.db.close();

  const names = backupNames(tmp);
  const primaryBackups = names.filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'));
  assert.equal(primaryBackups.length, 2);
  assert.equal(names.some((name) => name.endsWith('-wal') || name.endsWith('-shm')), false);
  assert.equal(names.some((name) => name.includes('2026-01-01')), false);
  assert.equal(names.some((name) => name.includes('2026-01-02')), false);
});

test('migration backup is skipped when the database exceeds the backup byte budget', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-db-backup-budget-'));
  const dbPath = path.join(tmp, 'tasks.db');
  createLegacyTasksDb(dbPath);

  const db = loadDb(dbPath, {
    CC_DB_BACKUP_RETENTION_COUNT: '2',
    CC_DB_BACKUP_MAX_TOTAL_BYTES: '1',
  });
  assert.equal(db.getTask('legacy-task').model, 'gpt-5.5');
  db.db.close();

  assert.deepEqual(backupNames(tmp), []);
});

test('legacy modes keep YOLO only where it affects launches', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-auto-mode-'));
  const dbPath = path.join(tmp, 'tasks.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE tasks (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      project_path      TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'backlog',
      session_id        TEXT,
      parent_task_id    TEXT,
      parent_session_id TEXT,
      col_order         INTEGER NOT NULL DEFAULT 0,
      model             TEXT NOT NULL DEFAULT 'gpt-5.5',
      effort            TEXT NOT NULL DEFAULT 'medium',
      mode              TEXT NOT NULL DEFAULT 'build',
      yolo              INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      started_at        TEXT,
      ended_at          TEXT
    );
    INSERT INTO tasks (id, title, project_path, mode, yolo, created_at, updated_at)
    VALUES
      ('auto-task', 'auto', '/tmp', 'auto', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('plan-task', 'plan', '/tmp', 'plan', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const db = loadDb(dbPath);
  const autoTask = db.getTask('auto-task');
  assert.equal(autoTask.mode, 'build');
  assert.equal(autoTask.yolo, 0);
  const planTask = db.getTask('plan-task');
  assert.equal(planTask.mode, 'plan');
  assert.equal(planTask.yolo, 0);
  db.db.close();
});

test('legacy task project paths are not auto-seeded and user projects relink tasks by path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-projects-'));
  const dbPath = path.join(tmp, 'tasks.db');
  createLegacyTasksDb(dbPath);

  const db = loadDb(dbPath);
  assert.deepEqual(db.listProjects(), []);

  const created = db.createProject({
    name: 'User project',
    description: 'Small description',
    path: '/tmp',
  });
  assert.equal(db.getProjectByPath('/tmp').id, created.id);
  assert.equal(db.getTask('legacy-task').project_path, '/tmp');

  const nextPath = path.join(tmp, 'renamed-project');
  const updated = db.updateProject(created.id, {
    name: 'Renamed',
    path: nextPath,
  });

  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.description, 'Small description');
  assert.equal(updated.path, nextPath);
  assert.equal(db.getTask('legacy-task').project_path, nextPath);

  db.db.close();
});

test('projects can be archived, restored, and deleted without deleting tasks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-project-archive-'));
  const db = loadDb(path.join(tmp, 'tasks.db'));
  const projectPath = path.join(tmp, 'project');

  const created = db.createProject({
    name: 'Archive me',
    path: projectPath,
  });
  const task = db.createTask({
    title: 'keep me',
    project_path: projectPath,
  });

  const archived = db.archiveProject(created.id);
  assert.equal(archived.archived, 1);
  assert.deepEqual(db.listProjects(), []);
  assert.equal(db.listProjects(true).length, 1);
  assert.equal(db.getProjectByPath(projectPath), undefined);
  assert.equal(db.getProjectByPath(projectPath, true).id, created.id);
  assert.equal(db.getTask(task.id).project_path, projectPath);

  const restored = db.unarchiveProject(created.id);
  assert.equal(restored.archived, 0);
  assert.equal(db.listProjects().length, 1);

  const deleted = db.deleteProject(created.id);
  assert.equal(deleted.id, created.id);
  assert.equal(db.getProject(created.id), undefined);
  assert.equal(db.getTask(task.id).id, task.id);

  db.db.close();
});

test('upserting a session clears stale ended_at after resume', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-session-resume-'));
  const db = loadDb(path.join(tmp, 'tasks.db'));
  const projectPath = path.join(tmp, 'project');
  const task = db.createTask({
    title: 'resume me',
    project_path: projectPath,
  });

  db.upsertSession({
    session_id: 'sess-1',
    task_id: task.id,
    kind: 'start',
    transcript_path: path.join(tmp, 'first.jsonl'),
  });
  db.endSession('sess-1');
  assert.ok(db.getSession('sess-1').ended_at);

  await sleep(5);
  db.upsertSession({
    session_id: 'sess-1',
    task_id: task.id,
    kind: 'resume',
    transcript_path: path.join(tmp, 'second.jsonl'),
  });

  const session = db.getSession('sess-1');
  assert.equal(session.ended_at, null);
  assert.equal(session.kind, 'resume');
  assert.equal(session.transcript_path, path.join(tmp, 'second.jsonl'));
  db.db.close();
});
