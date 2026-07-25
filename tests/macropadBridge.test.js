'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MacroPadBridge, MAX_INPUT_BYTES, processSummary } = require('../lib/macropadBridge');

function fixture(overrides = {}) {
  let now = 1000;
  const writes = [];
  const task = {
    id: 'task-1',
    provider: 'codex',
    mode: 'build',
    effort: 'high',
    yolo: 1,
    ...overrides.task,
  };
  const runner = {
    exited: false,
    outputSnapshot: () => '\u001b[2JCodex effort: high',
    write: (data) => writes.push(data),
    ...overrides.runner,
  };
  const manager = {
    isLive: (id) => id === task.id && !runner.exited,
    get: (id) => id === task.id ? runner : null,
  };
  const bridge = new MacroPadBridge({
    manager,
    getTask: (id) => id === task.id ? task : null,
    now: () => now,
    focusTtlMs: 5000,
  });
  return { bridge, task, runner, writes, advance: (ms) => { now += ms; } };
}

test('exposes only the browser-focused live PTY and its provider state', () => {
  const { bridge } = fixture();
  assert.equal(bridge.currentSession(), null);
  const session = bridge.setFocus('task-1', true);
  assert.equal(session.provider, 'codex');
  assert.equal(session.tty, 'control-center:task-1');
  assert.equal(session.effort, 'high');
  assert.equal(session.yolo, true);
  assert.match(session.processes, /dangerously-bypass-approvals-and-sandbox/);
  assert.match(session.contents, /Codex effort: high/);
});

test('focus expires and dead or unknown sessions fail closed', () => {
  const { bridge, runner, advance } = fixture();
  assert.equal(bridge.setFocus('missing', true), null);
  bridge.setFocus('task-1', true);
  advance(5001);
  assert.equal(bridge.currentSession(), null);
  bridge.setFocus('task-1', true);
  runner.exited = true;
  assert.equal(bridge.currentSession(), null);
});

test('writes exact terminal bytes only to the focused live PTY', () => {
  const { bridge, writes } = fixture();
  assert.equal(bridge.write('task-1', '\u001b.'), false);
  bridge.setFocus('task-1', true);
  assert.equal(bridge.write('task-2', '\u001b.'), false);
  assert.equal(bridge.write('task-1', '\u001b.'), true);
  assert.deepEqual(writes, ['\u001b.']);
  assert.equal(bridge.write('task-1', 'x'.repeat(MAX_INPUT_BYTES + 1)), false);
});

test('clearing a different task cannot steal the current focus lease', () => {
  const { bridge } = fixture();
  bridge.setFocus('task-1', true);
  bridge.setFocus('task-2', false);
  assert.equal(bridge.currentSession().taskId, 'task-1');
  bridge.setFocus('task-1', false);
  assert.equal(bridge.currentSession(), null);
});

test('summarizes Claude and Codex launch permission state', () => {
  assert.equal(
    processSummary({ provider: 'claude', yolo: 1, effort: 'xhigh' }),
    'claude --permission-mode bypassPermissions --effort xhigh'
  );
  assert.equal(
    processSummary({ provider: 'claude', yolo: 0, mode: 'plan', effort: 'low' }),
    'claude --permission-mode plan --effort low'
  );
  assert.match(processSummary({ provider: 'codex', yolo: 0, effort: 'medium' }), /^codex /);
});
