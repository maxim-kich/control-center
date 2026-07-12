'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const updater = require('../lib/core/updater');

const ROOT = path.resolve(__dirname, '..');
const ORIGINAL_GRAPHIFY_BIN = process.env.CC_GRAPHIFY_BIN;

// Migration readiness only requires a successful `--version` probe. Keep the
// tests independent of whether Graphify happens to be installed on the host.
process.env.CC_GRAPHIFY_BIN = process.execPath;
test.after(() => {
  if (ORIGINAL_GRAPHIFY_BIN === undefined) delete process.env.CC_GRAPHIFY_BIN;
  else process.env.CC_GRAPHIFY_BIN = ORIGINAL_GRAPHIFY_BIN;
});

function hasGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeRepo(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-git-'));
  fs.writeFileSync(path.join(tmp, 'server.js'), "console.log('server');\n");
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2));
  fs.writeFileSync(path.join(tmp, 'control-center.manifest.json'), JSON.stringify({
    imageOwned: ['server.js', 'docs/**', 'package.json', 'control-center.manifest.json'],
    generated: ['data/**'],
  }, null, 2));
  git(tmp, ['init']);
  git(tmp, ['add', '.']);
  git(tmp, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial']);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

test('updater compares semantic versions', () => {
  assert.equal(updater.compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(updater.compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  assert.equal(updater.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(updater.isNewerVersion('v1.0.1', '1.0.0'), true);
});

test('imageOwnedChanges reports source changes and ignores generated files', { skip: !hasGit() }, (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server.js'), "console.log('changed');\n");
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'publishing.md'), '# docs\n');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data', 'tasks.db'), 'private');

  const result = updater.imageOwnedChanges(repo);
  assert.equal(result.ok, false);
  const paths = result.changes.map((change) => change.path).sort();
  assert.deepEqual(paths, ['docs/publishing.md', 'server.js']);
});

test('overwriteImageOwnedChanges replaces image-owned files and preserves generated and unknown files', { skip: !hasGit() }, (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server.js'), "console.log('changed');\n");
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'local.md'), '# local image file\n');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data', 'tasks.db'), 'private');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'unknown user file');

  const result = updater.overwriteImageOwnedChanges(repo);

  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(repo, 'server.js'), 'utf8'), "console.log('server');\n");
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'local.md')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'data', 'tasks.db'), 'utf8'), 'private');
  assert.equal(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'unknown user file');
  assert.equal(updater.imageOwnedChanges(repo).ok, true);
});

test('overwriteImageOwnedChanges dry run reports changes without modifying files', { skip: !hasGit() }, (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server.js'), "console.log('changed');\n");

  const result = updater.overwriteImageOwnedChanges(repo, { dryRun: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.changes.map((change) => change.path), ['server.js']);
  assert.equal(fs.readFileSync(path.join(repo, 'server.js'), 'utf8'), "console.log('changed');\n");
});

test('backupInstance copies config and checkpointed database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-backup-'));
  const home = path.join(tmp, 'home');
  const data = path.join(home, 'data');
  const backups = path.join(home, 'backups');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'update_channel: stable\n');
  const dbPath = path.join(data, 'tasks.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE sample (id TEXT PRIMARY KEY); INSERT INTO sample (id) VALUES (\'one\');');
  db.close();

  try {
    const backup = updater.backupInstance({ appHome: home, dbPath, backupDir: backups, label: 'test' });
    assert.equal(fs.existsSync(path.join(backup.path, 'config.yaml')), true);
    assert.equal(fs.existsSync(path.join(backup.path, 'tasks.db')), true);
    assert.equal(fs.existsSync(path.join(backup.path, 'backup.json')), true);
    const copied = new Database(path.join(backup.path, 'tasks.db'), { readonly: true });
    try {
      assert.equal(copied.prepare('SELECT id FROM sample').get().id, 'one');
    } finally {
      copied.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dryRunMigration migrates a copy without modifying the source database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-dryrun-'));
  const dbPath = path.join(tmp, 'legacy.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      session_id TEXT,
      parent_task_id TEXT,
      parent_session_id TEXT,
      col_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    INSERT INTO tasks (id, title, project_path, created_at, updated_at)
    VALUES ('t1', 'legacy', '/tmp/project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  try {
    const result = updater.dryRunMigration({ root: ROOT, dbPath });
    assert.equal(result.ok, true, result.stderr || result.stdout);

    const original = new Database(dbPath, { readonly: true });
    try {
      const row = original.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'`).get();
      assert.equal(row, undefined);
    } finally {
      original.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updater blocks extension conflicts unless explicitly allowed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-updater-ext-'));
  const writeExt = (folder, manifest) => {
    const dir = path.join(tmp, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.yaml'), manifest);
  };
  writeExt('one', `
id: alpha
settingsPanels:
  - id: status
    title: Status
    path: status.html
`);
  writeExt('two', `
id: alpha
settingsPanels:
  - id: status
    title: Status
    path: status.html
`);

  try {
    assert.throws(
      () => updater.ensureExtensionConflictsAllowed({ extensionsDir: tmp }),
      /extension conflicts/,
    );
    const allowed = updater.ensureExtensionConflictsAllowed({ extensionsDir: tmp, allowExtensionConflicts: true });
    assert.ok(allowed.conflicts.length >= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function makeBundledMigrationDb(tmp) {
  const dbPath = path.join(tmp, 'tasks.db');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'graphify-out'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(project, 'graphify-out', 'graph.json'), '{"nodes":[]}\n');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      graphify_enabled INTEGER NOT NULL DEFAULT 1,
      graphify_status TEXT NOT NULL DEFAULT 'current',
      graphify_last_success_at TEXT,
      graphify_last_error TEXT,
      graphify_hook_status TEXT,
      graphify_dirty_at TEXT
    );
    INSERT INTO projects (
      id, name, path, archived, graphify_enabled, graphify_status,
      graphify_last_success_at, graphify_hook_status
    )
    VALUES (
      'project-1', 'Project', '${project.replace(/'/g, "''")}', 0, 1, 'current',
      '2026-01-01T00:00:00.000Z', 'installed'
    );
  `);
  db.close();
  return { dbPath, project };
}

test('bundled integration migration dry-run plans without mutating the source database', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-bundled-migration-dry-'));
  const { dbPath } = makeBundledMigrationDb(tmp);
  const extensionsDir = path.join(tmp, 'extensions');

  try {
    const result = await updater.runBundledIntegrationMigration({
      root: ROOT,
      appHome: tmp,
      dbPath,
      extensionsDir,
      dryRun: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan.targets.graphify.targetOwner, 'graphify');
    assert.equal(result.plan.targets.git.targetOwner, 'git-workflow');
    assert.equal(fs.existsSync(extensionsDir), false);

    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'app_meta'`).get(), undefined);
      assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'extension_state'`).get(), undefined);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled integration migration installs bundles imports state and is idempotent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-bundled-migration-'));
  const { dbPath } = makeBundledMigrationDb(tmp);
  const extensionsDir = path.join(tmp, 'extensions');

  try {
    const result = await updater.runBundledIntegrationMigration({
      root: ROOT,
      appHome: tmp,
      dbPath,
      extensionsDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.ownership.graphify.activeOwner, 'graphify');
    assert.equal(result.diagnostics.ownership.git.activeOwner, 'git-workflow');
    assert.equal(fs.existsSync(path.join(extensionsDir, 'graphify', 'extension.json')), true);
    assert.equal(fs.existsSync(path.join(extensionsDir, 'git-workflow', 'extension.json')), true);

    const db = new Database(dbPath);
    try {
      const ownership = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key = 'extensions.platform.ownership.v1'`).get().value);
      assert.equal(ownership.domains.graphify.activeOwner, 'graphify');
      assert.equal(ownership.domains.git.activeOwner, 'git-workflow');
      const graphifyState = db.prepare(`
        SELECT value FROM extension_state
        WHERE extension_id = 'graphify' AND scope_type = 'project' AND scope_id = 'project-1' AND key = 'compatibility'
      `).get();
      assert.equal(JSON.parse(graphifyState.value).graphify_status, 'current');
      const gitState = db.prepare(`
        SELECT value FROM extension_state
        WHERE extension_id = 'git-workflow' AND scope_type = 'project' AND scope_id = 'project-1' AND key = 'git'
      `).get();
      assert.equal(JSON.parse(gitState.value).git_repo_kind, 'own');
    } finally {
      db.close();
    }

    const rerun = await updater.runBundledIntegrationMigration({
      root: ROOT,
      appHome: tmp,
      dbPath,
      extensionsDir,
    });
    assert.equal(rerun.alreadyCompleted, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled integration migration resumes an interrupted ledger and survives restart', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-bundled-migration-resume-'));
  const { dbPath } = makeBundledMigrationDb(tmp);
  const extensionsDir = path.join(tmp, 'extensions');
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  seed.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)`).run(
    'updates.bundled_integration_migration.ledger.v1',
    JSON.stringify({ version: 1, status: 'in_progress', steps: [{ step: 'plan-persisted' }] }),
  );
  seed.close();

  try {
    const result = await updater.runBundledIntegrationMigration({
      root: ROOT,
      appHome: tmp,
      dbPath,
      extensionsDir,
    });
    assert.equal(result.ok, true);

    const { ExtensionPlatform } = require('../lib/core/extensionPlatform');
    const db = new Database(dbPath);
    const adapter = {
      db,
      getMetaValue(key, fallback = null) {
        const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key);
        return row ? row.value : fallback;
      },
      setMetaValue(key, value) {
        db.prepare(`
          INSERT INTO app_meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, String(value));
        return String(value);
      },
    };
    try {
      const platform = new ExtensionPlatform({
        db: adapter,
        bundledDir: path.join(ROOT, 'bundled-extensions'),
        extensionsDir,
      });
      platform.prepare();
      assert.equal(platform.owner('graphify'), 'graphify');
      assert.equal(platform.owner('git'), 'git-workflow');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled integration migration records failure ledger and falls back to legacy ownership', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-bundled-migration-fail-'));
  const { dbPath } = makeBundledMigrationDb(tmp);

  try {
    await assert.rejects(
      updater.runBundledIntegrationMigration({
        root: ROOT,
        appHome: tmp,
        dbPath,
        extensionsDir: path.join(tmp, 'extensions'),
        bundledDir: path.join(tmp, 'missing-bundles'),
      }),
      /bundled extension not found/,
    );
    const db = new Database(dbPath, { readonly: true });
    try {
      const ledger = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get('updates.bundled_integration_migration.ledger.v1').value);
      assert.equal(ledger.status, 'failed');
      const ownership = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get('extensions.platform.ownership.v1').value);
      assert.equal(ownership.domains.graphify.activeOwner, 'legacy');
      assert.equal(ownership.domains.git.activeOwner, 'legacy');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completed migration is a no-op unless repair restores missing disabled outdated corrupt and unhealthy bundles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-bundled-repair-'));
  const { dbPath } = makeBundledMigrationDb(tmp);
  const extensionsDir = path.join(tmp, 'extensions');
  const options = { root: ROOT, appHome: tmp, dbPath, extensionsDir };
  try {
    const first = await updater.runBundledIntegrationMigration(options);
    assert.equal(first.ok, true);
    const noOp = await updater.runBundledIntegrationMigration(options);
    assert.equal(noOp.alreadyCompleted, true);

    fs.rmSync(path.join(extensionsDir, 'graphify'), { recursive: true, force: true });
    let repaired = await updater.runBundledIntegrationMigration({ ...options, repair: true });
    assert.equal(repaired.diagnostics.ownership.graphify.activeOwner, 'graphify');
    assert.equal(fs.existsSync(path.join(extensionsDir, 'graphify', 'extension.json')), true);

    const db = new Database(dbPath);
    const registryKey = 'extensions.platform.registry.v1';
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(registryKey);
    const registry = JSON.parse(row.value);
    registry.extensions.graphify.enabled = false;
    registry.extensions.graphify.unhealthyOwnership = { graphify: 'seeded readiness failure' };
    db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run(JSON.stringify(registry), registryKey);
    db.close();
    const manifestPath = path.join(extensionsDir, 'git-workflow', 'extension.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '0.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(extensionsDir, 'graphify', 'extension.json'), '{corrupt');

    repaired = await updater.runBundledIntegrationMigration({ ...options, repair: true });
    assert.equal(repaired.diagnostics.ownership.graphify.activeOwner, 'graphify');
    assert.equal(repaired.diagnostics.ownership.git.activeOwner, 'git-workflow');
    assert.equal(repaired.diagnostics.catalog.find((item) => item.id === 'graphify').enabled, true);
    assert.equal(repaired.diagnostics.catalog.find((item) => item.id === 'git-workflow').installedVersion, '0.1.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('startup provenance preserves genuine first-install classification after schema creation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-first-install-'));
  const dbPath = path.join(tmp, 'tasks.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)');
  db.close();
  try {
    const fresh = updater.createBundledIntegrationMigrationPlan({ dbPath, installationProvenance: { dbExisted: false } });
    const existing = updater.createBundledIntegrationMigrationPlan({ dbPath, installationProvenance: { dbExisted: true } });
    assert.equal(fresh.newUser, true);
    assert.equal(existing.newUser, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
