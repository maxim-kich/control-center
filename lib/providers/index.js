'use strict';

const codex = require('./codex/adapter');
const claude = require('./claude/adapter');

const adapters = new Map([
  [codex.id, codex],
  [claude.id, claude],
]);

function normalizeProviderId(id) {
  return adapters.has(id) ? id : 'codex';
}

function getProvider(id) {
  return adapters.get(normalizeProviderId(id));
}

function listProviders() {
  return [...adapters.values()];
}

function providerStatus(installed, connected) {
  if (!installed) return 'missing';
  return connected ? 'connected' : 'needs_auth';
}

function withUsageState(provider, activeProvider) {
  const active = provider.id === activeProvider;
  const canActivate = provider.launchSupported && provider.installed && provider.connected && !active;
  let disabledReason = '';
  if (active) disabledReason = '';
  else if (!provider.installed) disabledReason = 'CLI not found';
  else if (!provider.connected) disabledReason = 'Authentication required';
  else if (!provider.launchSupported) disabledReason = 'Task launch support is not wired yet';
  return {
    status: provider.status || providerStatus(provider.installed, provider.connected),
    ...provider,
    active,
    canActivate,
    usageDisabled: !active,
    disabledReason,
  };
}

function discoverProviders(opts = {}) {
  const activeProvider = normalizeProviderId(opts.activeProvider);
  return {
    activeProvider,
    providers: listProviders().map((adapter) => withUsageState(adapter.detect(opts), activeProvider)),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  discoverProviders,
  getProvider,
  listProviders,
  normalizeProviderId,
};
