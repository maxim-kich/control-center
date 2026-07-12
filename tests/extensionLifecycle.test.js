'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ExtensionLifecycle } = require('../lib/core/extensionLifecycle');
const { loadExtensions, scanExtensions } = require('../lib/core/extensions');

function memoryStateDb() {
  const rows = new Map();
  const keyFor = (extensionId, scopeType, scopeId) => `${extensionId}:${scopeType}:${scopeId}`;
  return {
    listExtensionState(extensionId, scopeType, scopeId) {
      return { ...(rows.get(keyFor(extensionId, scopeType, scopeId)) || {}) };
    },
    setExtensionState(extensionId, scopeType, scopeId, values) {
      const key = keyFor(extensionId, scopeType, scopeId);
      rows.set(key, { ...(rows.get(key) || {}), ...(values || {}) });
      return this.listExtensionState(extensionId, scopeType, scopeId);
    },
    setExtensionStateValue(extensionId, scopeType, scopeId, key, value) {
      return this.setExtensionState(extensionId, scopeType, scopeId, { [key]: value });
    },
    deleteExtensionStateValue(extensionId, scopeType, scopeId, key) {
      const stateKey = keyFor(extensionId, scopeType, scopeId);
      const state = { ...(rows.get(stateKey) || {}) };
      delete state[key];
      rows.set(stateKey, state);
      return state;
    },
  };
}

function extension(id, hookNames) {
  return {
    id,
    name: id,
    version: '1.0.0',
    errors: [],
    hooks: hookNames.map((name, index) => ({ name, order: 100 + index, timeoutMs: 50 })),
  };
}

test('lifecycle notifications run in stable order and isolate handler errors', async () => {
  const lifecycle = new ExtensionLifecycle({ db: memoryStateDb(), timeoutMs: 50 });
  const calls = [];
  const later = extension('later', ['task.completed']);
  later.hooks[0].order = 200;
  lifecycle.register(later, { hooks: { 'task.completed': () => calls.push('later') } });
  const first = extension('first', ['task.completed']);
  first.hooks[0].order = 10;
  lifecycle.register(first, { hooks: { 'task.completed': () => calls.push('first') } });
  const broken = extension('broken', ['task.completed']);
  broken.hooks[0].order = 20;
  lifecycle.register(broken, { hooks: { 'task.completed': () => { throw new Error('boom'); } } });

  const result = await lifecycle.notify('task.completed', { task: { id: 'task-1' } });

  assert.deepEqual(calls, ['first', 'later']);
  assert.equal(result.ok, false);
  assert.equal(result.results.find((item) => item.extensionId === 'broken').error, 'boom');
});

test('lifecycle timeouts are reported and policy conflicts resolve to deny', async () => {
  const lifecycle = new ExtensionLifecycle({ db: memoryStateDb(), timeoutMs: 20 });
  const slow = extension('slow', ['git.autoCommitPolicy']);
  slow.hooks[0].timeoutMs = 5;
  lifecycle.register(slow, { hooks: { 'git.autoCommitPolicy': () => new Promise(() => {}) } });
  lifecycle.register(extension('allowing', ['git.autoCommitPolicy']), {
    hooks: { 'git.autoCommitPolicy': () => ({ decision: 'allow', reason: 'allow test' }) },
  });
  lifecycle.register(extension('denying', ['git.autoCommitPolicy']), {
    hooks: { 'git.autoCommitPolicy': () => ({ decision: 'deny', reason: 'deny test' }) },
  });

  const result = await lifecycle.evaluatePolicy('git.autoCommitPolicy', {});

  assert.equal(result.decision, 'deny');
  assert.equal(result.conflict, true);
  assert.equal(result.results.find((item) => item.extensionId === 'slow').timedOut, true);
  assert.ok(lifecycle.publicDiagnostics().some((item) => item.type === 'policy-conflict'));
});

test('Task Journal tracks Codex and Claude completions and controls auto-commit policy', async () => {
  const db = memoryStateDb();
  const extensionsDir = path.join(__dirname, '..', 'examples', 'extensions');
  const manager = loadExtensions({ extensionsDir, context: { db } });
  const journal = manager.extensions.find((item) => item.id === 'task-journal');
  assert.ok(journal);
  assert.deepEqual(journal.errors, []);

  const project = { id: 'project-1', name: 'Example', path: '/tmp/example' };
  for (const [id, provider] of [['task-codex', 'codex'], ['task-claude', 'claude']]) {
    const previous = { id, title: id, project_id: project.id, project_path: project.path, provider, status: 'in_progress' };
    const task = { ...previous, status: 'done', ended_at: `2026-07-11T10:0${provider === 'codex' ? '0' : '1'}:00.000Z` };
    const context = { task, previous, project, provider: { id: provider, name: provider } };
    await manager.notify('task.statusChanged', context);
    await manager.notify('task.completed', context);
  }

  const enriched = await manager.enrich('project.metadata', { project });
  assert.equal(enriched.metadata['task-journal'].pendingCount, 2);
  assert.equal(enriched.metadata['task-journal'].completedCount, 2);
  const state = db.listExtensionState('task-journal', 'project', project.id);
  assert.deepEqual(state.entries.map((entry) => entry.provider), ['codex', 'claude']);
  assert.equal(state.statusTransitions, 2);

  assert.equal((await manager.evaluatePolicy('git.autoCommitPolicy', { project })).decision, 'abstain');
  db.setExtensionState('task-journal', 'project', project.id, { manualCheckpoints: true });
  const policy = await manager.evaluatePolicy('git.autoCommitPolicy', { project });
  assert.equal(policy.decision, 'deny');
  assert.match(policy.reason, /manual checkpoints/);
});

test('extension manifests validate lifecycle permission and supported hook names', () => {
  const extensionsDir = path.join(__dirname, '..', 'examples', 'extensions');
  const scanned = scanExtensions(extensionsDir);
  const journal = scanned.extensions.find((item) => item.id === 'task-journal');
  assert.ok(journal.hooks.some((hook) => hook.name === 'task.completed'));
  assert.equal(journal.permissions.includes('hooks:lifecycle'), true);
  assert.equal(journal.apiVersion, 1);
  assert.deepEqual(journal.errors, []);
});
