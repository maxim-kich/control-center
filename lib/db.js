'use strict';

/**
 * SQLite persistence (better-sqlite3). The same DB file can also be written by
 * dashboard-owned Codex hooks, so we run in WAL mode with a busy timeout to make
 * concurrent hook-writes / server-reads safe.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const paths = require('./core/paths');

paths.ensureRuntimeDirs();

const DATA_DIR = paths.DATA_DIR;
const DB_PATH = process.env.CC_DB_PATH || path.join(DATA_DIR, 'tasks.db');
const DB_BACKUP_DIR = process.env.CC_DB_BACKUP_DIR || (process.env.CC_DB_PATH ? path.dirname(DB_PATH) : paths.BACKUP_DIR);
const DB_BACKUP_RETENTION_COUNT = parseNonNegativeInt(process.env.CC_DB_BACKUP_RETENTION_COUNT, 2);
const DB_BACKUP_MAX_TOTAL_BYTES = parseNonNegativeInt(process.env.CC_DB_BACKUP_MAX_TOTAL_BYTES, 50 * 1024 * 1024);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  project_id        TEXT,
  project_path      TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'codex',
  status            TEXT NOT NULL DEFAULT 'backlog',   -- backlog | in_progress | done
  session_id        TEXT,
  parent_task_id    TEXT,
  parent_session_id TEXT,
  col_order         INTEGER NOT NULL DEFAULT 0,
  column_changed_at TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  started_at        TEXT,
  ended_at          TEXT,
  model             TEXT NOT NULL DEFAULT 'gpt-5.5',
  effort            TEXT NOT NULL DEFAULT 'medium',
  mode              TEXT NOT NULL DEFAULT 'build',
  yolo              INTEGER NOT NULL DEFAULT 1,
  ultracode         INTEGER NOT NULL DEFAULT 0,
  activity          TEXT,
  wake_at           TEXT,
  archived          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'codex',
  task_id           TEXT,
  kind              TEXT,                               -- start | resume | fork
  parent_session_id TEXT,
  transcript_path   TEXT,
  cwd               TEXT,
  name              TEXT,
  source            TEXT,
  started_at        TEXT,
  ended_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_parent  ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
`);

const now = () => new Date().toISOString();

// ---- migrations (additive only — NEVER drop/recreate; back up before changing) -----------

function parseNonNegativeInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function listDbBackupGroups() {
  const dir = DB_BACKUP_DIR;
  const base = path.basename(DB_PATH);
  const prefixes = [
    { kind: 'bak', prefix: `${base}.bak-` },
    { kind: 'fullbak', prefix: `${base}.fullbak-` },
  ];
  const groups = new Map();

  for (const name of fs.readdirSync(dir)) {
    const matched = prefixes.find((p) => name.startsWith(p.prefix));
    if (!matched) continue;

    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let stamp = name.slice(matched.prefix.length);
    let sidecar = null;
    if (stamp.endsWith('-wal')) {
      sidecar = 'wal';
      stamp = stamp.slice(0, -4);
    } else if (stamp.endsWith('-shm')) {
      sidecar = 'shm';
      stamp = stamp.slice(0, -4);
    }

    const key = `${matched.kind}-${stamp}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        stamp,
        kind: matched.kind,
        mtimeMs: 0,
        size: 0,
        files: [],
      });
    }

    const group = groups.get(key);
    group.mtimeMs = Math.max(group.mtimeMs, stat.mtimeMs);
    group.size += stat.size;
    group.files.push({ path: fullPath, name, sidecar, size: stat.size });
  }

  return Array.from(groups.values()).sort((a, b) => b.stamp.localeCompare(a.stamp) || b.mtimeMs - a.mtimeMs);
}

function removeBackupGroup(group) {
  for (const file of group.files) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* best-effort */
    }
  }
}

function removeRedundantBackupSidecars(groups) {
  for (const group of groups) {
    const wal = group.files.find((f) => f.sidecar === 'wal');
    if (!wal || wal.size !== 0) continue;

    for (const file of group.files.filter((f) => f.sidecar === 'wal' || f.sidecar === 'shm')) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        /* best-effort */
      }
    }
  }
}

function pruneDbBackups() {
  removeRedundantBackupSidecars(listDbBackupGroups());

  let groups = listDbBackupGroups();
  if (DB_BACKUP_RETENTION_COUNT === 0) {
    for (const group of groups) removeBackupGroup(group);
    return;
  }

  for (const group of groups.slice(DB_BACKUP_RETENTION_COUNT)) {
    removeBackupGroup(group);
  }

  groups = listDbBackupGroups();
  let totalBytes = groups.reduce((sum, group) => sum + group.size, 0);
  for (const group of [...groups].reverse()) {
    if (totalBytes <= DB_BACKUP_MAX_TOTAL_BYTES) break;
    removeBackupGroup(group);
    totalBytes -= group.size;
  }
}

function createMigrationBackup() {
  try {
    pruneDbBackups();
    if (DB_BACKUP_RETENTION_COUNT === 0 || !fs.existsSync(DB_PATH)) return;

    const dbSize = fs.statSync(DB_PATH).size;
    if (dbSize > DB_BACKUP_MAX_TOTAL_BYTES) {
      console.warn(`Skipping migration backup for ${DB_PATH}: database is larger than CC_DB_BACKUP_MAX_TOTAL_BYTES.`);
      return;
    }

    // Fold the WAL into the main file FIRST so the copy is a complete snapshot — in WAL mode
    // committed rows live in the -wal sidecar until checkpointed, so a bare file copy would
    // miss them.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_PATH, path.join(DB_BACKUP_DIR, `${path.basename(DB_PATH)}.bak-${stamp}`));
    pruneDbBackups();
  } catch {
    /* best-effort */
  }
}

function tableExists(name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function projectNameFromPath(projectPath) {
  if (!projectPath) return 'Project';
  const normalized = String(projectPath).replace(/[\\/]+$/, '');
  return path.basename(normalized) || normalized || 'Project';
}

const PROJECT_GRAPHIFY_COLUMNS = [
  ['graphify_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['graphify_status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['graphify_last_started_at', 'TEXT'],
  ['graphify_last_finished_at', 'TEXT'],
  ['graphify_last_success_at', 'TEXT'],
  ['graphify_last_error', 'TEXT'],
  ['graphify_hook_status', 'TEXT'],
  ['graphify_dirty_at', 'TEXT'],
];

const PROJECT_COLUMNS = [
  ['archived', 'INTEGER NOT NULL DEFAULT 0'],
  ...PROJECT_GRAPHIFY_COLUMNS,
];

function migrateSchema() {
  const cols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  const sessionsMissing = !tableExists('sessions');
  const sessionCols = sessionsMissing ? new Set() : new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  const projectsMissing = !tableExists('projects');
  const appMetaMissing = !tableExists('app_meta');
  const projectCols = projectsMissing ? new Set() : new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  const additions = [
    ['project_id', 'TEXT'],
    ['provider', "TEXT NOT NULL DEFAULT 'codex'"],
    ['model', "TEXT NOT NULL DEFAULT 'gpt-5.5'"],
    ['effort', "TEXT NOT NULL DEFAULT 'medium'"],
    ['mode', "TEXT NOT NULL DEFAULT 'build'"], // build | plan
    ['yolo', 'INTEGER NOT NULL DEFAULT 1'], // 1 = Codex --dangerously-bypass-approvals-and-sandbox in build mode
    ['ultracode', 'INTEGER NOT NULL DEFAULT 0'], // legacy no-op until a Codex equivalent exists
    ['activity', 'TEXT'], // working | idle | NULL — fine-grained, set by hooks
    ['wake_at', 'TEXT'],
    ['archived', 'INTEGER NOT NULL DEFAULT 0'],
    ['column_changed_at', 'TEXT'],
  ].filter(([name]) => !cols.has(name));
  const sessionAdditions = sessionsMissing ? [] : [
    ['provider', "TEXT NOT NULL DEFAULT 'codex'"],
  ].filter(([name]) => !sessionCols.has(name));
  const projectAdditions = projectsMissing ? [] : PROJECT_COLUMNS.filter(([name]) => !projectCols.has(name));
  if (additions.length === 0 && sessionAdditions.length === 0 && projectAdditions.length === 0 && !projectsMissing && !appMetaMissing) {
    db.prepare(`UPDATE tasks SET column_changed_at = COALESCE(column_changed_at, created_at, updated_at) WHERE column_changed_at IS NULL OR column_changed_at = ''`).run();
    pruneDbBackups();
    return;
  }
  // Back up the DB once before the first schema change (existing rows are precious).
  createMigrationBackup();
  for (const [name, def] of additions) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`);
  for (const [name, def] of sessionAdditions) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${def}`);
  for (const [name, def] of projectAdditions) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
  if (additions.some(([name]) => name === 'column_changed_at')) {
    db.prepare(`UPDATE tasks SET column_changed_at = COALESCE(created_at, updated_at) WHERE column_changed_at IS NULL OR column_changed_at = ''`).run();
  }
  if (projectsMissing) {
    db.exec(`
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        path        TEXT NOT NULL UNIQUE,
        archived    INTEGER NOT NULL DEFAULT 0,
        graphify_enabled INTEGER NOT NULL DEFAULT 1,
        graphify_status TEXT NOT NULL DEFAULT 'pending',
        graphify_last_started_at TEXT,
        graphify_last_finished_at TEXT,
        graphify_last_success_at TEXT,
        graphify_last_error TEXT,
        graphify_hook_status TEXT,
        graphify_dirty_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_projects_path ON projects(path);
    `);
  }
  if (appMetaMissing) {
    db.exec(`
      CREATE TABLE app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
}
migrateSchema();

function migrateCodexDefaults() {
  db.prepare(`UPDATE tasks SET provider = 'codex' WHERE provider IS NULL OR provider = ''`).run();
  db.prepare(`UPDATE tasks SET model = 'gpt-5.5' WHERE (provider IS NULL OR provider = 'codex') AND (model IS NULL OR model = '' OR model LIKE 'claude-%')`).run();
  db.prepare(`UPDATE tasks SET effort = 'xhigh' WHERE (provider IS NULL OR provider = 'codex') AND effort = 'max'`).run();
  db.prepare(`UPDATE tasks SET effort = 'medium' WHERE effort IS NULL OR effort = ''`).run();
  db.prepare(`UPDATE tasks SET mode = 'build' WHERE mode IS NULL OR mode = ''`).run();
  // Auto used the same prompt-based approval behavior as build with YOLO disabled.
  db.prepare(`UPDATE tasks SET mode = 'build', yolo = 0 WHERE (provider IS NULL OR provider = 'codex') AND mode = 'auto'`).run();
  db.prepare(`UPDATE tasks SET yolo = 0 WHERE mode = 'plan'`).run();
  db.prepare(`UPDATE sessions SET provider = 'codex' WHERE provider IS NULL OR provider = ''`).run();
  db.prepare(`
    UPDATE tasks
    SET project_id = (
      SELECT projects.id FROM projects
      WHERE projects.path = tasks.project_path
      LIMIT 1
    )
    WHERE (project_id IS NULL OR project_id = '')
      AND project_path IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE projects.path = tasks.project_path)
  `).run();
}
migrateCodexDefaults();

function getMeta(key) {
  return db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key);
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getMetaValue(key, fallback = null) {
  const row = getMeta(key);
  return row ? row.value : fallback;
}

function setMetaValue(key, value) {
  setMeta(key, String(value));
  return getMetaValue(key);
}

function cleanupAutoSeededProjectsOnce() {
  const key = 'projects.auto_seed_cleanup_v1';
  if (getMeta(key)) return;
  const projects = db.prepare(`SELECT id, name, description, path FROM projects`).all();
  if (projects.length) {
    const taskPaths = new Set(db.prepare(`
      SELECT DISTINCT project_path AS path
      FROM tasks
      WHERE project_path IS NOT NULL AND TRIM(project_path) != ''
    `).all().map((row) => row.path));
    const generated = projects.filter((p) =>
      taskPaths.has(p.path) &&
      String(p.description || '') === '' &&
      String(p.name || '') === projectNameFromPath(p.path),
    );
    if (generated.length) {
      const del = db.prepare(`DELETE FROM projects WHERE id = ?`);
      const tx = db.transaction(() => {
        for (const p of generated) del.run(p.id);
      });
      tx();
    }
  }
  setMeta(key, now());
}
cleanupAutoSeededProjectsOnce();

// ---- tasks ---------------------------------------------------------------

const TASK_DEFAULTS = { model: 'gpt-5.5', effort: 'medium', mode: 'build', yolo: 1, ultracode: 0 };

const stmts = {
  listProjects: db.prepare(`SELECT * FROM projects WHERE archived = 0 ORDER BY name COLLATE NOCASE ASC, path ASC`),
  listProjectsAll: db.prepare(`SELECT * FROM projects ORDER BY archived ASC, name COLLATE NOCASE ASC, path ASC`),
  getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
  getProjectByPath: db.prepare(`SELECT * FROM projects WHERE path = ? AND archived = 0`),
  getProjectByPathAny: db.prepare(`SELECT * FROM projects WHERE path = ?`),
  insertProject: db.prepare(`
    INSERT INTO projects (id, name, description, path, archived, graphify_enabled, graphify_status, created_at, updated_at)
    VALUES (@id, @name, @description, @path, @archived, @graphify_enabled, @graphify_status, @created_at, @updated_at)`),
  listTasks: db.prepare(`SELECT * FROM tasks WHERE archived = 0 ORDER BY column_changed_at DESC, created_at DESC`),
  listTasksAll: db.prepare(`SELECT * FROM tasks ORDER BY column_changed_at DESC, created_at DESC`),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
  insertTask: db.prepare(`
    INSERT INTO tasks (id, title, description, project_id, project_path, provider, status, parent_task_id, parent_session_id, col_order, model, effort, mode, yolo, ultracode, column_changed_at, created_at, updated_at)
    VALUES (@id, @title, @description, @project_id, @project_path, @provider, @status, @parent_task_id, @parent_session_id, @col_order, @model, @effort, @mode, @yolo, @ultracode, @column_changed_at, @created_at, @updated_at)`),
  maxOrderForStatus: db.prepare(`SELECT COALESCE(MAX(col_order), 0) AS m FROM tasks WHERE status = ?`),
  childrenOf: db.prepare(`SELECT * FROM tasks WHERE parent_task_id = ? AND archived = 0 ORDER BY created_at ASC`),
};

function listProjects(includeArchived = false) {
  return (includeArchived ? stmts.listProjectsAll : stmts.listProjects).all();
}

function getProject(id) {
  return stmts.getProject.get(id);
}

function getProjectByPath(projectPath, includeArchived = false) {
  return (includeArchived ? stmts.getProjectByPathAny : stmts.getProjectByPath).get(projectPath);
}

function createProject(opts) {
  const { path: projectPath, name, description = '', graphify_enabled = 1 } = opts;
  const graphifyEnabled = graphify_enabled ? 1 : 0;
  const id = crypto.randomUUID();
  const ts = now();
  stmts.insertProject.run({
    id,
    name: String(name || projectNameFromPath(projectPath)).trim() || projectNameFromPath(projectPath),
    description: String(description || ''),
    path: projectPath,
    archived: 0,
    graphify_enabled: graphifyEnabled,
    graphify_status: graphifyEnabled ? 'pending' : 'disabled',
    created_at: ts,
    updated_at: ts,
  });
  db.prepare(`
    UPDATE tasks
    SET project_id = ?
    WHERE project_path = ?
      AND (project_id IS NULL OR project_id = '')
  `).run(id, projectPath);
  return getProject(id);
}

function updateProject(id, patch) {
  const tx = db.transaction(() => {
    const existing = getProject(id);
    if (!existing) return null;
    const allowed = {};
    if ('name' in patch) allowed.name = String(patch.name || '').trim() || projectNameFromPath(patch.path || existing.path);
    if ('description' in patch) allowed.description = String(patch.description || '');
    if ('path' in patch) allowed.path = String(patch.path || '').trim();
    if ('archived' in patch) allowed.archived = patch.archived ? 1 : 0;
    if ('graphify_enabled' in patch) {
      allowed.graphify_enabled = patch.graphify_enabled ? 1 : 0;
      allowed.graphify_status = patch.graphify_enabled ? (existing.graphify_status === 'disabled' ? 'pending' : existing.graphify_status) : 'disabled';
    }
    const keys = Object.keys(allowed).filter((k) => k !== 'path' || allowed.path);
    if (keys.length === 0) return existing;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE projects SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
      ...allowed,
      id,
      updated_at: now(),
    });
    if (allowed.path && allowed.path !== existing.path) {
      db.prepare(`UPDATE tasks SET project_path = ?, updated_at = ? WHERE project_path = ?`).run(allowed.path, now(), existing.path);
    }
    return getProject(id);
  });
  return tx();
}

function archiveProject(id) {
  return updateProject(id, { archived: 1 });
}

function unarchiveProject(id) {
  return updateProject(id, { archived: 0 });
}

function deleteProject(id) {
  const existing = getProject(id);
  if (!existing) return null;
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  return existing;
}

const PROJECT_GRAPHIFY_WRITABLE = new Set(PROJECT_GRAPHIFY_COLUMNS.map(([name]) => name));
function updateProjectGraphify(id, patch) {
  const keys = Object.keys(patch || {}).filter((k) => PROJECT_GRAPHIFY_WRITABLE.has(k));
  if (keys.length === 0) return getProject(id);
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  const data = { id };
  for (const k of keys) data[k] = patch[k];
  db.prepare(`UPDATE projects SET ${sets} WHERE id = @id`).run(data);
  return getProject(id);
}

function listTasks(includeArchived = false) {
  return (includeArchived ? stmts.listTasksAll : stmts.listTasks).all();
}

function getTask(id) {
  return stmts.getTask.get(id);
}

function createTask(opts) {
  const {
    title, description = '', project_id = null, project_path, provider = 'codex',
    parent_task_id = null, parent_session_id = null, status = 'backlog',
    model = TASK_DEFAULTS.model, effort = TASK_DEFAULTS.effort, mode = TASK_DEFAULTS.mode, yolo = TASK_DEFAULTS.yolo,
    ultracode = TASK_DEFAULTS.ultracode,
  } = opts;
  const id = crypto.randomUUID();
  const ts = now();
  const order = stmts.maxOrderForStatus.get(status).m + 1;
  const project = project_id ? getProject(project_id) : getProjectByPath(project_path, true);
  stmts.insertTask.run({
    id, title, description, project_id: project ? project.id : project_id, project_path, provider, status,
    parent_task_id, parent_session_id, col_order: order,
    model, effort, mode, yolo: yolo ? 1 : 0, ultracode: ultracode ? 1 : 0,
    column_changed_at: ts, created_at: ts, updated_at: ts,
  });
  return getTask(id);
}

/** Generic partial update; only whitelisted columns are writable from the API. */
const WRITABLE = new Set([
  'title', 'description', 'project_id', 'project_path', 'provider', 'status', 'col_order', 'session_id',
  'parent_task_id', 'parent_session_id', 'started_at', 'ended_at',
  'model', 'effort', 'mode', 'yolo', 'ultracode', 'activity', 'wake_at', 'archived',
]);
function updateTask(id, patch) {
  const existing = 'status' in patch ? getTask(id) : null;
  const statusChanged = existing && patch.status != null && patch.status !== existing.status;
  const nextPatch = statusChanged ? { ...patch, column_changed_at: now() } : patch;
  if ('project_path' in nextPatch && !('project_id' in nextPatch)) {
    const project = getProjectByPath(nextPatch.project_path, true);
    nextPatch.project_id = project ? project.id : null;
  }
  const keys = Object.keys(nextPatch).filter((k) => WRITABLE.has(k) || k === 'column_changed_at');
  if (keys.length === 0) return getTask(id);
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  const data = { id, updated_at: now() };
  for (const k of keys) data[k] = nextPatch[k];
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`).run(data);
  return getTask(id);
}

// Tasks are never hard-deleted — only archived (soft) so data is never lost.
function archiveTask(id) {
  db.prepare(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?`).run(now(), id);
  return getTask(id);
}

function childrenOf(id) {
  return stmts.childrenOf.all(id);
}

// ---- sessions ------------------------------------------------------------

function upsertSession(s) {
  const ts = now();
  db.prepare(`
    INSERT INTO sessions (session_id, provider, task_id, kind, parent_session_id, transcript_path, cwd, name, source, started_at)
    VALUES (@session_id, @provider, @task_id, @kind, @parent_session_id, @transcript_path, @cwd, @name, @source, @started_at)
    ON CONFLICT(session_id) DO UPDATE SET
      provider          = COALESCE(excluded.provider, sessions.provider),
      task_id           = COALESCE(excluded.task_id, sessions.task_id),
      kind              = COALESCE(excluded.kind, sessions.kind),
      parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
      transcript_path   = COALESCE(excluded.transcript_path, sessions.transcript_path),
      cwd               = COALESCE(excluded.cwd, sessions.cwd),
      name              = COALESCE(excluded.name, sessions.name),
      source            = COALESCE(excluded.source, sessions.source),
      ended_at          = NULL
  `).run({
    session_id: s.session_id,
    provider: s.provider ?? 'codex',
    task_id: s.task_id ?? null,
    kind: s.kind ?? null,
    parent_session_id: s.parent_session_id ?? null,
    transcript_path: s.transcript_path ?? null,
    cwd: s.cwd ?? null,
    name: s.name ?? null,
    source: s.source ?? null,
    started_at: s.started_at ?? ts,
  });
}

function getSession(sessionId) {
  return db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
}

function endSession(sessionId) {
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL`).run(now(), sessionId);
}

module.exports = {
  db,
  APP_HOME: paths.APP_HOME,
  DATA_DIR,
  DB_PATH,
  DB_BACKUP_DIR,
  now,
  listProjects,
  getProject,
  getProjectByPath,
  createProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  updateProjectGraphify,
  getMetaValue,
  setMetaValue,
  listTasks,
  getTask,
  createTask,
  updateTask,
  archiveTask,
  childrenOf,
  upsertSession,
  getSession,
  endSession,
};
