'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { ExtensionPlatform } = require('../lib/core/extensionPlatform');

function memoryDb() {
  const meta = new Map();
  return {
    meta,
    getMetaValue(key, fallback = null) {
      return meta.has(key) ? meta.get(key) : fallback;
    },
    setMetaValue(key, value) {
      meta.set(key, String(value));
      return String(value);
    },
  };
}

function writeBundle(root, id, version, options = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const ownership = options.ownership || [];
  const permissions = [
    'health:checks',
    ...ownership.map((domain) => `ownership:${domain}`),
    ...(options.permissions || []),
  ];
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({
    apiVersion: 1,
    id,
    name: options.name || id,
    version,
    permissions,
    ownership,
    server: ownership.length ? 'server.js' : false,
  }, null, 2));
  if (ownership.length) {
    fs.writeFileSync(path.join(dir, 'server.js'), `
'use strict';
exports.register = ({ capabilities }) => {
  capabilities.health.register('ready', () => ({ ok: true }));
};
`);
  }
  fs.writeFileSync(path.join(dir, 'payload.txt'), options.payload || version);
  return dir;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-extension-platform-'));
  const bundledDir = path.join(root, 'bundled');
  const extensionsDir = path.join(root, 'home', 'extensions');
  fs.mkdirSync(bundledDir, { recursive: true });
  return { root, bundledDir, extensionsDir, db: memoryDb() };
}

test('bundled extensions install offline and stay disabled until explicitly enabled', () => {
  const fx = fixture();
  try {
    writeBundle(fx.bundledDir, 'graphify-next', '1.0.0', {
      ownership: ['graphify'],
      permissions: ['process:managed', 'providers:setup'],
    });
    const platform = new ExtensionPlatform(fx);
    const catalog = platform.prepare();
    assert.equal(catalog.find((item) => item.id === 'graphify-next').installed, false);

    const installed = platform.installBundled('graphify-next');
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, false);
    assert.equal(fs.readFileSync(path.join(fx.extensionsDir, 'graphify-next', 'payload.txt'), 'utf8'), '1.0.0');

    const enabled = platform.enable('graphify-next');
    assert.equal(enabled.enabled, true);
    assert.equal(platform.owner('graphify'), 'legacy');
    assert.deepEqual(platform.diagnostics().permissions['graphify-next'].managed.sort(), [
      'health:checks',
      'ownership:graphify',
      'process:managed',
      'providers:setup',
    ].sort());
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('ownership is persisted, single-writer, and falls back automatically', () => {
  const fx = fixture();
  try {
    writeBundle(fx.bundledDir, 'graphify-next', '1.0.0', { ownership: ['graphify'] });
    const first = new ExtensionPlatform(fx);
    first.prepare();
    first.installBundled('graphify-next', { enable: true });
    assert.equal(first.switchOwnership('graphify', 'graphify-next').activeOwner, 'graphify-next');
    assert.equal(first.isOwner('graphify', 'legacy'), false);

    const restarted = new ExtensionPlatform(fx);
    restarted.prepare();
    assert.equal(restarted.owner('graphify'), 'graphify-next');

    restarted.reportOwnershipFailure('graphify', 'graphify-next', new Error('health check failed'));
    assert.equal(restarted.owner('graphify'), 'legacy');
    assert.equal(restarted.diagnostics().ownership.graphify.preferredOwner, 'graphify-next');

    const afterFailureRestart = new ExtensionPlatform(fx);
    afterFailureRestart.prepare();
    assert.equal(afterFailureRestart.owner('graphify'), 'legacy');
    afterFailureRestart.reportOwnershipHealthy('graphify', 'graphify-next');
    assert.equal(afterFailureRestart.owner('graphify'), 'graphify-next');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('duplicate enabled ownership is rejected before either extension can become writer', () => {
  const fx = fixture();
  try {
    writeBundle(fx.bundledDir, 'git-first', '1.0.0', { ownership: ['git'] });
    writeBundle(fx.bundledDir, 'git-second', '1.0.0', { ownership: ['git'] });
    const platform = new ExtensionPlatform(fx);
    platform.prepare();
    platform.installBundled('git-first', { enable: true });
    platform.installBundled('git-second');

    assert.throws(() => platform.enable('git-second'), /duplicate enabled ownership for git/);
    assert.equal(platform.extensionStatus('git-first').enabled, true);
    assert.equal(platform.extensionStatus('git-second').enabled, false);
    assert.equal(platform.owner('git'), 'legacy');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('bundled upgrade keeps a local rollback and restores the prior version', () => {
  const fx = fixture();
  try {
    writeBundle(fx.bundledDir, 'graphify-next', '1.0.0', { ownership: ['graphify'], payload: 'old' });
    const platform = new ExtensionPlatform(fx);
    platform.prepare();
    platform.installBundled('graphify-next', { enable: true });

    fs.rmSync(path.join(fx.bundledDir, 'graphify-next'), { recursive: true, force: true });
    writeBundle(fx.bundledDir, 'graphify-next', '1.1.0', { ownership: ['graphify'], payload: 'new' });
    const upgraded = platform.upgradeBundled('graphify-next');
    assert.equal(upgraded.installedVersion, '1.1.0');
    assert.equal(upgraded.rollbackAvailable, true);
    assert.equal(fs.readFileSync(path.join(fx.extensionsDir, 'graphify-next', 'payload.txt'), 'utf8'), 'new');

    const rolledBack = platform.rollbackBundled('graphify-next');
    assert.equal(rolledBack.installedVersion, '1.0.0');
    assert.equal(rolledBack.migrationsRetained, true);
    assert.equal(fs.readFileSync(path.join(fx.extensionsDir, 'graphify-next', 'payload.txt'), 'utf8'), 'old');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('managed side-effect capabilities reject an extension while legacy owns the domain', async () => {
  const fx = fixture();
  try {
    writeBundle(fx.bundledDir, 'git-next', '1.0.0', {
      ownership: ['git'],
      permissions: ['git:read', 'git:write'],
    });
    const platform = new ExtensionPlatform(fx);
    platform.prepare();
    platform.installBundled('git-next', { enable: true });
    const extension = platform.extensionById('git-next');
    const capabilities = platform.capabilitiesFor(extension);
    await assert.rejects(
      capabilities.git.init(fx.root, { ownership: 'git' }),
      /is not the active owner of git/,
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('managed migrations require permission, run transactionally, and persist applied IDs', () => {
  const fx = fixture();
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  fx.db = {
    db: sqlite,
    getMetaValue(key, fallback = null) {
      const row = sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },
    setMetaValue(key, value) {
      sqlite.prepare(`
        INSERT INTO app_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
      return String(value);
    },
  };
  try {
    const dir = writeBundle(fx.bundledDir, 'data-owner', '1.0.0', { permissions: ['migrations:run'] });
    const manifestPath = path.join(dir, 'extension.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.migrations = [{ id: '001-create-records', path: 'migrations/001.sql' }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrations', '001.sql'), 'CREATE TABLE extension_records (id TEXT PRIMARY KEY);');

    const platform = new ExtensionPlatform(fx);
    platform.prepare();
    platform.installBundled('data-owner', { enable: true });
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'extension_records'").get());
    assert.ok(platform.stateFor('data-owner').migrations['001-create-records'].appliedAt);
    assert.deepEqual(platform.runMigrations(platform.extensionById('data-owner')), []);
  } finally {
    sqlite.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('enabling a newly discovered external extension preserves migration state and records provenance', () => {
  const fx = fixture();
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  fx.db = {
    db: sqlite,
    getMetaValue(key, fallback = null) {
      const row = sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },
    setMetaValue(key, value) {
      sqlite.prepare(`
        INSERT INTO app_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
      return String(value);
    },
  };
  try {
    const platform = new ExtensionPlatform(fx);
    platform.prepare();
    const dir = writeBundle(fx.extensionsDir, 'external-data', '2.3.4', { permissions: ['migrations:run'] });
    const manifestPath = path.join(dir, 'extension.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.migrations = [{ id: 'external-data-001', path: 'migrations/001.sql' }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrations', '001.sql'), 'CREATE TABLE external_records (id TEXT PRIMARY KEY);');

    const enabled = platform.enable('external-data');
    const state = platform.stateFor('external-data');
    assert.equal(enabled.enabled, true);
    assert.equal(state.origin, 'external');
    assert.equal(state.installedVersion, '2.3.4');
    assert.ok(state.installedAt);
    assert.ok(state.migrations['external-data-001'].appliedAt);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'external_records'").get());
  } finally {
    sqlite.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

for (const available of ['claude', 'codex']) {
  test(`Graphify provider setup works with only ${available} installed`, async (t) => {
    const fx = fixture();
    const { getProvider } = require('../lib/providers');
    const calls = [];
    for (const id of ['codex', 'claude']) {
      const provider = getProvider(id);
      t.mock.method(provider, 'detect', () => ({ id, installed: id === available, connected: true }));
      t.mock.method(provider, 'setupExtension', async () => { calls.push(id); return { ok: true }; });
    }
    try {
      writeBundle(fx.bundledDir, 'graphify', '1.0.0', { ownership: ['graphify'], permissions: ['providers:setup'] });
      const platform = new ExtensionPlatform(fx);
      platform.prepare();
      platform.installBundled('graphify', { enable: true });
      platform.switchOwnership('graphify', 'graphify');
      const api = platform.capabilitiesFor(platform.extensionById('graphify'));
      for (const id of ['codex', 'claude']) {
        const result = await api.providers.setup(id, { path: fx.root }, { integration: 'graphify', ownership: 'graphify' });
        assert.equal(result.ok, true);
        if (id !== available) assert.equal(result.skipped, true);
      }
      assert.deepEqual(calls, [available]);
      assert.equal(fs.existsSync(path.join(fx.root, '.codex')), false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
}
