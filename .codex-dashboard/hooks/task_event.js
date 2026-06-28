#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const STOP_COMPLETE_WAIT_MS = parseMs(process.env.CC_TASK_STOP_COMPLETE_WAIT_MS, 1500);
const STOP_COMPLETE_POLL_MS = 100;

function now() {
  return new Date().toISOString();
}

function parseMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function readJsonStdin() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function dbPath() {
  if (process.env.CC_DB_PATH) return process.env.CC_DB_PATH;
  return path.join(__dirname, '..', '..', 'data', 'tasks.db');
}

function pickSessionId(data) {
  return data.session_id || data.thread_id || data.conversation_id || data.id ||
    (data.payload && (data.payload.session_id || data.payload.thread_id || data.payload.id)) || null;
}

function pickTranscriptPath(data) {
  return data.transcript_path || data.rollout_path ||
    (data.payload && (data.payload.transcript_path || data.payload.rollout_path)) || null;
}

function pickCwd(data) {
  return data.cwd || (data.payload && data.payload.cwd) || process.cwd();
}

function readTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const len = stat.size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function transcriptTurnComplete(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  let text;
  try {
    text = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return false;
  }

  let complete = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload || {};
    const type = payload.type || entry.type;
    if (type === 'task_started') {
      complete = false;
    } else if (type === 'context_compacted' || entry.type === 'compacted') {
      complete = false;
    } else if (type === 'task_complete') {
      complete = true;
    } else if ((type === 'agent_message' || type === 'message') && payload.phase === 'final_answer') {
      complete = true;
    }
  }
  return complete;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForTurnComplete(transcriptPath) {
  const deadline = Date.now() + STOP_COMPLETE_WAIT_MS;
  for (;;) {
    if (transcriptTurnComplete(transcriptPath)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(Math.min(STOP_COMPLETE_POLL_MS, deadline - Date.now()));
  }
}

function taskTranscriptPath(db, taskId, data) {
  const direct = pickTranscriptPath(data);
  if (direct) return direct;
  const task = db.prepare('SELECT session_id FROM tasks WHERE id = ?').get(taskId);
  if (!task || !task.session_id) return null;
  const session = db.prepare('SELECT transcript_path FROM sessions WHERE session_id = ?').get(task.session_id);
  return session && session.transcript_path ? session.transcript_path : null;
}

function setActivity(db, taskId, activity, ts) {
  db.prepare('UPDATE tasks SET activity = ?, updated_at = ? WHERE id = ? AND archived = 0')
    .run(activity, ts, taskId);
}

function main() {
  const event = process.argv[2] || '';
  const data = readJsonStdin();
  const taskId = process.env.CC_TASK_ID;
  const file = dbPath();
  if (!fs.existsSync(file)) return 0;

  const db = new Database(file);
  const ts = now();
  try {
    db.pragma('busy_timeout = 5000');
    if (event === 'SessionStart') {
      const sessionId = pickSessionId(data);
      const transcriptPath = pickTranscriptPath(data);
      const cwd = pickCwd(data);
      const kind = process.env.CC_SESSION_KIND || null;
      const parentSessionId = process.env.CC_PARENT_SESSION_ID || null;
      if (sessionId) {
        db.prepare(`
          INSERT INTO sessions (session_id, task_id, kind, parent_session_id, transcript_path, cwd, source, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            task_id           = COALESCE(excluded.task_id, sessions.task_id),
            kind              = COALESCE(excluded.kind, sessions.kind),
            parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
            transcript_path   = COALESCE(excluded.transcript_path, sessions.transcript_path),
            cwd               = COALESCE(excluded.cwd, sessions.cwd),
            source            = COALESCE(excluded.source, sessions.source),
            ended_at          = NULL
        `).run(sessionId, taskId || null, kind, parentSessionId, transcriptPath, cwd, 'hook', ts);
        if (taskId) {
          const activity = process.env.CC_HAS_PROMPT === '1' ? 'working' : 'idle';
          db.prepare(`
            UPDATE tasks
            SET session_id = COALESCE(session_id, ?),
                status = 'in_progress',
                activity = ?,
                started_at = COALESCE(started_at, ?),
                ended_at = NULL,
                updated_at = ?
            WHERE id = ?
          `).run(sessionId, activity, ts, ts, taskId);
        }
      }
      return 0;
    }

    if (!taskId) return 0;
    if (event === 'UserPromptSubmit') {
      setActivity(db, taskId, 'working', ts);
    } else if (event === 'PermissionRequest') {
      setActivity(db, taskId, 'idle', ts);
    } else if (event === 'Stop') {
      const transcriptPath = taskTranscriptPath(db, taskId, data);
      if (waitForTurnComplete(transcriptPath)) setActivity(db, taskId, 'idle', ts);
    }
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exit(main() || 0);
} catch (err) {
  try {
    process.stderr.write(`dashboard codex hook error: ${err && err.message ? err.message : String(err)}\n`);
  } catch {}
  process.exit(0);
}
