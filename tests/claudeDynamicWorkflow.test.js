'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const HOOK = path.join(__dirname, '..', 'lib', 'providers', 'claude', 'hooks', 'activity.py');
const PYTHON = process.env.CC_PYTHON || 'python3';

function tmp(ext) {
  return path.join(os.tmpdir(), `cc-claude-wf-${crypto.randomBytes(6).toString('hex')}${ext}`);
}

function writeTranscript(lines) {
  const file = tmp('.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

function makeDb({ activity = 'working', wake_at = null } = {}) {
  const file = tmp('.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      activity TEXT,
      wake_at TEXT,
      updated_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.prepare(`INSERT INTO tasks (id, activity, wake_at, updated_at, archived) VALUES (?,?,?,?,0)`)
    .run('t1', activity, wake_at, '2026-06-28T00:00:00+00:00');
  db.close();
  return file;
}

function runHook(dbFile, event) {
  const res = spawnSync(PYTHON, [HOOK], {
    input: JSON.stringify(event),
    env: { ...process.env, CC_TASK_ID: 't1', CC_DB_PATH: dbFile },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`);
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(`SELECT activity, wake_at FROM tasks WHERE id = 't1'`).get();
  } finally {
    db.close();
  }
}

const userPrompt = (text, uuid) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const assistant = (blocks, uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: blocks } });
const txt = (text) => ({ type: 'text', text });
const tool = (name, input) => ({ type: 'tool_use', id: 't_' + name, name, input: input || {} });
const notification = (status, uuid) =>
  userPrompt(`[SYSTEM NOTIFICATION]\n<task-notification><task-id>x</task-id><status>${status}</status></task-notification>`, uuid);
const future = (iso) => iso != null && Date.parse(iso) > Date.now();

test('Claude Stop after /loop ScheduleWakeup records workflow and future wake_at', () => {
  const transcript = writeTranscript([
    userPrompt('/loop keep improving the docs', 'u1'),
    assistant([txt('Did iteration 1.'), tool('ScheduleWakeup', { delaySeconds: 300 })], 'a1'),
  ]);
  const row = runHook(makeDb(), { hook_event_name: 'Stop', transcript_path: transcript });
  assert.equal(row.activity, 'workflow');
  assert.ok(future(row.wake_at), `wake_at should be in the future, got ${row.wake_at}`);
});

test('Claude Stop after final loop iteration clears workflow state', () => {
  const transcript = writeTranscript([
    userPrompt('/loop keep improving the docs', 'u1'),
    assistant([tool('ScheduleWakeup', { delaySeconds: 300 })], 'a1'),
    userPrompt('Continue the loop.', 'u2'),
    assistant([txt('Done.')], 'a2'),
  ]);
  const row = runHook(makeDb({ activity: 'workflow', wake_at: '2999-01-01T00:00:00+00:00' }), {
    hook_event_name: 'Stop',
    transcript_path: transcript,
  });
  assert.equal(row.activity, 'idle');
  assert.equal(row.wake_at, null);
});

test('Claude Stop while Workflow tool is pending records workflow', () => {
  const transcript = writeTranscript([
    userPrompt('Run a workflow to audit the repo', 'u1'),
    assistant([txt('Launching workflow.'), tool('Workflow', { script: 'audit' })], 'a1'),
  ]);
  const row = runHook(makeDb(), { hook_event_name: 'Stop', transcript_path: transcript });
  assert.equal(row.activity, 'workflow');
  assert.ok(future(row.wake_at), `wake_at should be in the future, got ${row.wake_at}`);
});

test('Claude Stop after Workflow completion clears workflow state', () => {
  const transcript = writeTranscript([
    userPrompt('Run a workflow to audit the repo', 'u1'),
    assistant([tool('Workflow', { script: 'audit' })], 'a1'),
    notification('completed', 'u2'),
    assistant([txt('Finished.')], 'a2'),
  ]);
  const row = runHook(makeDb({ activity: 'workflow', wake_at: '2999-01-01T00:00:00+00:00' }), {
    hook_event_name: 'Stop',
    transcript_path: transcript,
  });
  assert.equal(row.activity, 'idle');
  assert.equal(row.wake_at, null);
});

test('Claude Stop with empty session_crons overrides stale ScheduleWakeup', () => {
  const transcript = writeTranscript([
    userPrompt('/loop improve things', 'u1'),
    assistant([tool('ScheduleWakeup', { delaySeconds: 300 })], 'a1'),
  ]);
  const row = runHook(makeDb({ activity: 'workflow', wake_at: '2999-01-01T00:00:00+00:00' }), {
    hook_event_name: 'Stop',
    transcript_path: transcript,
    session_crons: [],
  });
  assert.equal(row.activity, 'idle');
  assert.equal(row.wake_at, null);
});
