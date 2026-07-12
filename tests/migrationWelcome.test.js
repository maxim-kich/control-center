'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMigrationWelcomeState,
  markMigrationWelcomeComplete,
} = require('../lib/core/migrationWelcome');

function plan(overrides = {}) {
  return {
    createdAt: '2026-07-12T00:00:00.000Z',
    newUser: false,
    noOp: false,
    targets: {
      graphify: {
        domain: 'graphify',
        priorOwner: 'legacy',
        targetOwner: 'graphify',
        extensionId: 'graphify',
        used: true,
        affectedProjectIds: ['p1', 'p2'],
      },
      git: {
        domain: 'git',
        priorOwner: 'legacy',
        targetOwner: 'git-workflow',
        extensionId: 'git-workflow',
        used: true,
        affectedProjectIds: ['p1'],
      },
    },
    ...overrides,
  };
}

test('migration welcome selects migrated state and persists one-time completion', () => {
  const state = buildMigrationWelcomeState({
    appVersion: '1.2.3',
    plan: plan(),
    ledger: { status: 'completed' },
    diagnostics: {
      ownership: {
        graphify: { activeOwner: 'graphify' },
        git: { activeOwner: 'git-workflow' },
      },
    },
  });
  assert.equal(state.variant, 'migrated');
  assert.equal(state.show, true);
  assert.equal(state.canRetry, false);
  assert.equal(state.targets.find((item) => item.domain === 'graphify').affectedProjects, 2);

  const meta = new Map();
  const db = {
    getMetaValue(key, fallback = null) { return meta.has(key) ? meta.get(key) : fallback; },
    setMetaValue(key, value) { meta.set(key, String(value)); return String(value); },
  };
  markMigrationWelcomeComplete(db, state.version);
  const hidden = buildMigrationWelcomeState({
    appVersion: '1.2.3',
    plan: plan(),
    ledger: { status: 'completed' },
    completedVersion: db.getMetaValue('updates.bundled_integration_welcome.completed_version'),
  });
  assert.equal(hidden.show, false);
});

test('migration welcome selects no-usage and new-install discovery copy', () => {
  const noUsage = buildMigrationWelcomeState({
    appVersion: '1.2.3',
    plan: plan({
      noOp: true,
      targets: {
        graphify: { domain: 'graphify', targetOwner: 'legacy', extensionId: 'graphify', affectedProjectIds: [] },
        git: { domain: 'git', targetOwner: 'legacy', extensionId: 'git-workflow', affectedProjectIds: [] },
      },
    }),
    ledger: { status: 'completed' },
  });
  assert.equal(noUsage.variant, 'no-usage');
  assert.match(noUsage.body, /No previous integration usage/);

  const fresh = buildMigrationWelcomeState({
    appVersion: '1.2.3',
    plan: plan({ newUser: true, noOp: true, targets: {} }),
  });
  assert.equal(fresh.variant, 'new-install');
  assert.doesNotMatch(fresh.body, /migration/i);
});

test('migration welcome exposes retry only for failure and fallback variants', () => {
  const failed = buildMigrationWelcomeState({
    appVersion: '1.2.3',
    plan: plan(),
    ledger: { status: 'failed', error: 'install failed' },
    diagnostics: { ownership: { graphify: { activeOwner: 'legacy', fallbackReason: 'health failed' } } },
  });
  assert.equal(failed.variant, 'fallback');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.canContinuePrevious, true);
  assert.match(failed.secondaryAction, /Retry/);

  const partial = buildMigrationWelcomeState({
    appVersion: '1.2.3',
    plan: plan(),
    ledger: { status: 'failed', error: 'timeout' },
  });
  assert.equal(partial.variant, 'partial-failure');
  assert.equal(partial.canRetry, true);
});
