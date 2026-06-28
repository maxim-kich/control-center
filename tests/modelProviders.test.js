'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { discoverModelProviders, normalizeActiveProvider } = require('../lib/modelProviders');

const codexModule = {
  CODEX_BIN: '/bin/codex',
  codexVersion: () => 'codex-cli 1.2.3',
  codexAuthConfigured: () => true,
  which: (bin) => `/bin/${bin}`,
};

test('model provider discovery separates connection state from usage state', () => {
  const result = discoverModelProviders({
    activeProvider: 'codex',
    codexModule,
    runCommand(file, args) {
      if (file === '/bin/claude' && args.join(' ') === '--version') {
        return { ok: true, stdout: '2.1.143 (Claude Code)\n' };
      }
      if (file === '/bin/claude' && args.join(' ') === 'auth status') {
        return { ok: true, stdout: '{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}\n' };
      }
      return { ok: false, stderr: 'unexpected command' };
    },
  });

  const codex = result.providers.find((p) => p.id === 'codex');
  const claude = result.providers.find((p) => p.id === 'claude');

  assert.equal(result.activeProvider, 'codex');
  assert.equal(codex.connected, true);
  assert.equal(codex.active, true);
  assert.equal(codex.usageDisabled, false);
  assert.equal(claude.connected, true);
  assert.equal(claude.active, false);
  assert.equal(claude.usageDisabled, true);
  assert.equal(claude.canActivate, true);
  assert.equal(claude.disabledReason, '');
  assert.equal(claude.launchSupported, true);
  assert.deepEqual(claude.modes, ['build', 'auto', 'plan']);
  assert.equal(claude.setup.command, 'claude auth login');
});

test('model provider discovery marks missing Claude CLI without failing Codex', () => {
  const result = discoverModelProviders({
    activeProvider: 'codex',
    codexModule,
    runCommand() {
      return { ok: false, stderr: 'not found' };
    },
  });
  const claude = result.providers.find((p) => p.id === 'claude');
  assert.equal(claude.installed, false);
  assert.equal(claude.status, 'missing');
  assert.equal(claude.disabledReason, 'CLI not found');
  assert.equal(claude.setup.command, 'npm install -g @anthropic-ai/claude-code');
});

test('active model provider defaults to Codex for unknown values', () => {
  assert.equal(normalizeActiveProvider('claude'), 'claude');
  assert.equal(normalizeActiveProvider('unknown'), 'codex');
  assert.equal(normalizeActiveProvider(''), 'codex');
});
