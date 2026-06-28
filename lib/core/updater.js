'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { scanExtensions } = require('./extensions');

const DEFAULT_MANIFEST = {
  imageOwned: [
    'server.js',
    'bin/**',
    'lib/**',
    'public/**',
    'scripts/**',
    'tests/**',
    'docs/**',
    'examples/**',
    'package.json',
    'package-lock.json',
    'README.md',
    'AGENTS.md',
    'control-center.manifest.json',
    '.github/**',
  ],
  generated: [
    'graphify-out/**',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/mcp.graph.*.json',
    '.codex/hooks.json',
    'node_modules/**',
    'Control Center.app/**',
  ],
};

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function splitVersion(value) {
  const [main, pre = ''] = normalizeVersion(value).split('-', 2);
  const nums = main.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { nums: nums.slice(0, 3), pre };
}

function compareVersions(a, b) {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] > right.nums[i]) return 1;
    if (left.nums[i] < right.nums[i]) return -1;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return left.pre.localeCompare(right.pre);
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function runGit(root, args, opts = {}) {
  const out = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 30000,
  });
  if (typeof out !== 'string') return '';
  return opts.trim === false ? out : out.trim();
}

function gitTopLevel(root) {
  try {
    return runGit(root, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

function currentGitRef(root) {
  try {
    return runGit(root, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return null;
  }
}

function normalizeRel(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern) {
  const raw = normalizeRel(pattern);
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesPattern(file, pattern) {
  const rel = normalizeRel(file);
  const pat = normalizeRel(pattern);
  if (pat.endsWith('/**')) {
    const base = pat.slice(0, -3);
    return rel === base || rel.startsWith(`${base}/`);
  }
  return globToRegex(pat).test(rel);
}

function matchesAny(file, patterns) {
  return (patterns || []).some((pattern) => matchesPattern(file, pattern));
}

function readManifest(root) {
  const file = path.join(root, 'control-center.manifest.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      imageOwned: parsed.imageOwned || DEFAULT_MANIFEST.imageOwned,
      generated: parsed.generated || DEFAULT_MANIFEST.generated,
    };
  } catch {
    return DEFAULT_MANIFEST;
  }
}

function parsePorcelainZ(output) {
  const entries = String(output || '').split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    if ((status[0] === 'R' || status[0] === 'C') && entries[i + 1]) {
      i += 1;
    }
    file = normalizeRel(file);
    if (file) changes.push({ status, path: file });
  }
  return changes;
}

function imageOwnedChanges(root) {
  if (!gitTopLevel(root)) return { ok: true, git: false, changes: [] };
  const manifest = readManifest(root);
  const raw = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 10000, trim: false });
  const changes = parsePorcelainZ(raw).filter((change) =>
    matchesAny(change.path, manifest.imageOwned) && !matchesAny(change.path, manifest.generated),
  );
  return { ok: changes.length === 0, git: true, changes };
}

function ensureCleanImage(root) {
  const state = imageOwnedChanges(root);
  if (!state.ok) {
    const listed = state.changes.slice(0, 12).map((change) => `${change.status.trim() || '??'} ${change.path}`).join('\n');
    const suffix = state.changes.length > 12 ? `\n...and ${state.changes.length - 12} more` : '';
    const err = new Error(`image-owned files are modified:\n${listed}${suffix}`);
    err.code = 'DIRTY_IMAGE';
    err.changes = state.changes;
    throw err;
  }
  return state;
}

function ensureExtensionConflictsAllowed(opts = {}) {
  if (!opts.extensionsDir) return { extensions: [], conflicts: [] };
  const scanned = scanExtensions(opts.extensionsDir);
  if (scanned.conflicts.length && !opts.allowExtensionConflicts) {
    const listed = scanned.conflicts.slice(0, 12).map((conflict) => {
      const id = conflict.id || conflict.key || conflict.type;
      return `${conflict.type}: ${id}`;
    }).join('\n');
    const suffix = scanned.conflicts.length > 12 ? `\n...and ${scanned.conflicts.length - 12} more` : '';
    const err = new Error(`extension conflicts must be resolved or explicitly allowed:\n${listed}${suffix}`);
    err.code = 'EXTENSION_CONFLICTS';
    err.conflicts = scanned.conflicts;
    throw err;
  }
  return scanned;
}

function safeCopy(src, dest) {
  if (!src || !fs.existsSync(src)) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

function checkpointSqlite(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  let handle = null;
  try {
    handle = new Database(dbPath);
    handle.pragma('wal_checkpoint(FULL)');
    return true;
  } finally {
    if (handle) handle.close();
  }
}

function backupInstance(opts = {}) {
  const appHome = opts.appHome;
  const dbPath = opts.dbPath;
  const backupDir = opts.backupDir || (appHome ? path.join(appHome, 'backups') : path.dirname(dbPath || process.cwd()));
  const label = opts.label || 'update';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(backupDir, `${label}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  const configPath = appHome ? path.join(appHome, 'config.yaml') : null;
  const copiedConfig = safeCopy(configPath, path.join(outDir, 'config.yaml'));
  if (copiedConfig) files.push(copiedConfig);

  if (dbPath && fs.existsSync(dbPath)) {
    checkpointSqlite(dbPath);
    const copiedDb = safeCopy(dbPath, path.join(outDir, path.basename(dbPath)));
    if (copiedDb) files.push(copiedDb);
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      const copied = safeCopy(sidecar, path.join(outDir, path.basename(sidecar)));
      if (copied) files.push(copied);
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    label,
    appHome: appHome || null,
    dbPath: dbPath || null,
    files: files.map((file) => path.basename(file)),
  };
  fs.writeFileSync(path.join(outDir, 'backup.json'), JSON.stringify(manifest, null, 2));
  return { path: outDir, files: manifest.files };
}

function dryRunMigration(opts = {}) {
  const root = opts.root;
  const dbPath = opts.dbPath;
  if (!dbPath || !fs.existsSync(dbPath)) return { ok: true, skipped: true, reason: 'database does not exist' };

  checkpointSqlite(dbPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-migration-'));
  const tmpHome = path.join(tmp, 'home');
  const tmpDb = path.join(tmp, 'tasks.db');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.copyFileSync(dbPath, tmpDb);
  try {
    const result = spawnSync(process.execPath, ['-e', "const db = require('./lib/db'); db.db.close();"], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTROL_CENTER_HOME: tmpHome,
        CC_DB_PATH: tmpDb,
        CC_DB_BACKUP_RETENTION_COUNT: '0',
      },
      timeout: opts.timeoutMs || 20000,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        status: result.status,
        stderr: result.stderr || '',
        stdout: result.stdout || '',
      };
    }
    return { ok: true, dbPath: tmpDb };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function normalizeGithubRepo(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let match = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  match = raw.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\.git)?/i);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  match = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s#?]+)(?:\.git)?$/i);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  return null;
}

function packageRepository(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.repository === 'string') return pkg.repository;
    if (pkg.repository && pkg.repository.url) return pkg.repository.url;
  } catch {
    /* ignore */
  }
  return null;
}

function gitRemote(root) {
  try {
    return runGit(root, ['config', '--get', 'remote.origin.url'], { timeoutMs: 5000 });
  } catch {
    return null;
  }
}

function resolveGithubRepo(opts = {}) {
  return normalizeGithubRepo(opts.repo)
    || normalizeGithubRepo(process.env.CC_UPDATE_REPO)
    || normalizeGithubRepo(packageRepository(opts.root || process.cwd()))
    || normalizeGithubRepo(gitRemote(opts.root || process.cwd()));
}

function requestJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: opts.timeoutMs || 8000,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'control-center-updater',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`GitHub returned HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = body;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('GitHub request timed out'));
    });
    req.on('error', reject);
  });
}

async function fetchLatestRelease(opts = {}) {
  const repo = resolveGithubRepo(opts);
  if (!repo) {
    const err = new Error('No GitHub repository configured. Set CC_UPDATE_REPO=owner/repo.');
    err.code = 'NO_UPDATE_REPO';
    throw err;
  }
  const apiBase = String(opts.apiBase || process.env.CC_UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
  const release = await requestJson(`${apiBase}/repos/${repo}/releases/latest`, opts);
  return {
    repo,
    tag: release.tag_name || '',
    version: release.tag_name || release.name || '',
    name: release.name || release.tag_name || '',
    url: release.html_url || '',
    publishedAt: release.published_at || null,
    notes: release.body || '',
  };
}

function updateMetaEntriesForRelease(release, currentVersion) {
  const checkedAt = new Date().toISOString();
  const available = release.version ? isNewerVersion(release.version, currentVersion) : false;
  return {
    'updates.last_check_at': checkedAt,
    'updates.latest_release_version': release.version || '',
    'updates.latest_release_url': release.url || '',
    'updates.latest_release_notes': release.notes || '',
    'updates.latest_release_published_at': release.publishedAt || '',
    'updates.latest_release_available': available ? '1' : '0',
    'updates.latest_release_error': '',
  };
}

function writeMetaValues(dbPath, entries) {
  if (!dbPath) return;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const handle = new Database(dbPath);
  try {
    handle.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const stmt = handle.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = handle.transaction((items) => {
      for (const [key, value] of Object.entries(items)) stmt.run(key, String(value == null ? '' : value));
    });
    tx(entries);
  } finally {
    handle.close();
  }
}

function readMetaValue(dbPath, key) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const handle = new Database(dbPath, { readonly: true });
  try {
    const row = handle.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key);
    return row ? row.value : null;
  } catch {
    return null;
  } finally {
    handle.close();
  }
}

async function checkForUpdates(opts = {}) {
  const currentVersion = opts.currentVersion || '0.0.0';
  try {
    const release = await fetchLatestRelease(opts);
    const meta = updateMetaEntriesForRelease(release, currentVersion);
    if (opts.dbPath) writeMetaValues(opts.dbPath, meta);
    return {
      ok: true,
      release,
      updateAvailable: meta['updates.latest_release_available'] === '1',
      checkedAt: meta['updates.last_check_at'],
    };
  } catch (e) {
    const checkedAt = new Date().toISOString();
    const meta = {
      'updates.last_check_at': checkedAt,
      'updates.latest_release_error': e && e.message ? e.message : String(e),
    };
    if (opts.dbPath) writeMetaValues(opts.dbPath, meta);
    return {
      ok: false,
      error: meta['updates.latest_release_error'],
      checkedAt,
    };
  }
}

function npmInstall(root) {
  const result = spawnSync('npm', ['install'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status}`);
  }
}

function updateGitCheckout(opts = {}) {
  const root = opts.root;
  const dbPath = opts.dbPath;
  const target = opts.target || readMetaValue(dbPath, 'updates.latest_release_version');
  if (!target) throw new Error('No update target. Run check-updates or pass --target <git-ref>.');
  if (!gitTopLevel(root)) throw new Error('Update requires a Git checkout install.');

  ensureCleanImage(root);
  const extensions = ensureExtensionConflictsAllowed(opts);
  const before = currentGitRef(root);
  if (!before) throw new Error('Could not resolve current Git commit.');

  const backup = backupInstance({
    appHome: opts.appHome,
    dbPath,
    backupDir: opts.backupDir,
    label: 'pre-update',
  });
  const migration = dryRunMigration({ root, dbPath });
  if (!migration.ok) {
    const err = new Error(`Migration dry-run failed: ${migration.stderr || migration.stdout || migration.status}`);
    err.migration = migration;
    throw err;
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, target, before, backup, migration, extensionConflicts: extensions.conflicts };
  }

  try {
    runGit(root, ['fetch', '--tags', '--prune'], { stdio: 'inherit', timeoutMs: 120000 });
    runGit(root, ['checkout', target], { stdio: 'inherit', timeoutMs: 120000 });
    npmInstall(root);
    writeMetaValues(dbPath, {
      'updates.rollback_ref': before,
      'updates.current_ref': currentGitRef(root) || target,
      'updates.last_update_at': new Date().toISOString(),
      'updates.last_update_error': '',
    });
    return { ok: true, target, before, backup, migration };
  } catch (e) {
    try {
      runGit(root, ['checkout', before], { stdio: 'inherit', timeoutMs: 120000 });
      npmInstall(root);
    } catch (rollbackError) {
      e.rollbackError = rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError);
    }
    writeMetaValues(dbPath, {
      'updates.last_update_error': e && e.message ? e.message : String(e),
      'updates.rollback_ref': before,
    });
    throw e;
  }
}

function rollbackGitCheckout(opts = {}) {
  const root = opts.root;
  const dbPath = opts.dbPath;
  const target = opts.target || readMetaValue(dbPath, 'updates.rollback_ref');
  if (!target) throw new Error('No rollback target. Pass --target <git-ref> or update once first.');
  if (!gitTopLevel(root)) throw new Error('Rollback requires a Git checkout install.');

  ensureCleanImage(root);
  const extensions = ensureExtensionConflictsAllowed(opts);
  const before = currentGitRef(root);
  const backup = backupInstance({
    appHome: opts.appHome,
    dbPath,
    backupDir: opts.backupDir,
    label: 'pre-rollback',
  });
  if (opts.dryRun) return { ok: true, dryRun: true, target, before, backup, extensionConflicts: extensions.conflicts };

  runGit(root, ['checkout', target], { stdio: 'inherit', timeoutMs: 120000 });
  npmInstall(root);
  writeMetaValues(dbPath, {
    'updates.rollback_ref': before || '',
    'updates.current_ref': currentGitRef(root) || target,
    'updates.last_rollback_at': new Date().toISOString(),
    'updates.last_update_error': '',
  });
  return { ok: true, target, before, backup };
}

module.exports = {
  compareVersions,
  isNewerVersion,
  normalizeGithubRepo,
  resolveGithubRepo,
  fetchLatestRelease,
  checkForUpdates,
  imageOwnedChanges,
  ensureCleanImage,
  ensureExtensionConflictsAllowed,
  backupInstance,
  dryRunMigration,
  writeMetaValues,
  readMetaValue,
  updateGitCheckout,
  rollbackGitCheckout,
};
