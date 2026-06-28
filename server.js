'use strict';

/**
 * Control Center — local server.
 *
 *   Express (REST + static)  +  ws (PTY bridge)  +  better-sqlite3  +  node-pty
 *
 * Security model: this serves a live PTY running `codex` — effectively local shell
 * access. It binds 127.0.0.1 ONLY and validates the WebSocket Origin. Never expose it.
 *
 * Every launch is interactive and runs through node-pty so the browser drawer is
 * the provider's real TUI.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const paths = require('./lib/core/paths');
const db = require('./lib/db');
const codex = require('./lib/codex');
const { GraphifyManager, graphifyProjectInfo } = require('./lib/graphify');
const { autoCommitTaskProject } = require('./lib/gitAutoCommit');
const { buildHookArgs } = require('./lib/hooksSettings');
const { ensureSpawnHelper } = require('./lib/ensurePty');
const updater = require('./lib/core/updater');
const { loadExtensions } = require('./lib/core/extensions');
const { discoverModelProviders, normalizeActiveProvider } = require('./lib/modelProviders');
const { getProvider } = require('./lib/providers');
const { SessionManager } = require('./lib/sessionRunner');

// Self-heal node-pty's spawn-helper +x bit (survives `npm install --ignore-scripts`).
ensureSpawnHelper();

const PORT = Number(process.env.PORT) || 3137;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PACKAGE = require('./package.json');
const BOOT_ID = `${process.pid}-${Date.now()}`;
// Tasks can target any folder under the workspace. Public installs should not infer
// a user workspace from the app checkout, because release code may live under
// ~/.control-center/current.
const WORKSPACE_ROOT = codex.resolveProjectPath(process.env.CC_WORKSPACE_ROOT || process.env.CONTROL_CENTER_WORKSPACE_ROOT || paths.defaultWorkspaceRoot());

// ---- boot: hooks + session manager ---------------------------------------

const hookArgs = buildHookArgs(process.execPath);

// "YOLO mode": build-mode sessions default to Codex
// --dangerously-bypass-approvals-and-sandbox. Disable with CC_SKIP_PERMISSIONS=false.
const YOLO = !['0', 'false', 'no', 'off'].includes(String(process.env.CC_SKIP_PERMISSIONS ?? 'true').toLowerCase());
const ULTRACODE_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.CC_ULTRACODE ?? 'false').toLowerCase());
const ACTIVE_MODEL_PROVIDER_KEY = 'models.active_provider';
const CAFFEINATE_ENABLED_KEY = 'settings.caffeinate_enabled';
const CAFFEINATE_BIN = '/usr/bin/caffeinate';
const CAFFEINATE_ARGS = ['-dims', '-w', String(process.pid)];

const manager = new SessionManager();
manager.configure({ hookArgs, dbPath: db.DB_PATH, yolo: YOLO });

const graphifyManager = new GraphifyManager(db);
graphifyManager.syncProjects(db.listProjects());

// Pending launches: taskId -> { kind, sessionId?, parentSessionId?, prompt? }.
// Set by the start/resume/fork endpoints, consumed by the next /pty connection.
const pending = new Map();

// ---- express -------------------------------------------------------------

const app = express();
const jsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.path.startsWith('/api/media')) return next();
  return jsonParser(req, res, next);
});
app.use(express.static(path.join(ROOT, 'public')));
// Serve the vendored xterm assets straight from node_modules (no build step).
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit')));

const extensionManager = loadExtensions({
  app,
  extensionsDir: paths.EXTENSIONS_DIR,
  context: { db, paths, workspaceRoot: WORKSPACE_ROOT },
});

// Fine-grained status shown in the UI: waiting (backlog) · running (Codex actively working) ·
// needs_attention (in-progress but idle / not live) · done.
function displayStatusOf(t, live, busy) {
  if (t.status === 'backlog') return 'waiting';
  if (t.status === 'done') return 'done';
  if (t.activity === 'workflow' && t.wake_at && Date.parse(t.wake_at) > Date.now()) return 'running';
  return live && busy ? 'running' : 'needs_attention';
}

function activeModelProvider() {
  return normalizeActiveProvider(db.getMetaValue(ACTIVE_MODEL_PROVIDER_KEY, 'codex'));
}

function parseSettingBool(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function metaBool(key, fallback) {
  return parseSettingBool(db.getMetaValue(key, fallback ? '1' : '0'), fallback);
}

function setMetaBool(key, value) {
  db.setMetaValue(key, value ? '1' : '0');
  return metaBool(key, value);
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
}

function versionPayload() {
  return {
    version: PACKAGE.version,
    commit: currentCommit(),
    installPath: ROOT,
    appHome: paths.APP_HOME,
    dataPath: db.DB_PATH,
    backupPath: db.DB_BACKUP_DIR,
    updateChannel: db.getMetaValue('updates.channel', 'stable'),
    lastUpdateCheckAt: db.getMetaValue('updates.last_check_at', null),
    latestReleaseVersion: db.getMetaValue('updates.latest_release_version', null),
    latestReleaseUrl: db.getMetaValue('updates.latest_release_url', null),
    latestReleaseNotes: db.getMetaValue('updates.latest_release_notes', null),
    latestReleasePublishedAt: db.getMetaValue('updates.latest_release_published_at', null),
    latestReleaseAvailable: metaBool('updates.latest_release_available', false),
    latestReleaseError: db.getMetaValue('updates.latest_release_error', null),
    rollbackRef: db.getMetaValue('updates.rollback_ref', null),
    lastUpdateAt: db.getMetaValue('updates.last_update_at', null),
    lastUpdateError: db.getMetaValue('updates.last_update_error', null),
  };
}

async function checkForUpdates() {
  return updater.checkForUpdates({
    root: ROOT,
    dbPath: db.DB_PATH,
    currentVersion: PACKAGE.version,
  });
}

function scheduleUpdateCheck() {
  if (['0', 'false', 'no', 'off'].includes(String(process.env.CC_UPDATE_AUTO_CHECK ?? 'true').toLowerCase())) return;
  const last = Date.parse(db.getMetaValue('updates.last_check_at', '') || '');
  if (Number.isFinite(last) && Date.now() - last < 12 * 60 * 60 * 1000) return;
  const timer = setTimeout(() => {
    checkForUpdates().catch(() => {
      /* checkForUpdates records visible metadata and must never block startup */
    });
  }, 5000);
  timer.unref();
}

let caffeinateChild = null;
let caffeinateLastError = '';
let caffeinateStartedAt = null;
let caffeinateStoppedAt = null;

function caffeinateEnabled() {
  return metaBool(CAFFEINATE_ENABLED_KEY, true);
}

function caffeinateSupported() {
  return process.platform === 'darwin' && fs.existsSync(CAFFEINATE_BIN);
}

function caffeinateStatus() {
  const active = !!(caffeinateChild && caffeinateChild.exitCode == null && !caffeinateChild.killed);
  return {
    enabled: caffeinateEnabled(),
    supported: caffeinateSupported(),
    active,
    pid: active ? caffeinateChild.pid : null,
    command: process.platform === 'darwin' ? `${CAFFEINATE_BIN} ${CAFFEINATE_ARGS.join(' ')}` : null,
    error: caffeinateLastError || null,
    startedAt: caffeinateStartedAt,
    stoppedAt: caffeinateStoppedAt,
  };
}

function stopCaffeinate() {
  const child = caffeinateChild;
  caffeinateChild = null;
  if (!child) return;
  caffeinateStoppedAt = new Date().toISOString();
  try {
    child.kill('SIGTERM');
  } catch {
    /* best-effort */
  }
}

function startCaffeinate() {
  if (caffeinateChild && caffeinateChild.exitCode == null && !caffeinateChild.killed) return;
  if (process.platform !== 'darwin') {
    caffeinateLastError = 'caffeinate is only available on macOS';
    return;
  }
  if (!fs.existsSync(CAFFEINATE_BIN)) {
    caffeinateLastError = `${CAFFEINATE_BIN} was not found`;
    return;
  }

  const child = spawn(CAFFEINATE_BIN, CAFFEINATE_ARGS, {
    cwd: ROOT,
    stdio: 'ignore',
  });
  caffeinateChild = child;
  caffeinateLastError = '';
  caffeinateStartedAt = new Date().toISOString();
  caffeinateStoppedAt = null;
  child.unref();
  child.once('error', (err) => {
    if (caffeinateChild === child) caffeinateChild = null;
    caffeinateLastError = err && err.message ? err.message : String(err);
    caffeinateStoppedAt = new Date().toISOString();
  });
  child.once('exit', (code, signal) => {
    if (caffeinateChild !== child) return;
    caffeinateChild = null;
    caffeinateStoppedAt = new Date().toISOString();
    if (caffeinateEnabled() && code !== 0 && signal !== 'SIGTERM') {
      caffeinateLastError = `caffeinate exited with ${signal || code}`;
    }
  });
}

function syncCaffeinate() {
  if (!caffeinateEnabled()) {
    caffeinateLastError = '';
    stopCaffeinate();
    return;
  }
  startCaffeinate();
}

function generalSettingsPayload() {
  syncCaffeinate();
  const caffeinate = caffeinateStatus();
  return {
    caffeinateEnabled: caffeinate.enabled,
    caffeinate,
    version: versionPayload(),
  };
}

function withChildren(tasks) {
  const byParent = new Map();
  for (const t of tasks) {
    if (t.parent_task_id) {
      if (!byParent.has(t.parent_task_id)) byParent.set(t.parent_task_id, []);
      byParent.get(t.parent_task_id).push(t.id);
    }
  }
  return tasks.map((t) => {
    const live = manager.isLive(t.id);
    // Only hook/database activity is authoritative. PTY output is not a safe signal because an
    // idle interactive TUI can repaint on focus/click and emit bytes without Codex doing work.
    const busy = live && t.activity === 'working';
    return {
      ...t,
      live,
      children: byParent.get(t.id) || [],
      canView: !!t.session_id,
      displayStatus: displayStatusOf(t, live, busy),
    };
  });
}

app.get('/api/health', (req, res) => {
  let nodePtyOk = true;
  try {
    require('node-pty');
  } catch {
    nodePtyOk = false;
  }
  res.json({
    ok: true,
    bootId: BOOT_ID,
    pid: process.pid,
    appVersion: PACKAGE.version,
    appHome: paths.APP_HOME,
    codexBin: codex.CODEX_BIN,
    codexVersion: codex.codexVersion(),
    codexAuthConfigured: codex.codexAuthConfigured(),
    activeModelProvider: activeModelProvider(),
    dbPath: db.DB_PATH,
    backupPath: db.DB_BACKUP_DIR,
    workspaceRoot: WORKSPACE_ROOT,
    skipPermissions: YOLO,
    providerCapabilities: getProvider(activeModelProvider()).supports,
    ultracodeEnabled: ULTRACODE_ENABLED || !!getProvider(activeModelProvider()).supports.ultracode,
    graphifyEnabled: graphifyManager.enabled,
    graphifyWatchEnabled: graphifyManager.watchEnabled,
    graphifyBin: graphifyManager.bin,
    extensions: {
      count: extensionManager.extensions.length,
      conflicts: extensionManager.conflicts.length,
    },
    caffeinate: caffeinateStatus(),
    nodePtyOk,
  });
});

app.get('/api/version', (req, res) => {
  res.json(versionPayload());
});

app.post('/api/version/check', async (req, res) => {
  const updateCheck = await checkForUpdates();
  res.json({ version: versionPayload(), updateCheck });
});

app.get('/api/extensions', (req, res) => {
  res.json(extensionManager.publicPayload());
});

function updateRequestOptions(body, dryRun) {
  return {
    root: ROOT,
    appHome: paths.APP_HOME,
    dbPath: db.DB_PATH,
    backupDir: db.DB_BACKUP_DIR,
    extensionsDir: paths.EXTENSIONS_DIR,
    target: body && body.target ? String(body.target).trim() : undefined,
    dryRun,
    allowExtensionConflicts: !!(body && body.allow_extension_conflicts),
  };
}

function updateErrorPayload(error) {
  return {
    error: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : undefined,
    changes: error && error.changes ? error.changes : undefined,
    conflicts: error && error.conflicts ? error.conflicts : undefined,
    rollbackError: error && error.rollbackError ? error.rollbackError : undefined,
  };
}

function rejectLiveSessions(req, res) {
  const liveTaskIds = manager.liveTaskIds();
  if (!liveTaskIds.length || (req.body && req.body.force)) return false;
  res.status(409).json({
    error: 'active terminal sessions are running; stop them or pass force',
    code: 'ACTIVE_SESSIONS',
    liveTaskIds,
  });
  return true;
}

app.post('/api/update/dry-run', (req, res) => {
  try {
    const result = updater.updateGitCheckout(updateRequestOptions(req.body || {}, true));
    res.json({ ok: true, result, version: versionPayload() });
  } catch (e) {
    res.status(400).json(updateErrorPayload(e));
  }
});

app.post('/api/update/apply', (req, res) => {
  if (rejectLiveSessions(req, res)) return;
  try {
    const result = updater.updateGitCheckout(updateRequestOptions(req.body || {}, false));
    spawnReplacementServer();
    res.json({ ok: true, restarting: true, result, version: versionPayload(), bootId: BOOT_ID });
    setTimeout(() => shutdown('restart'), 50).unref();
  } catch (e) {
    res.status(400).json(updateErrorPayload(e));
  }
});

app.post('/api/update/rollback', (req, res) => {
  if (rejectLiveSessions(req, res)) return;
  try {
    const result = updater.rollbackGitCheckout(updateRequestOptions(req.body || {}, !!(req.body && req.body.dry_run)));
    if (req.body && req.body.dry_run) {
      res.json({ ok: true, result, version: versionPayload() });
      return;
    }
    spawnReplacementServer();
    res.json({ ok: true, restarting: true, result, version: versionPayload(), bootId: BOOT_ID });
    setTimeout(() => shutdown('restart'), 50).unref();
  } catch (e) {
    res.status(400).json(updateErrorPayload(e));
  }
});

app.get('/api/settings/general', (req, res) => {
  res.json(generalSettingsPayload());
});

app.patch('/api/settings/general', (req, res) => {
  const body = req.body || {};
  if ('caffeinate_enabled' in body) {
    setMetaBool(CAFFEINATE_ENABLED_KEY, parseSettingBool(body.caffeinate_enabled, true));
  }
  res.json(generalSettingsPayload());
});

app.get('/api/connections/models', (req, res) => {
  res.json(discoverModelProviders({ activeProvider: activeModelProvider() }));
});

app.patch('/api/connections/models', (req, res) => {
  const rawProvider = String((req.body || {}).active_provider || '').trim();
  if (!['codex', 'claude'].includes(rawProvider)) return res.status(400).json({ error: 'unknown model provider' });
  const requested = normalizeActiveProvider(rawProvider);
  const current = activeModelProvider();
  const discovered = discoverModelProviders({ activeProvider: current });
  const provider = discovered.providers.find((p) => p.id === requested);
  if (!provider) return res.status(400).json({ error: 'unknown model provider' });
  if (provider.id !== current && !provider.canActivate) {
    return res.status(400).json({ error: provider.disabledReason || 'model provider cannot be activated' });
  }
  db.setMetaValue(ACTIVE_MODEL_PROVIDER_KEY, provider.id);
  res.json(discoverModelProviders({ activeProvider: provider.id }));
});

function spawnReplacementServer() {
  const launcher = `
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const serverFile = ${JSON.stringify(path.join(ROOT, 'server.js'))};
const cwd = ${JSON.stringify(ROOT)};
const host = ${JSON.stringify(HOST)};
const port = Number(process.env.PORT) || ${PORT};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portIsFree() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, host);
  });
}

(async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await portIsFree()) {
      const child = spawn(process.execPath, [serverFile], {
        cwd,
        env: { ...process.env, CC_RESTARTED: '1' },
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }
    await sleep(250);
  }
  process.exitCode = 1;
})();
`;
  const child = spawn(process.execPath, ['-e', launcher], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

app.post('/api/restart', (req, res) => {
  try {
    spawnReplacementServer();
  } catch (e) {
    return res.status(500).json({ error: 'failed to schedule restart: ' + String(e && e.message) });
  }
  res.json({ ok: true, restarting: true, bootId: BOOT_ID });
  setTimeout(() => shutdown('restart'), 50).unref();
});

app.post('/api/quit', (req, res) => {
  res.json({ ok: true, quitting: true, bootId: BOOT_ID });
  setTimeout(() => shutdown('quit'), 50).unref();
});

function projectsWithStats() {
  const counts = new Map();
  for (const t of db.listTasks(true)) {
    if (t.archived) continue;
    counts.set(t.project_path, (counts.get(t.project_path) || 0) + 1);
  }
  return db.listProjects().map((p) => {
    const graphify = graphifyProjectInfo(p.path);
    return {
      ...p,
      ...graphify,
      git_initialized: fs.existsSync(path.join(p.path, '.git')) ? 1 : 0,
      graphify_status: p.graphify_enabled === 0
        ? 'disabled'
        : graphify.graphify_external_running
        ? 'running'
        : graphify.graphify_needs_update && p.graphify_status === 'current'
          ? 'stale'
          : p.graphify_status,
      task_count: counts.get(p.path) || 0,
    };
  });
}

function ensureGitRepo(projectPath) {
  if (fs.existsSync(path.join(projectPath, '.git'))) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    execFile('git', ['init'], { cwd: projectPath, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || stdout || err.message || 'git init failed').trim();
        reject(new Error(msg));
        return;
      }
      resolve(true);
    });
  });
}

function normalizeProjectPathInput(raw) {
  if (!raw || !String(raw).trim()) return null;
  return codex.resolveProjectPath(raw, WORKSPACE_ROOT);
}

// Projects are dashboard-owned records. Tasks select from this list; the path remains the runtime
// link because sessions and USER_UPLOADS are rooted in the project folder.
app.get('/api/projects', (req, res) => {
  res.json({ root: WORKSPACE_ROOT, home: os.homedir(), projects: projectsWithStats() });
});

app.post('/api/projects', async (req, res) => {
  const b = req.body || {};
  const resolved = normalizeProjectPathInput(b.path);
  if (!resolved) return res.status(400).json({ error: 'project path is required' });
  if (!codex.safeIsDir(resolved)) return res.status(400).json({ error: `project path does not exist: ${resolved}` });
  if (db.getProjectByPath(resolved, true)) return res.status(409).json({ error: 'project path already exists' });
  if (b.git_enabled) {
    try {
      await ensureGitRepo(resolved);
    } catch (e) {
      return res.status(500).json({ error: `failed to initialize git repository: ${String(e && e.message)}` });
    }
  }
  const project = db.createProject({
    name: b.name && String(b.name).trim() ? String(b.name).trim() : codex.displayProjectName(resolved),
    description: String(b.description || ''),
    path: resolved,
    graphify_enabled: b.graphify_enabled == null ? 1 : b.graphify_enabled ? 1 : 0,
  });
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  if (project.graphify_enabled) graphifyManager.enqueue(project.id, 'project-created', { immediate: true });
  res.status(201).json(db.getProject(project.id));
});

app.patch('/api/projects/:id', async (req, res) => {
  const existing = db.getProject(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const patch = {};
  if ('name' in (req.body || {})) patch.name = String(req.body.name || '').trim() || codex.displayProjectName(existing.path);
  if ('description' in (req.body || {})) patch.description = String(req.body.description || '');
  if ('graphify_enabled' in (req.body || {})) patch.graphify_enabled = req.body.graphify_enabled ? 1 : 0;
  if ('path' in (req.body || {})) {
    const resolved = normalizeProjectPathInput(req.body.path);
    if (!resolved) return res.status(400).json({ error: 'project path is required' });
    if (!codex.safeIsDir(resolved)) return res.status(400).json({ error: `project path does not exist: ${resolved}` });
    const owner = db.getProjectByPath(resolved, true);
    if (owner && owner.id !== existing.id) return res.status(409).json({ error: 'project path already exists' });
    patch.path = resolved;
  }
  const wasGraphifyEnabled = existing.graphify_enabled !== 0;
  const gitPath = patch.path || existing.path;
  let gitInitialized = false;
  if ((req.body || {}).git_enabled) {
    try {
      gitInitialized = await ensureGitRepo(gitPath);
    } catch (e) {
      return res.status(500).json({ error: `failed to initialize git repository: ${String(e && e.message)}` });
    }
  }
  const updated = db.updateProject(existing.id, patch);
  const isGraphifyEnabled = updated.graphify_enabled !== 0;
  const pathChanged = 'path' in patch && patch.path !== existing.path;
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  if (!wasGraphifyEnabled && isGraphifyEnabled) {
    graphifyManager.enqueue(updated.id, 'project-enabled', { immediate: true });
  } else if (wasGraphifyEnabled && !isGraphifyEnabled) {
    graphifyManager.disableProject(updated.id, { uninstall: true });
  } else if (isGraphifyEnabled && (pathChanged || gitInitialized)) {
    graphifyManager.enqueue(updated.id, 'project-updated', { immediate: true });
  }
  res.json(db.getProject(updated.id));
});

app.post('/api/projects/:id/archive', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const updated = db.archiveProject(project.id);
  graphifyManager.disableProject(updated.id, { uninstall: true });
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  res.json(db.getProject(updated.id));
});

app.post('/api/projects/:id/unarchive', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const updated = db.unarchiveProject(project.id);
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  if (updated.graphify_enabled !== 0) graphifyManager.enqueue(updated.id, 'project-updated', { immediate: true });
  res.json(db.getProject(updated.id));
});

app.delete('/api/projects/:id', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  graphifyManager.disableProject(project.id, { uninstall: true });
  const deleted = db.deleteProject(project.id);
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  res.json({ ok: true, project: deleted });
});

app.post('/api/projects/:id/graphify', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const enabled = project.graphify_enabled !== 0 ? project : db.updateProject(project.id, { graphify_enabled: 1 });
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  graphifyManager.enqueue(enabled.id, 'manual', { immediate: true });
  res.json(db.getProject(enabled.id));
});

app.delete('/api/projects/:id/graphify', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const updated = db.updateProject(project.id, { graphify_enabled: 0 });
  graphifyManager.disableProject(updated.id, { uninstall: true });
  graphifyManager.syncProjects(db.listProjects(), { bootstrap: false });
  res.json(db.getProject(updated.id));
});

app.get('/api/tasks', (req, res) => {
  res.json(withChildren(db.listTasks()));
});

const FALLBACK_MODES = ['build', 'plan'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MODEL_RE = /^[A-Za-z0-9._:-]+$/;
const validModel = (m) => typeof m === 'string' && MODEL_RE.test(m.trim());

function launchProvider(task) {
  return getProvider((task && task.provider) || 'codex');
}

function modesForProvider(providerId) {
  const provider = getProvider(providerId);
  return provider && provider.modes ? provider.modes() : FALLBACK_MODES;
}

function rejectUnsupportedLaunch(res, task) {
  const provider = launchProvider(task);
  if (provider.launchSupported) return false;
  res.status(501).json({ error: `${provider.name || provider.id} task launch is not wired in this release` });
  return true;
}

app.post('/api/tasks', (req, res) => {
  const b = req.body || {};
  const { title, description = '', project_path } = b;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (!project_path || !project_path.trim()) return res.status(400).json({ error: 'project_path is required' });
  const resolved = codex.resolveProjectPath(project_path, WORKSPACE_ROOT);
  const project = db.getProjectByPath(resolved);
  if (!project) return res.status(400).json({ error: 'project must be created before tasks can use it' });
  const providerId = activeModelProvider();
  const provider = getProvider(providerId);
  const mode = modesForProvider(providerId).includes(b.mode) ? b.mode : 'build';
  const normalized = provider.normalizeTaskSettings({
    model: validModel(b.model) ? String(b.model).trim() : provider.defaultModel(),
    effort: b.effort === 'max' ? 'xhigh' : EFFORTS.includes(b.effort) ? b.effort : undefined,
    mode,
    yolo: mode === 'build' && (b.yolo == null ? YOLO : !!b.yolo),
    ultracode: provider.supports.ultracode && !!b.ultracode,
  });
  const task = db.createTask({
    title: title.trim(),
    description: String(description || ''),
    project_id: project.id,
    project_path: resolved,
    provider: provider.id,
    model: normalized.model,
    effort: normalized.effort,
    mode: normalized.mode,
    yolo: normalized.yolo,
    ultracode: normalized.ultracode,
  });
  res.status(201).json(task);
});

// Content fields are editable only while a task is still in Backlog and has never started.
// status/col_order stay patchable always (drag-and-drop, auto-advance).
const CONTENT_FIELDS = ['title', 'description', 'project_path', 'model', 'effort', 'mode', 'yolo', 'ultracode'];

app.patch('/api/tasks/:id', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const locked = !!task.started_at || !!task.session_id; // once started, never editable again
  if (locked && CONTENT_FIELDS.some((k) => k in (req.body || {}))) {
    return res.status(409).json({ error: 'task already started — its details are locked' });
  }
  const patch = {};
  for (const k of ['title', 'description', 'project_path', 'status', 'col_order', 'model', 'effort', 'mode', 'yolo', 'ultracode']) {
    if (k in (req.body || {})) patch[k] = req.body[k];
  }
  if (patch.status && !['backlog', 'in_progress', 'done'].includes(patch.status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const provider = launchProvider(task);
  if ('mode' in patch && !modesForProvider(provider.id).includes(patch.mode)) return res.status(400).json({ error: 'invalid mode' });
  if ('effort' in patch && patch.effort === 'max') patch.effort = 'xhigh';
  if ('effort' in patch && !EFFORTS.includes(patch.effort)) return res.status(400).json({ error: 'invalid effort' });
  if ('model' in patch) {
    if (!validModel(patch.model)) return res.status(400).json({ error: 'invalid model' });
    patch.model = String(patch.model).trim();
  }
  if ('yolo' in patch) patch.yolo = patch.yolo ? 1 : 0;
  const effectiveMode = 'mode' in patch ? patch.mode : task.mode;
  if (effectiveMode !== 'build') patch.yolo = 0;
  if ('ultracode' in patch) patch.ultracode = provider.supports.ultracode && patch.ultracode ? 1 : 0;
  if (patch.project_path) {
    patch.project_path = codex.resolveProjectPath(patch.project_path, WORKSPACE_ROOT);
    if (!db.getProjectByPath(patch.project_path)) return res.status(400).json({ error: 'project must be created before tasks can use it' });
  }
  if (patch.status === 'done') return completeTask(req.params.id).then((updated) => res.json(updated));
  res.json(db.updateTask(req.params.id, patch));
});

// Tasks are archived, never hard-deleted (data is preserved).
app.post('/api/tasks/:id/archive', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  manager.stop(req.params.id);
  pending.delete(req.params.id);
  res.json(db.archiveTask(req.params.id));
});

app.post('/api/tasks/:id/unarchive', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(db.updateTask(req.params.id, { archived: 0 }));
});

function taskCommitScope(task) {
  if (!task || !task.session_id) return { files: [], cwd: task && task.project_path };
  const session = db.getSession(task.session_id);
  if (!session || !session.transcript_path || !fs.existsSync(session.transcript_path)) {
    return { files: [], cwd: session && session.cwd ? session.cwd : task.project_path };
  }
  try {
    const provider = getProvider(session.provider || task.provider || 'codex');
    const parsed = provider.parseTranscript(session.transcript_path);
    return {
      cwd: parsed.meta.cwd || session.cwd || task.project_path,
      files: (parsed.filesTouched || [])
        .filter((f) => Array.isArray(f.ops) && f.ops.includes('write'))
        .map((f) => f.path),
    };
  } catch {
    return { files: [], cwd: session.cwd || task.project_path };
  }
}

async function completeTask(taskId) {
  const task = db.getTask(taskId);
  if (!task) return null;
  const updated = db.updateTask(taskId, { status: 'done', ended_at: db.now(), activity: null, wake_at: null });
  if (task.session_id) db.endSession(task.session_id);
  manager.stop(taskId);
  pending.delete(taskId);
  try {
    const scope = taskCommitScope(task);
    updated.git_commit = await autoCommitTaskProject(task, scope);
  } catch (e) {
    updated.git_commit = {
      ok: false,
      error: String(e && e.message ? e.message : e),
    };
  }
  graphifyManager.enqueueByPath(task.project_path, 'task-completed', { immediate: true });
  return updated;
}

app.post('/api/tasks/:id/done', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  return completeTask(req.params.id).then((updated) => res.json(updated));
});

// Archived tasks (hidden from the main board) — for the "Archived" filter view.
app.get('/api/tasks/archived', (req, res) => {
  res.json(withChildren(db.listTasks(true).filter((t) => t.archived)));
});

app.post('/api/tasks/:id/start', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (rejectUnsupportedLaunch(res, task)) return;
  if (manager.isLive(task.id)) return res.json({ sessionId: task.session_id, alreadyLive: true });
  if (task.session_id) {
    return res.status(409).json({ error: 'session already exists — use resume', sessionId: task.session_id });
  }
  const provider = launchProvider(task);
  const cwd = provider.resolveProjectPath(task.project_path);
  if (!provider.safeIsDir(cwd)) {
    return res.status(400).json({ error: `project path does not exist: ${cwd}` });
  }
  const openingPrompt = provider.taskOpeningPrompt(task);
  db.updateTask(task.id, {
    status: 'in_progress',
    started_at: task.started_at || db.now(),
    ended_at: null,
    activity: openingPrompt.trim() ? 'working' : 'idle',
  });
  pending.set(task.id, { kind: 'start', prompt: openingPrompt });
  res.json({ sessionId: null, pending: true });
});

app.post('/api/tasks/:id/resume', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (rejectUnsupportedLaunch(res, task)) return;
  if (!task.session_id) return res.status(400).json({ error: 'no session to resume — use start' });
  if (!manager.isLive(task.id)) pending.set(task.id, { kind: 'resume', sessionId: task.session_id });
  db.updateTask(task.id, { status: 'in_progress', ended_at: null });
  res.json({ sessionId: task.session_id });
});

app.post('/api/tasks/:id/fork', (req, res) => {
  const parent = db.getTask(req.params.id);
  if (!parent) return res.status(404).json({ error: 'not found' });
  if (rejectUnsupportedLaunch(res, parent)) return;
  if (!parent.session_id) return res.status(400).json({ error: 'parent has no session to fork from' });
  const provider = launchProvider(parent);
  if (!provider.safeIsDir(provider.resolveProjectPath(parent.project_path))) {
    return res.status(400).json({ error: `project path does not exist: ${parent.project_path}` });
  }
  const title = (req.body && req.body.title && req.body.title.trim()) || `${parent.title} (fork)`;
  const child = db.createTask({
    title,
    description: '',
    project_id: parent.project_id,
    project_path: parent.project_path,
    provider: parent.provider || 'codex',
    parent_task_id: parent.id,
    parent_session_id: parent.session_id,
    status: 'in_progress',
    model: parent.model,
    effort: parent.effort,
    mode: parent.mode,
    yolo: parent.yolo,
    ultracode: provider.supports.ultracode && parent.ultracode,
  });
  db.updateTask(child.id, { started_at: db.now() });
  pending.set(child.id, { kind: 'fork', parentSessionId: parent.session_id });
  res.status(201).json(child);
});

function conversationFor(sessionId, providerId, res) {
  if (!sessionId) return res.status(400).json({ error: 'no session id' });
  const provider = getProvider(providerId);
  const transcriptPath = provider.findTranscript(sessionId);
  if (!transcriptPath) return res.status(404).json({ error: 'transcript not found yet for this session' });
  try {
    const parsed = provider.parseTranscript(transcriptPath);
    res.json({ sessionId, transcriptPath, ...parsed });
  } catch (e) {
    if (e && e.code === 'TRANSCRIPT_TOO_LARGE') {
      return res.status(413).json({ error: 'transcript too large to render', detail: String(e.message) });
    }
    res.status(500).json({ error: 'failed to parse transcript', detail: String(e && e.message) });
  }
}

app.get('/api/tasks/:id/conversation', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  conversationFor(req.query.sessionId || task.session_id, task.provider || 'codex', res);
});

app.get('/api/sessions/:sid/conversation', (req, res) => {
  const session = db.getSession(req.params.sid);
  conversationFor(req.params.sid, (session && session.provider) || 'codex', res);
});

// Lightweight live token/context tally for a task's terminal header (cheap enough to poll).
app.get('/api/tasks/:id/usage', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const sid = req.query.sessionId || task.session_id;
  const empty = { tokensInput: 0, tokensOutput: 0, contextTokens: 0 };
  if (!sid) return res.json(empty);
  const provider = launchProvider(task);
  const p = provider.findTranscript(sid);
  if (!p) return res.json(empty);
  try {
    res.json(provider.streamCounts(p));
  } catch (e) {
    res.json({ ...empty, error: String(e && e.message) });
  }
});

// ---- media (per-project USER_UPLOADS) ------------------------------------
// Files attached to tasks/sessions live in <project>/USER_UPLOADS so the media of a chat always
// travels with the project. The folder is created on first upload.
const UPLOADS_DIRNAME = 'USER_UPLOADS';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico']);

function uploadsDirFor(projectQuery) {
  if (!projectQuery) return null;
  const proj = codex.resolveProjectPath(String(projectQuery), WORKSPACE_ROOT);
  if (!proj || !codex.safeIsDir(proj)) return null;
  return path.join(proj, UPLOADS_DIRNAME);
}

function safeUploadFile(projectQuery, name) {
  const dir = uploadsDirFor(projectQuery);
  if (!dir) return null;
  const base = path.basename(String(name || '')).trim();
  if (!base || base === '.' || base === '..') return null;
  const full = path.resolve(dir, base);
  if (path.dirname(full) !== path.resolve(dir)) return null; // reject traversal
  return { dir, base, full };
}

function mediaItem(dir, name) {
  const ext = path.extname(name).toLowerCase();
  let size = 0;
  try {
    size = fs.statSync(path.join(dir, name)).size;
  } catch {
    /* ignore */
  }
  return { name, ext, size, isImage: IMAGE_EXTS.has(ext) };
}

app.get('/api/media', (req, res) => {
  const dir = uploadsDirFor(req.query.project);
  if (!dir) return res.status(400).json({ error: 'invalid or missing project' });
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    names = []; // folder doesn't exist yet — that's fine, it's created on first upload
  }
  res.json({ uploadsName: UPLOADS_DIRNAME, files: names.map((n) => mediaItem(dir, n)) });
});

app.post('/api/media', express.raw({ type: () => true, limit: '64mb' }), (req, res) => {
  const sf = safeUploadFile(req.query.project, req.query.name);
  if (!sf) return res.status(400).json({ error: 'invalid project or filename' });
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    fs.mkdirSync(sf.dir, { recursive: true });
    // Never clobber an existing file — suffix " (n)".
    let base = sf.base;
    let target = sf.full;
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let n = 1;
    while (fs.existsSync(target)) {
      base = `${stem} (${n})${ext}`;
      target = path.join(sf.dir, base);
      n += 1;
    }
    fs.writeFileSync(target, body);
    res.status(201).json({ ...mediaItem(sf.dir, base), path: target });
  } catch (e) {
    res.status(500).json({ error: 'failed to save: ' + String(e && e.message) });
  }
});

app.get('/api/media/raw', (req, res) => {
  const sf = safeUploadFile(req.query.project, req.query.name);
  if (!sf || !fs.existsSync(sf.full)) return res.status(404).end();
  res.sendFile(sf.full);
});

app.delete('/api/media', (req, res) => {
  const sf = safeUploadFile(req.query.project, req.query.name);
  if (!sf) return res.status(400).json({ error: 'invalid project or filename' });
  if (!fs.existsSync(sf.full)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(sf.full);
    res.json({ ok: true, name: sf.base });
  } catch (e) {
    res.status(500).json({ error: 'failed to delete: ' + String(e && e.message) });
  }
});

// ---- http + websocket ----------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
]);

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return socket.destroy();
  }
  if (url.pathname !== '/pty') return socket.destroy();
  // CSWSH protection: same-origin only. (Express middleware doesn't run on upgrades.)
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, url);
  });
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req, url) => {
  const taskId = url.searchParams.get('taskId');
  const task = taskId && db.getTask(taskId);
  if (!task) {
    send(ws, { t: 'data', d: '\r\n\x1b[31mUnknown task.\x1b[0m\r\n' });
    return ws.close();
  }

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let runner;
  try {
    if (manager.isLive(task.id)) {
      runner = manager.get(task.id);
    } else {
      const p = pending.get(task.id);
      const cwd = codex.resolveProjectPath(task.project_path);
      if (!codex.safeIsDir(cwd)) {
        send(ws, { t: 'data', d: `\r\n\x1b[31mProject path does not exist: ${cwd}\x1b[0m\r\n` });
        return ws.close();
      }
      if (p) {
        pending.delete(task.id);
        runner = manager.launch({ task, ...p });
      } else if (task.session_id) {
        // Reconnect after Codex exited or the server restarted: resume.
        runner = manager.launch({ task, kind: 'resume', sessionId: task.session_id });
      } else {
        send(ws, { t: 'data', d: '\r\n\x1b[33mNo session yet for this task. Click "Start" first.\x1b[0m\r\n' });
        return ws.close();
      }
    }
  } catch (e) {
    send(ws, { t: 'data', d: `\r\n\x1b[31mFailed to launch: ${String(e && e.message)}\x1b[0m\r\n` });
    return ws.close();
  }

  manager.attach(task.id, ws);

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.t === 'data') runner.write(m.d);
    else if (m.t === 'resize') runner.resize(Number(m.cols), Number(m.rows));
    else if (m.t === 'stop') manager.stop(task.id);
    else if (m.t === 'done') {
      completeTask(task.id);
    }
  });

  const cleanup = () => manager.detach(task.id, ws);
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Heartbeat: drop half-open sockets so their runners can be cleaned up.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);
heartbeat.unref();

// ---- lifecycle -----------------------------------------------------------

function shutdown(reason = 'shutdown') {
  clearInterval(heartbeat);
  const wsCode = reason === 'restart' ? 1012 : 1001;
  const wsReason = reason === 'restart' ? 'Server restarting' : 'Server shutting down';
  for (const ws of wss.clients) {
    try {
      send(ws, { t: reason, d: wsReason });
      ws.close(wsCode, wsReason);
    } catch {
      /* ignore */
    }
  }
  try {
    wss.close();
  } catch {
    /* ignore */
  }
  manager.shutdown();
  graphifyManager.shutdown();
  extensionManager.shutdown();
  stopCaffeinate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  syncCaffeinate();
  scheduleUpdateCheck();
  const caff = caffeinateStatus();
  const v = codex.codexVersion() || 'NOT FOUND on PATH';
  /* eslint-disable no-console */
  console.log(`\n  Control Center`);
  console.log(`  → http://${HOST}:${PORT}`);
  console.log(`  workspace: ${WORKSPACE_ROOT}  (tasks can target any folder here)`);
  console.log(`  permissions: ${YOLO ? 'YOLO — build sessions bypass approvals and sandbox (CC_SKIP_PERMISSIONS=false to disable)' : 'normal (workspace-write, on-request)'}`);
  console.log(`  codex: ${codex.CODEX_BIN} (${v})`);
  console.log(`  hooks: inline .codex-dashboard hooks`);
  console.log(`  caffeinate: ${caff.enabled ? (caff.active ? `active (pid ${caff.pid})` : (caff.error || 'enabled')) : 'off'}`);
  console.log(`  db: ${db.DB_PATH}`);
  console.log('');
});
