'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { latestInterruption, watchInterruptions } = require('../lib/providers/codex/interruption');

test('structured interruptions require complete records and are superseded by later activity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-interrupt-'));
  const file = path.join(dir, 'rollout.jsonl');
  const record = (type, outer = 'event_msg') => JSON.stringify({ type: outer,
    timestamp: '2026-09-06T12:00:00.000Z', payload: { type } });
  try {
    for (const type of ['turn_aborted', 'task_interrupted']) {
      fs.writeFileSync(file, record(type));
      assert.equal(latestInterruption(file), null);
      fs.appendFileSync(file, '\n');
      assert.equal(latestInterruption(file), Date.parse('2026-09-06T12:00:00Z'));
      for (const later of ['task_started', 'user_message', 'task_complete', 'context_compacted']) {
        fs.writeFileSync(file, record(type) + '\n' + record(later) + '\n');
        assert.equal(latestInterruption(file), null);
      }
    }
    fs.writeFileSync(file, record('turn_aborted', 'response_item') + '\n');
    assert.equal(latestInterruption(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watcher preserves workflow waits and stops reading after runner exit', async () => {
  const runner = { exited: false };
  let reads = 0;
  const db = { getTask() { reads++; return { activity: 'workflow', status: 'in_progress' }; } };
  const stop = watchInterruptions({ taskId: 'task', runner, db, intervalMs: 5,
    findTranscript() { assert.fail('workflow must not be reconciled'); } });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(reads > 0);
    runner.exited = true;
    const previous = reads;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reads, previous);
  } finally { stop(); }
});
