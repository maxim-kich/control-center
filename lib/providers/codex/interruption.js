'use strict';

const fs = require('fs');
const MAX_TAIL_BYTES = 1024 * 1024;

// Only structured lifecycle records are evidence of interruption. Escape and
// terminal output can also belong to menus, editors, or ordinary tool output.
function latestInterruption(file) {
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.subarray(0, read).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    fs.closeSync(fd);
  }
  let interruptedAt = null;
  // Ignore a partially flushed final record until its newline arrives.
  for (const line of text.split('\n').slice(0, -1)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const type = entry.payload?.type;
    if (entry.type === 'event_msg' && ['turn_aborted', 'task_interrupted'].includes(type)) {
      const at = Date.parse(entry.timestamp);
      interruptedAt = Number.isFinite(at) ? at : null;
    } else if (entry.type === 'response_item' || entry.type === 'turn_context' ||
        entry.type === 'compacted' || (entry.type === 'event_msg' &&
        !['token_count'].includes(type))) {
      interruptedAt = null;
    }
  }
  return interruptedAt;
}

function watchInterruptions({ taskId, runner, db, findTranscript, launchAtMs, intervalMs = 500 }) {
  const timer = setInterval(() => {
    if (runner.cancelled || runner.exited) { clearInterval(timer); return; }
    try {
      const task = db.getTask(taskId);
      if (!task || task.archived || task.status !== 'in_progress' ||
          task.activity !== 'working' || !task.session_id) return;
      const file = db.getSession(task.session_id)?.transcript_path || findTranscript(task.session_id);
      if (!file) return;
      const at = latestInterruption(file);
      if (at === null || at < launchAtMs || at < Date.parse(task.updated_at)) return;
      // Hooks write from other processes; never clobber a prompt or workflow
      // transition that raced this read. Keep the ticket In Progress.
      db.db.prepare(`UPDATE tasks SET activity = 'idle', updated_at = ?
        WHERE id = ? AND session_id = ? AND updated_at = ?
          AND activity = 'working' AND status = 'in_progress' AND archived = 0`)
        .run(db.now(), taskId, task.session_id, task.updated_at);
    } catch {
      // Missing/rotating transcripts must not disrupt the interactive session.
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { latestInterruption, watchInterruptions };
