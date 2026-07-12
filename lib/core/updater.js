'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { scanExtensions } = require('./extensions');

const BUNDLED_INTEGRATION_MIGRATION_VERSION = 1;
const BUNDLED_INTEGRATION_PLAN_KEY = 'updates.bundled_integration_migration.plan.v1';
const BUNDLED_INTEGRATION_LEDGER_KEY = 'updates.bundled_integration_migration.ledger.v1';
const UPDATE_STARTUP_CONTEXT_KEY = 'updates.startup_context.v1';
const BUNDLED_INTEGRATIONS = [
  { domain: 'graphify', extensionId: 'graphify' },
  { domain: 'git', extensionId: 'git-workflow' },
];

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

function dbTableExists(handle, table) {
  try {
    return !!handle.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  } catch {
    return false;
  }
}

function dbColumns(handle, table) {
  try {
    return new Set(handle.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function readJsonValue(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function readMetaJson(handle, key, fallback) {
  if (!dbTableExists(handle, 'app_meta')) return fallback;
  try {
    const row = handle.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key);
    return readJsonValue(row && row.value, fallback);
  } catch {
    return fallback;
  }
}

function ensureMigrationTables(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS extension_state (
      extension_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (extension_id, scope_type, scope_id, key)
    );
  `);
}

function writeMetaJson(handle, key, value) {
  ensureMigrationTables(handle);
  handle.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

function migrationDbAdapter(handle) {
  return {
    db: handle,
    getMetaValue(key, fallback = null) {
      if (!dbTableExists(handle, 'app_meta')) return fallback;
      const row = handle.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key);
      return row ? row.value : fallback;
    },
    setMetaValue(key, value) {
      ensureMigrationTables(handle);
      handle.prepare(`
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
      return String(value);
    },
  };
}

function listMigrationProjects(handle) {
  if (!dbTableExists(handle, 'projects')) return [];
  const cols = dbColumns(handle, 'projects');
  const wanted = [
    'id',
    'name',
    'path',
    'archived',
    'graphify_enabled',
    'graphify_status',
    'graphify_last_success_at',
    'graphify_last_error',
    'graphify_hook_status',
    'graphify_dirty_at',
  ].filter((col) => cols.has(col));
  if (!wanted.includes('id') || !wanted.includes('path')) return [];
  return handle.prepare(`SELECT ${wanted.join(', ')} FROM projects ORDER BY id`).all();
}

function graphifyArtifacts(projectPath) {
  const graphOut = path.join(projectPath, 'graphify-out');
  const codexSkill = path.join(projectPath, '.codex', 'skills', 'graphify', 'SKILL.md');
  return {
    graphOut,
    graphJson: path.join(graphOut, 'graph.json'),
    graphJsonExists: fs.existsSync(path.join(graphOut, 'graph.json')),
    needsUpdate: fs.existsSync(path.join(graphOut, 'needs_update')) || fs.existsSync(path.join(graphOut, '.needs_update')),
    lockExists: fs.existsSync(path.join(graphOut, '.rebuild.lock')),
    codexInstall: fs.existsSync(codexSkill),
    codexHooks: fs.existsSync(path.join(projectPath, '.codex', 'hooks.json')),
  };
}

function inspectBundledIntegrationUsage(opts = {}) {
  const dbPath = opts.dbPath;
  const ownershipDefault = {
    version: 1,
    domains: Object.fromEntries(BUNDLED_INTEGRATIONS.map((item) => [
      item.domain,
      {
        domain: item.domain,
        preferredOwner: 'legacy',
        activeOwner: 'legacy',
      },
    ])),
  };
  if (!dbPath || !fs.existsSync(dbPath)) {
    return {
      ok: true,
      newUser: true,
      dbPath: dbPath || null,
      projects: [],
      ownership: ownershipDefault.domains,
      graphify: { used: false, projects: [] },
      git: { used: false, projects: [] },
    };
  }

  const handle = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const ownership = readMetaJson(handle, 'extensions.platform.ownership.v1', ownershipDefault).domains || ownershipDefault.domains;
    const projects = listMigrationProjects(handle);
    const { projectGitApiFields } = require('../gitRoots');
    const graphifyProjects = [];
    const gitProjects = [];
    for (const project of projects) {
      const artifacts = graphifyArtifacts(project.path);
      const graphifyEnabled = project.graphify_enabled == null ? false : project.graphify_enabled !== 0;
      const graphifyStatus = project.graphify_status || null;
      const graphifyUsed = graphifyEnabled
        || !!project.graphify_last_success_at
        || !!project.graphify_hook_status
        || artifacts.graphJsonExists
        || artifacts.codexInstall
        || artifacts.codexHooks;
      if (graphifyUsed) graphifyProjects.push({ ...project, artifacts });

      const git = projectGitApiFields(project.path);
      if (git.git_repo_kind === 'own' || git.git_repo_kind === 'parent') {
        gitProjects.push({ ...project, git });
      }
    }
    return {
      ok: true,
      newUser: false,
      dbPath,
      projects,
      ownership,
      graphify: {
        used: graphifyProjects.length > 0,
        projects: graphifyProjects,
      },
      git: {
        used: gitProjects.length > 0,
        projects: gitProjects,
      },
    };
  } finally {
    handle.close();
  }
}

function createBundledIntegrationMigrationPlan(opts = {}) {
  const usage = inspectBundledIntegrationUsage(opts);
  if (opts.installationProvenance && opts.installationProvenance.dbExisted === false) usage.newUser = true;
  const createdAt = new Date().toISOString();
  const targets = {};
  const bundles = [];
  for (const item of BUNDLED_INTEGRATIONS) {
    const domainUsage = usage[item.domain] || { used: false, projects: [] };
    const prior = usage.ownership[item.domain] || { preferredOwner: 'legacy', activeOwner: 'legacy' };
    const targetOwner = domainUsage.used ? item.extensionId : 'legacy';
    targets[item.domain] = {
      domain: item.domain,
      priorOwner: prior.activeOwner || 'legacy',
      priorPreferredOwner: prior.preferredOwner || prior.activeOwner || 'legacy',
      targetOwner,
      extensionId: item.extensionId,
      used: !!domainUsage.used,
      affectedProjectIds: (domainUsage.projects || []).map((project) => project.id),
    };
    bundles.push({
      id: item.extensionId,
      domain: item.domain,
      install: true,
      enable: targetOwner !== 'legacy',
      switchOwnership: targetOwner !== 'legacy',
    });
  }
  return {
    version: BUNDLED_INTEGRATION_MIGRATION_VERSION,
    createdAt,
    dryRun: !!opts.dryRun,
    newUser: !!usage.newUser,
    noOp: Object.values(targets).every((target) => target.targetOwner === 'legacy'),
    source: {
      dbPath: usage.dbPath || opts.dbPath || null,
      appHome: opts.appHome || null,
      extensionsDir: opts.extensionsDir || null,
      bundledDir: opts.bundledDir || (opts.root ? path.join(opts.root, 'bundled-extensions') : null),
      installationProvenance: opts.installationProvenance || null,
      updateContext: opts.updateContext || null,
    },
    priorOwnership: usage.ownership,
    targets,
    bundles,
    affectedProjects: {
      graphify: usage.graphify.projects,
      git: usage.git.projects,
    },
    steps: [
      'backup database and configuration',
      'persist migration plan and ledger',
      'install bundled extensions offline',
      'import compatibility state into extension_state',
      'enable target bundled extensions',
      'switch ownership for used domains',
      'run health validation',
      'persist completion ledger',
    ],
  };
}

function setExtensionStateValue(handle, extensionId, scopeType, scopeId, key, value, updatedAt) {
  ensureMigrationTables(handle);
  handle.prepare(`
    INSERT INTO extension_state (extension_id, scope_type, scope_id, key, value, updated_at)
    VALUES (@extension_id, @scope_type, @scope_id, @key, @value, @updated_at)
    ON CONFLICT(extension_id, scope_type, scope_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run({
    extension_id: extensionId,
    scope_type: scopeType,
    scope_id: scopeId,
    key,
    value: JSON.stringify(value),
    updated_at: updatedAt,
  });
}

function importBundledIntegrationState(handle, plan) {
  const updatedAt = new Date().toISOString();
  for (const project of plan.affectedProjects.graphify || []) {
    setExtensionStateValue(handle, 'graphify', 'project', project.id, 'importedFrom', 'legacy-project-columns', updatedAt);
    setExtensionStateValue(handle, 'graphify', 'project', project.id, 'compatibility', {
      graphify_enabled: project.graphify_enabled,
      graphify_status: project.graphify_status,
      graphify_last_success_at: project.graphify_last_success_at,
      graphify_last_error: project.graphify_last_error,
      graphify_hook_status: project.graphify_hook_status,
      graphify_dirty_at: project.graphify_dirty_at,
    }, updatedAt);
    setExtensionStateValue(handle, 'graphify', 'project', project.id, 'artifacts', project.artifacts || {}, updatedAt);
  }
  for (const project of plan.affectedProjects.git || []) {
    setExtensionStateValue(handle, 'git-workflow', 'project', project.id, 'importedFrom', 'legacy-project-detection', updatedAt);
    setExtensionStateValue(handle, 'git-workflow', 'project', project.id, 'git', project.git || {}, updatedAt);
  }
}

async function runBundledIntegrationMigration(opts = {}) {
  const root = opts.root || process.cwd();
  const dbPath = opts.dbPath;
  const appHome = opts.appHome;
  const backupDir = opts.backupDir || (appHome ? path.join(appHome, 'backups') : undefined);
  const extensionsDir = opts.extensionsDir || (appHome ? path.join(appHome, 'extensions') : undefined);
  const bundledDir = opts.bundledDir || path.join(root, 'bundled-extensions');
  let updateContext = opts.updateContext || null;
  if (!updateContext && dbPath && fs.existsSync(dbPath)) {
    const contextHandle = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { updateContext = readMetaJson(contextHandle, UPDATE_STARTUP_CONTEXT_KEY, null); } finally { contextHandle.close(); }
  }
  const plan = opts.plan || createBundledIntegrationMigrationPlan({
    root,
    dbPath,
    appHome,
    extensionsDir,
    bundledDir,
    dryRun: !!opts.dryRun,
    installationProvenance: opts.installationProvenance,
    updateContext,
  });

  if (opts.dryRun) return { ok: true, dryRun: true, plan };
  if (!dbPath) throw new Error('bundled integration migration requires dbPath');

  // The completed fast path must be genuinely read-only: ordinary restarts do
  // not create backups, rewrite plans, or touch ownership state.
  if (!opts.repair && fs.existsSync(dbPath)) {
    const completedHandle = new Database(dbPath);
    try {
      const existing = readMetaJson(completedHandle, BUNDLED_INTEGRATION_LEDGER_KEY, null);
      if (existing && existing.status === 'completed' && existing.version === BUNDLED_INTEGRATION_MIGRATION_VERSION) {
        return { ok: true, alreadyCompleted: true, plan: readMetaJson(completedHandle, BUNDLED_INTEGRATION_PLAN_KEY, plan), ledger: existing };
      }
    } finally {
      completedHandle.close();
    }
  }

  const backup = backupInstance({ appHome, dbPath, backupDir, label: 'pre-bundled-integration-migration' });
  const handle = new Database(dbPath);
  const ledger = {
    version: BUNDLED_INTEGRATION_MIGRATION_VERSION,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps: [],
    backup,
  };
  const recordStep = (step, extra = {}) => {
    ledger.steps.push({ step, at: new Date().toISOString(), ...extra });
    writeMetaJson(handle, BUNDLED_INTEGRATION_LEDGER_KEY, ledger);
  };

  try {
    ensureMigrationTables(handle);
    const existing = readMetaJson(handle, BUNDLED_INTEGRATION_LEDGER_KEY, null);
    const persistedPlan = readMetaJson(handle, BUNDLED_INTEGRATION_PLAN_KEY, null);
    const effectivePlan = persistedPlan || plan;
    if (opts.repair && persistedPlan) Object.assign(plan, effectivePlan);

    writeMetaJson(handle, BUNDLED_INTEGRATION_PLAN_KEY, plan);
    recordStep('plan-persisted');

    const { ExtensionPlatform } = require('./extensionPlatform');
    const { loadExtensions } = require('./extensions');
    const platform = new ExtensionPlatform({
      db: migrationDbAdapter(handle),
      bundledDir,
      extensionsDir,
    });
    platform.prepare();
    recordStep('platform-prepared');

    for (const bundle of plan.bundles) {
      const status = platform.extensionStatus(bundle.id);
      if (!status.installed) {
        platform.installBundled(bundle.id, { enable: !!bundle.enable });
        recordStep('bundle-installed', { extensionId: bundle.id });
      } else if (status.errors.length) {
        platform.installBundled(bundle.id, { replace: true });
        recordStep('bundle-repaired', { extensionId: bundle.id, reason: 'invalid-or-corrupt' });
      } else if (status.updateAvailable) {
        platform.upgradeBundled(bundle.id);
        recordStep('bundle-upgraded', { extensionId: bundle.id });
      }
      if (bundle.enable && !platform.extensionStatus(bundle.id).enabled) {
        platform.enable(bundle.id);
        recordStep('bundle-enabled', { extensionId: bundle.id });
      }
      if (!bundle.enable && platform.extensionStatus(bundle.id).enabled) {
        platform.disable(bundle.id);
        recordStep('bundle-disabled', { extensionId: bundle.id });
      }
    }

    const importTx = handle.transaction(() => importBundledIntegrationState(handle, plan));
    importTx();
    recordStep('state-imported');

    for (const target of Object.values(plan.targets)) {
      if (target.targetOwner !== 'legacy') {
        platform.switchOwnership(target.domain, target.targetOwner);
        recordStep('ownership-switched', { domain: target.domain, owner: target.targetOwner });
      }
    }

    const loaded = loadExtensions({
      extensionsDir,
      context: {
        db: migrationDbAdapter(handle),
        paths: { APP_ROOT: root },
        workspaceRoot: root,
      },
      platform,
    });
    const health = await platform.runHealthChecks();
    for (const target of Object.values(plan.targets)) {
      if (target.targetOwner === 'legacy') continue;
      const checks = health.filter((item) => item.extensionId === target.targetOwner);
      if (!checks.length) throw new Error(`readiness validation missing for ${target.targetOwner}`);
      const failed = checks.find((item) => !item.ok);
      if (failed) throw new Error(`readiness validation failed for ${target.targetOwner}: ${failed.detail || failed.name}`);
    }
    platform.reconcileOwnership(loaded.extensions);
    const diagnostics = platform.diagnostics();
    for (const target of Object.values(plan.targets)) {
      const state = diagnostics.ownership[target.domain];
      if (target.targetOwner !== 'legacy' && (!state || state.activeOwner !== target.targetOwner)) {
        throw new Error(`ownership validation failed for ${target.domain}: ${state && state.activeOwner}`);
      }
    }
    recordStep('health-validated', { checks: health.length });
    ledger.status = 'completed';
    ledger.completedAt = new Date().toISOString();
    writeMetaJson(handle, BUNDLED_INTEGRATION_LEDGER_KEY, ledger);
    if (updateContext && updateContext.status === 'pending') {
      writeMetaJson(handle, UPDATE_STARTUP_CONTEXT_KEY, {
        ...updateContext,
        status: 'completed',
        completedAt: ledger.completedAt,
      });
    }
    await loaded.shutdown({ reason: 'migration' });
    platform.shutdown();
    handle.close();
    return { ok: true, plan, ledger, diagnostics };
  } catch (error) {
    try {
      const { ExtensionPlatform } = require('./extensionPlatform');
      const platform = new ExtensionPlatform({
        db: migrationDbAdapter(handle),
        bundledDir,
        extensionsDir,
      });
      platform.prepare();
      for (const target of Object.values(plan.targets || {})) {
        platform.switchOwnership(target.domain, target.priorPreferredOwner || 'legacy');
      }
      platform.shutdown();
    } catch {
      /* best-effort fallback */
    }
    ledger.status = 'failed';
    ledger.repair = !!opts.repair;
    ledger.error = error && error.message ? error.message : String(error);
    ledger.failedAt = new Date().toISOString();
    writeMetaJson(handle, BUNDLED_INTEGRATION_LEDGER_KEY, ledger);
    if (updateContext && updateContext.status === 'pending') {
      writeMetaJson(handle, UPDATE_STARTUP_CONTEXT_KEY, {
        ...updateContext,
        status: 'failed',
        failedAt: ledger.failedAt,
        error: ledger.error,
      });
    }
    handle.close();
    throw error;
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

async function updateGitCheckout(opts = {}) {
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
  const bundledMigration = await runBundledIntegrationMigration({ ...opts, root, dbPath, dryRun: true });
  if (opts.dryRun) {
    return { ok: true, dryRun: true, target, before, backup, migration, bundledMigration, extensionConflicts: extensions.conflicts };
  }

  try {
    runGit(root, ['fetch', '--tags', '--prune'], { stdio: 'inherit', timeoutMs: 120000 });
    runGit(root, ['checkout', target], { stdio: 'inherit', timeoutMs: 120000 });
    npmInstall(root);
    const installedRef = currentGitRef(root) || target;
    const startupContext = {
      version: 1,
      status: 'pending',
      kind: 'upgrade',
      previousRef: before,
      targetRef: installedRef,
      backupPath: backup && backup.path || null,
      createdAt: new Date().toISOString(),
    };
    writeMetaValues(dbPath, {
      'updates.rollback_ref': before,
      'updates.current_ref': installedRef,
      'updates.last_update_at': new Date().toISOString(),
      'updates.last_update_error': '',
      [UPDATE_STARTUP_CONTEXT_KEY]: JSON.stringify(startupContext),
    });
    return { ok: true, target, before, backup, migration, bundledMigration, startupMigration: startupContext };
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
  const rolledBackRef = currentGitRef(root) || target;
  writeMetaValues(dbPath, {
    'updates.rollback_ref': before || '',
    'updates.current_ref': rolledBackRef,
    'updates.last_rollback_at': new Date().toISOString(),
    'updates.last_update_error': '',
    [UPDATE_STARTUP_CONTEXT_KEY]: JSON.stringify({
      version: 1,
      status: 'completed',
      kind: 'rollback',
      previousRef: before,
      targetRef: rolledBackRef,
      backupPath: backup && backup.path || null,
      createdAt: new Date().toISOString(),
    }),
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
  inspectBundledIntegrationUsage,
  createBundledIntegrationMigrationPlan,
  runBundledIntegrationMigration,
  writeMetaValues,
  readMetaValue,
  updateGitCheckout,
  rollbackGitCheckout,
};
