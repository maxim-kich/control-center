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
      CC_LOG_DIR: path.join(path.dirname(dbPath), 'logs'),
      CC_DB_PATH: dbPath,
      CC_TASK_ID: taskId,
      CC_TASK_STOP_COMPLETE_WAIT_MS: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  if (event === 'Stop') assert.deepEqual(JSON.parse(result.stdout), {});
  return result;
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

test('PostToolUse hook recovers idle Codex task after permission approval', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-hook-post-tool-'));
  const dbPath = path.join(tmp, 'tasks.db');

  const db = loadDb(dbPath);
  const task = db.createTask({ title: 'approved command', project_path: tmp });
  db.updateTask(task.id, {
    status: 'in_progress',
    session_id: 'sess-1',
    activity: 'idle',
    wake_at: '2999-01-01T00:00:00.000Z',
    started_at: db.now(),
  });
  db.db.close();

  runHook('PostToolUse', dbPath, task.id, { tool_name: 'Bash' });

  const taskAfter = readTask(dbPath, task.id);
  assert.equal(taskAfter.activity, 'working');
  assert.equal(taskAfter.wake_at, null);
});

test('PostToolUse hook does not clobber non-idle Codex task state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-hook-post-tool-guard-'));
  const dbPath = path.join(tmp, 'tasks.db');
  const wakeAt = '2999-01-01T00:00:00.000Z';

  const db = loadDb(dbPath);
  const task = db.createTask({ title: 'workflow wait', project_path: tmp });
  db.updateTask(task.id, {
    status: 'in_progress',
    session_id: 'sess-1',
    activity: 'workflow',
    wake_at: wakeAt,
    started_at: db.now(),
  });
  db.db.close();

  runHook('PostToolUse', dbPath, task.id, { tool_name: 'Bash' });

  const taskAfter = readTask(dbPath, task.id);
  assert.equal(taskAfter.activity, 'workflow');
  assert.equal(taskAfter.wake_at, wakeAt);
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

function stopFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stop-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'tasks.db');
  const db = loadDb(dbPath);
  const task = db.createTask({ title: 'Stop fixture', project_path: tmp });
  db.updateTask(task.id, { status: 'in_progress', activity: 'working', session_id: 'session' });
  db.db.close();
  return { tmp, dbPath, taskId: task.id, transcript: path.join(tmp, 'rollout.jsonl') };
}

function logs(f) {
  return fs.readFileSync(path.join(f.tmp, 'logs', 'codex-hooks.jsonl'), 'utf8');
}

test('current Stop payload completes without a transcript and next prompt resumes working', t => {
  const f = stopFixture(t);
  for (const stop_hook_active of [false, true]) {
    runHook('Stop', f.dbPath, f.taskId, {
      hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn',
      stop_hook_active, last_assistant_message: 'PRIVATE ASSISTANT CONTENT',
      transcript_path: f.transcript,
    });
    assert.equal(readTask(f.dbPath, f.taskId).activity, 'idle');
    runHook('UserPromptSubmit', f.dbPath, f.taskId, { prompt: 'PRIVATE PROMPT' });
    assert.equal(readTask(f.dbPath, f.taskId).activity, 'working');
  }
  assert.match(logs(f), /completion_detected/);
  assert.match(logs(f), /stop_payload/);
  assert.doesNotMatch(logs(f), /PRIVATE|PRIVATE PROMPT/);
});

test('current payload wins over an incomplete or changed transcript format', t => {
  const f = stopFixture(t);
  fs.writeFileSync(f.transcript, 'unknown future format');
  runHook('Stop', f.dbPath, f.taskId, { last_assistant_message: 'Done', transcript_path: f.transcript });
  assert.equal(readTask(f.dbPath, f.taskId).activity, 'idle');
});

test('legacy fallback supports final answer and task_complete independently', t => {
  const f = stopFixture(t);
  for (const end of [{ type: 'agent_message', phase: 'final_answer' }, { type: 'task_complete' }]) {
    runHook('UserPromptSubmit', f.dbPath, f.taskId, {});
    writeTranscript(f.transcript, [{ type: 'task_started' }, end]);
    runHook('Stop', f.dbPath, f.taskId, { transcript_path: f.transcript });
    assert.equal(readTask(f.dbPath, f.taskId).activity, 'idle');
  }
});

test('fallback never reuses completion before compaction, interruption, continuation or work', t => {
  const f = stopFixture(t);
  for (const tail of [
    { type: 'context_compacted' }, { type: 'compacted' }, { type: 'turn_aborted' },
    { type: 'task_interrupted' }, { type: 'task_started' }, { type: 'user_message' },
    { type: 'message', role: 'user', phase: 'final_answer' },
    { type: 'agent_message', phase: 'commentary' }, { type: 'function_call' },
    { type: 'reasoning' },
  ]) {
    writeTranscript(f.transcript, [{ type: 'task_complete' }, tail]);
    runHook('Stop', f.dbPath, f.taskId, { transcript_path: f.transcript });
    assert.equal(readTask(f.dbPath, f.taskId).activity, 'working', tail.type);
  }
});

test('empty current message and non-Stop event do not consume old completion', t => {
  const f = stopFixture(t);
  writeTranscript(f.transcript, [{ type: 'task_complete' }]);
  for (const input of [
    { last_assistant_message: '' }, { last_assistant_message: '   ' },
    { last_assistant_message: 123 },
    ...['PreCompact', 'PostCompact', 'Interrupt', 'PostToolUse'].map(hook_event_name => ({ hook_event_name, last_assistant_message: 'old' })),
  ]) {
    runHook('Stop', f.dbPath, f.taskId, { transcript_path: f.transcript, ...input });
    assert.equal(readTask(f.dbPath, f.taskId).activity, 'working');
  }
});

test('missing transcript keeps working and logs non-completion', t => {
  const f = stopFixture(t);
  for (const input of [{}, { transcript_path: f.transcript }, { last_assistant_message: null }]) {
    runHook('Stop', f.dbPath, f.taskId, input);
    assert.equal(readTask(f.dbPath, f.taskId).activity, 'working');
  }
  assert.match(logs(f), /completion_not_detected/);
});

test('Stop preserves workflow waits and ignores a different session', t => {
  const f = stopFixture(t);
  runHook('Stop', f.dbPath, f.taskId, { session_id: 'other', last_assistant_message: 'Done' });
  assert.equal(readTask(f.dbPath, f.taskId).activity, 'working');
  const db = loadDb(f.dbPath);
  db.updateTask(f.taskId, { activity: 'workflow', wake_at: '2999-01-01T00:00:00.000Z' });
  db.db.close();
  runHook('Stop', f.dbPath, f.taskId, { last_assistant_message: 'Done' });
  assert.equal(readTask(f.dbPath, f.taskId).activity, 'workflow');
  assert.equal(readTask(f.dbPath, f.taskId).wake_at, '2999-01-01T00:00:00.000Z');
});

test('diagnostics distinguish invocation, missing metadata and database failures safely', t => {
  const f = stopFixture(t);
  runHook('UserPromptSubmit', f.dbPath, f.taskId, {});
  assert.doesNotMatch(logs(f), /"event":"Stop"/);
  runHook('Stop', f.dbPath, '', {});
  runHook('Stop', f.dbPath, 'unknown-task', {});
  const db = loadDb(f.dbPath);
  db.updateTask(f.taskId, { session_id: null });
  db.db.close();
  runHook('Stop', f.dbPath, f.taskId, {});
  // A failing update must not leak a trigger's sensitive error text.
  const raw = new Database(f.dbPath);
  raw.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(FAIL, 'SECRET credential'); END");
  raw.close();
  runHook('Stop', f.dbPath, f.taskId, { last_assistant_message: 'PRIVATE' });
  runHook('Stop', path.join(f.tmp, 'missing.db'), f.taskId, {});
  const log = logs(f);
  for (const outcome of ['invoked', 'missing_task', 'missing_session', 'database_update_failure']) assert.match(log, new RegExp(outcome));
  assert.doesNotMatch(log, /SECRET|credential|PRIVATE/);
});
