#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let target;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function rows(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function pick(row, key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : fallback;
}

function validProvider(value) {
  return value === 'codex' || value === 'claude';
}

function normalizeMode(mode, provider, yolo) {
  const raw = String(mode || '').trim();
  if (provider === 'claude' && ['build', 'plan', 'auto'].includes(raw)) return raw;
  if (raw === 'plan') return 'plan';
  if (raw === 'auto') return 'build';
  return 'build';
}

function normalizeYolo(mode, provider, yolo) {
  if (mode === 'plan') return 0;
  if (provider === 'codex' && String(mode || '') === 'auto') return 0;
  return yolo ? 1 : 0;
}

function projectNameFromPath(projectPath) {
  if (!projectPath) return 'Imported Project';
  const trimmed = String(projectPath).replace(/[\\/]+$/, '');
  return path.basename(trimmed) || trimmed || 'Imported Project';
}

function ensureProject(row, projectIdMap) {
  const projectPath = String(pick(row, 'path', pick(row, 'project_path', '')) || '').trim();
  if (!projectPath) return null;

  const byPath = target.getProjectByPath(projectPath, true);
  if (byPath) {
    if (row.id) projectIdMap.set(row.id, byPath.id);
    return byPath.id;
  }

  const id = String(pick(row, 'id', crypto.randomUUID()) || crypto.randomUUID());
  const now = target.now();
  target.db.prepare(`
    INSERT OR IGNORE INTO projects (
      id, name, description, path, archived, graphify_enabled, graphify_status,
      graphify_last_started_at, graphify_last_finished_at, graphify_last_success_at,
      graphify_last_error, graphify_hook_status, graphify_dirty_at,
      created_at, updated_at
    )
    VALUES (
      @id, @name, @description, @path, @archived, @graphify_enabled, @graphify_status,
      @graphify_last_started_at, @graphify_last_finished_at, @graphify_last_success_at,
      @graphify_last_error, @graphify_hook_status, @graphify_dirty_at,
      @created_at, @updated_at
    )
  `).run({
    id,
    name: String(pick(row, 'name', projectNameFromPath(projectPath)) || projectNameFromPath(projectPath)),
    description: String(pick(row, 'description', '') || ''),
    path: projectPath,
    archived: pick(row, 'archived', 0) ? 1 : 0,
    graphify_enabled: pick(row, 'graphify_enabled', 0) ? 1 : 0,
    graphify_status: String(pick(row, 'graphify_status', pick(row, 'graphify_enabled', 0) ? 'pending' : 'disabled') || 'disabled'),
    graphify_last_started_at: pick(row, 'graphify_last_started_at', null),
    graphify_last_finished_at: pick(row, 'graphify_last_finished_at', null),
    graphify_last_success_at: pick(row, 'graphify_last_success_at', null),
    graphify_last_error: pick(row, 'graphify_last_error', null),
    graphify_hook_status: pick(row, 'graphify_hook_status', null),
    graphify_dirty_at: pick(row, 'graphify_dirty_at', null),
    created_at: pick(row, 'created_at', now) || now,
    updated_at: pick(row, 'updated_at', now) || now,
  });
  if (row.id) projectIdMap.set(row.id, id);
  return id;
}

function importTask(row, provider, projectIdMap) {
  const now = target.now();
  const projectPath = String(pick(row, 'project_path', '') || '').trim();
  const project = projectPath ? target.getProjectByPath(projectPath, true) : null;
  const oldProjectId = pick(row, 'project_id', null);
  const projectId = project ? project.id : oldProjectId && projectIdMap.get(oldProjectId) ? projectIdMap.get(oldProjectId) : null;
  const rawMode = pick(row, 'mode', 'build');
  const mode = normalizeMode(rawMode, provider, pick(row, 'yolo', 1));
  const id = String(pick(row, 'id', crypto.randomUUID()) || crypto.randomUUID());
  target.db.prepare(`
    INSERT INTO tasks (
      id, title, description, project_id, project_path, provider, status, session_id,
      parent_task_id, parent_session_id, col_order, model, effort, mode, yolo, ultracode,
      activity, wake_at, archived, column_changed_at, created_at, updated_at, started_at, ended_at
    )
    VALUES (
      @id, @title, @description, @project_id, @project_path, @provider, @status, @session_id,
      @parent_task_id, @parent_session_id, @col_order, @model, @effort, @mode, @yolo, @ultracode,
      @activity, @wake_at, @archived, @column_changed_at, @created_at, @updated_at, @started_at, @ended_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      project_id = excluded.project_id,
      project_path = excluded.project_path,
      provider = excluded.provider,
      status = excluded.status,
      session_id = excluded.session_id,
      parent_task_id = excluded.parent_task_id,
      parent_session_id = excluded.parent_session_id,
      col_order = excluded.col_order,
      model = excluded.model,
      effort = excluded.effort,
      mode = excluded.mode,
      yolo = excluded.yolo,
      ultracode = excluded.ultracode,
      activity = excluded.activity,
      wake_at = excluded.wake_at,
      archived = excluded.archived,
      column_changed_at = excluded.column_changed_at,
      updated_at = excluded.updated_at,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at
  `).run({
    id,
    title: String(pick(row, 'title', 'Imported task') || 'Imported task'),
    description: String(pick(row, 'description', '') || ''),
    project_id: projectId,
    project_path: projectPath,
    provider,
    status: ['backlog', 'in_progress', 'done'].includes(pick(row, 'status', 'backlog')) ? pick(row, 'status', 'backlog') : 'backlog',
    session_id: pick(row, 'session_id', null),
    parent_task_id: pick(row, 'parent_task_id', null),
    parent_session_id: pick(row, 'parent_session_id', null),
    col_order: Number.isFinite(Number(pick(row, 'col_order', 0))) ? Number(pick(row, 'col_order', 0)) : 0,
    model: String(pick(row, 'model', provider === 'claude' ? 'sonnet' : 'gpt-5.5') || (provider === 'claude' ? 'sonnet' : 'gpt-5.5')),
    effort: String(pick(row, 'effort', 'medium') || 'medium'),
    mode,
    yolo: normalizeYolo(rawMode, provider, pick(row, 'yolo', 1)),
    ultracode: pick(row, 'ultracode', 0) ? 1 : 0,
    activity: pick(row, 'activity', null),
    wake_at: pick(row, 'wake_at', null),
    archived: pick(row, 'archived', 0) ? 1 : 0,
    column_changed_at: pick(row, 'column_changed_at', pick(row, 'created_at', now)) || now,
    created_at: pick(row, 'created_at', now) || now,
    updated_at: pick(row, 'updated_at', now) || now,
    started_at: pick(row, 'started_at', null),
    ended_at: pick(row, 'ended_at', null),
  });
  return id;
}

function importSession(row, provider) {
  if (!pick(row, 'session_id', null)) return null;
  target.upsertSession({
    session_id: row.session_id,
    provider,
    task_id: pick(row, 'task_id', null),
    kind: pick(row, 'kind', null),
    parent_session_id: pick(row, 'parent_session_id', null),
    transcript_path: pick(row, 'transcript_path', null),
    cwd: pick(row, 'cwd', null),
    name: pick(row, 'name', null),
    source: pick(row, 'source', 'legacy-import'),
    started_at: pick(row, 'started_at', null),
  });
  if (pick(row, 'ended_at', null)) target.db.prepare(`UPDATE sessions SET ended_at = ? WHERE session_id = ?`).run(row.ended_at, row.session_id);
  return row.session_id;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from && path.resolve(args.from);
  const provider = args['source-provider'];
  if (args['db-path']) {
    process.env.CC_DB_PATH = path.resolve(args['db-path']);
  } else if (args.home || process.env.CONTROL_CENTER_HOME) {
    delete process.env.CC_DB_PATH;
  }
  if (args.home) process.env.CONTROL_CENTER_HOME = path.resolve(args.home);
  target = require('../lib/db');
  if (!from || !validProvider(provider)) {
    console.error('Usage: control-center import --from <old-control-center-path> --source-provider <codex|claude> [--home <path>] [--db-path <path>]');
    process.exit(2);
  }

  const sourceDb = path.join(from, 'data', 'tasks.db');
  if (!fs.existsSync(sourceDb)) {
    console.error(`Legacy database not found: ${sourceDb}`);
    process.exit(1);
  }

  const source = new Database(sourceDb, { readonly: true });
  const taskCols = columns(source, 'tasks');
  if (!taskCols.has('id')) {
    console.error(`Unsupported legacy database: tasks table is missing id column (${sourceDb})`);
    process.exit(1);
  }

  const projectIdMap = new Map();
  const sourceTasks = rows(source, 'tasks');
  const sourceSessions = rows(source, 'sessions');
  const tx = target.db.transaction(() => {
    for (const project of rows(source, 'projects')) ensureProject(project, projectIdMap);
    for (const task of sourceTasks) {
      if (task.project_path && !target.getProjectByPath(task.project_path, true)) {
        ensureProject({ path: task.project_path, name: projectNameFromPath(task.project_path) }, projectIdMap);
      }
      importTask(task, provider, projectIdMap);
    }
    for (const session of sourceSessions) importSession(session, provider);

    const knownSessions = new Set(sourceSessions.map((s) => s.session_id).filter(Boolean));
    for (const task of sourceTasks) {
      if (task.session_id && !knownSessions.has(task.session_id)) {
        importSession({
          session_id: task.session_id,
          task_id: task.id,
          kind: 'start',
          cwd: task.project_path,
          name: task.title,
          started_at: task.started_at || task.created_at,
          ended_at: task.ended_at,
        }, provider);
      }
    }
  });
  tx();
  source.close();

  console.log(`Imported ${sourceTasks.length} tasks from ${sourceDb}`);
  console.log(`Target DB: ${target.DB_PATH}`);
}

main();
