'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const HOOK = path.join(__dirname, '..', '.codex-dashboard', 'hooks', 'task_event.js');

function unloadDbModule() {
  delete require.cache[require.resolve('../lib/db')];
}

function loadDb(dbPath) {
  process.env.CC_DB_PATH = dbPath;
  unloadDbModule();
  return require('../lib/db');
}

function writeTranscript(file, payloads) {
  fs.writeFileSync(file, payloads.map((payload, i) => JSON.stringify({
    timestamp: `2026-06-27T10:00:0${i}.000Z`,
    type: 'event_msg',
    payload,
  })).join('\n') + '\n');
}

function runHook(event, dbPath, taskId, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(input || {}),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      CC_DB_PATH: dbPath,
      CC_TASK_ID: taskId,
      CC_TASK_STOP_COMPLETE_WAIT_MS: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function readTask(dbPath, taskId) {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  } finally {
    raw.close();
  }
}

function readSession(dbPath, sessionId) {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  } finally {
    raw.close();
  }
}

test('Stop hook keeps activity working until transcript turn completion', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-hook-stop-working-'));
  const dbPath = path.join(tmp, 'tasks.db');
  const transcript = path.join(tmp, 'rollout.jsonl');
  writeTranscript(transcript, [
    { type: 'task_started' },
    { type: 'agent_message', phase: 'commentary', message: 'Still checking files.' },
  ]);

  const db = loadDb(dbPath);
  const task = db.createTask({ title: 'still running', project_path: tmp });
  db.updateTask(task.id, { status: 'in_progress', session_id: 'sess-1', activity: 'working', started_at: db.now() });
  db.upsertSession({ session_id: 'sess-1', task_id: task.id, kind: 'start', transcript_path: transcript });
  db.db.close();

  runHook('Stop', dbPath, task.id, { transcript_path: transcript });

  assert.equal(readTask(dbPath, task.id).activity, 'working');
});

test('Stop hook marks idle when transcript turn is complete', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-hook-stop-idle-'));
  const dbPath = path.join(tmp, 'tasks.db');
  const transcript = path.join(tmp, 'rollout.jsonl');
  writeTranscript(transcript, [
    { type: 'task_started' },
    { type: 'agent_message', phase: 'final_answer', message: 'Done.' },
    { type: 'task_complete' },
  ]);

  const db = loadDb(dbPath);
  const task = db.createTask({ title: 'ready for review', project_path: tmp });
  db.updateTask(task.id, { status: 'in_progress', session_id: 'sess-1', activity: 'working', started_at: db.now() });
  db.upsertSession({ session_id: 'sess-1', task_id: task.id, kind: 'start', transcript_path: transcript });
  db.db.close();

  runHook('Stop', dbPath, task.id, { transcript_path: transcript });

  assert.equal(readTask(dbPath, task.id).activity, 'idle');
});

test('SessionStart hook clears stale session ended_at on resume', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-hook-session-start-'));
  const dbPath = path.join(tmp, 'tasks.db');
  const transcript = path.join(tmp, 'rollout.jsonl');
  writeTranscript(transcript, [{ type: 'task_started' }]);

  const db = loadDb(dbPath);
  const task = db.createTask({ title: 'resumed', project_path: tmp });
  db.upsertSession({ session_id: 'sess-1', task_id: task.id, kind: 'start', transcript_path: transcript });
  db.endSession('sess-1');
  assert.ok(db.getSession('sess-1').ended_at);
  db.db.close();

  runHook('SessionStart', dbPath, task.id, {
    session_id: 'sess-1',
    transcript_path: transcript,
    cwd: tmp,
  }, {
    CC_SESSION_KIND: 'resume',
    CC_HAS_PROMPT: '1',
  });

  const taskAfter = readTask(dbPath, task.id);
  const sessionAfter = readSession(dbPath, 'sess-1');
  assert.equal(taskAfter.status, 'in_progress');
  assert.equal(taskAfter.activity, 'working');
  assert.equal(sessionAfter.ended_at, null);
});
