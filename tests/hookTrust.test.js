'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspectHooks, listHooks, reviewEnv } = require('../lib/hookTrust');
const { buildHookArgs } = require('../lib/hooksSettings');

const hookArgs = buildHookArgs();
function fixture() {
  return { data: [{ hooks: hookArgs.filter((a) => a.startsWith('hooks.')).map((arg) => ({
    command: JSON.parse(arg.match(/command=("(?:\\.|[^"\\])*")/)[1]),
    source: 'sessionFlags', eventName: arg.split('=')[0], enabled: true, trustStatus: 'trusted',
  })), errors: [] }] };
}

test('only exact, enabled Control Center hooks satisfy the launch gate', () => {
  const result = fixture();
  result.data[0].hooks.push({ command: 'unrelated', source: 'project', enabled: true, trustStatus: 'untrusted' });
  assert.equal(inspectHooks(result, hookArgs).ready, true);
  for (const trustStatus of ['untrusted', 'modified', 'unknown']) {
    result.data[0].hooks[0].trustStatus = trustStatus;
    assert.equal(inspectHooks(result, hookArgs).ready, false);
  }
  result.data[0].hooks[0].trustStatus = 'trusted';
  result.data[0].hooks[0].enabled = false;
  assert.equal(inspectHooks(result, hookArgs).ready, false);
  result.data[0].hooks[0].source = 'project';
  assert.throws(() => inspectHooks(result, hookArgs), /did not load all/);
  assert.throws(() => inspectHooks({}, hookArgs), /invalid/);
  result.data[0].errors.push({ message: 'invalid hook config' });
  assert.throws(() => inspectHooks(result, hookArgs), /invalid hook config/);
});

test('review environment has no task identity and tracking hook exits before opening a DB', () => {
  const old = process.env.CC_TASK_ID;
  process.env.CC_TASK_ID = 'parent-task';
  try {
    const env = reviewEnv();
    assert.equal(env.CC_TASK_ID, undefined);
    assert.equal(env.CC_HOOK_REVIEW, '1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review-hook-'));
    try {
      const db = path.join(dir, 'not-a-database');
      fs.writeFileSync(db, 'must remain unchanged');
      execFileSync(process.execPath, [path.resolve('.codex-dashboard/hooks/task_event.js'), 'SessionStart'], {
        env: { ...env, CC_DB_PATH: db }, input: JSON.stringify({ session_id: 'review' }),
      });
      assert.equal(fs.readFileSync(db, 'utf8'), 'must remain unchanged');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } finally {
    if (old === undefined) delete process.env.CC_TASK_ID; else process.env.CC_TASK_ID = old;
  }
});

test('hook inspection fails closed on an unsupported or stalled Codex API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review-rpc-'));
  try {
    const file = path.join(dir, 'codex');
    fs.writeFileSync(file, '#!/usr/bin/env node\nprocess.stdin.on("data", () => process.stdout.write(JSON.stringify({id:1,error:{message:"unsupported"}})+"\\n"));', { mode: 0o755 });
    await assert.rejects(listHooks({ cwd: dir, hookArgs: [], bin: file }), /unsupported/);
    fs.writeFileSync(file, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);', { mode: 0o755 });
    await assert.rejects(listHooks({ cwd: dir, hookArgs: [], bin: file, timeoutMs: 100 }), /timed out/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
