'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_DEBOUNCE_MS = 12000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_CHARS = 16000;

const SEMANTIC_EXTENSIONS = new Set([
  '.md', '.mdx', '.qmd', '.txt', '.rst', '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  '.docx', '.xlsx', '.csv', '.tsv',
  '.mp4', '.mov', '.m4v', '.webm', '.mkv',
]);

const IGNORED_WATCH_PARTS = new Set([
  '.git',
  '.codex',
  '.codex-dashboard',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'graphify-out',
  'USER_UPLOADS',
]);

function parseBool(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function graphifyOutPath(projectPath) {
  return path.join(projectPath, 'graphify-out');
}

function graphifyGraphPath(projectPath) {
  return path.join(graphifyOutPath(projectPath), 'graph.json');
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function graphifyProjectInfo(projectPath) {
  const graphPath = graphifyGraphPath(projectPath);
  const outPath = graphifyOutPath(projectPath);
  const graphStat = safeStat(graphPath);
  const lockStat = safeStat(path.join(outPath, '.rebuild.lock'));
  const needsUpdateStat = safeStat(path.join(outPath, 'needs_update'));
  return {
    graphify_graph_path: graphPath,
    graphify_graph_exists: !!graphStat,
    graphify_graph_updated_at: graphStat ? graphStat.mtime.toISOString() : null,
    graphify_external_running: !!lockStat,
    graphify_needs_update: !!needsUpdateStat,
  };
}

function appendOutput(output, chunk) {
  const next = output + chunk.toString();
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

function outputTail(result) {
  const text = String(result.output || result.errorMessage || '').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join('\n');
}

function runProcess(bin, args, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, ...opts.env };

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, ...result });
    };
    const timer = setTimeout(() => {
      if (child) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
      finish({ ok: false, timedOut: true, errorMessage: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();

    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ ok: false, error: e, errorMessage: String(e && e.message) });
      return;
    }

    child.stdout.on('data', (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.on('error', (e) => {
      finish({ ok: false, error: e, errorMessage: String(e && e.message) });
    });
    child.on('close', (code, signal) => {
      finish({ ok: code === 0, code, signal });
    });
  });
}

function shouldIgnoreWatchFile(filename) {
  if (!filename) return false;
  const normalized = String(filename).replace(/\\/g, '/');
  if (!normalized || normalized === '.' || normalized.endsWith('~')) return true;
  if (normalized === 'AGENTS.md') return true;
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part) => IGNORED_WATCH_PARTS.has(part));
}

function graphifyChangeKind(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return SEMANTIC_EXTENSIONS.has(ext) ? 'semantic' : 'code';
}

function hasSemanticBackendEnv() {
  return Boolean(
    process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || process.env.MOONSHOT_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.DEEPSEEK_API_KEY
    || process.env.OLLAMA_BASE_URL
    || process.env.AWS_PROFILE
    || process.env.AWS_REGION
    || process.env.AWS_DEFAULT_REGION
    || process.env.AWS_ACCESS_KEY_ID,
  );
}

function codexProjectInstallPresent(projectPath) {
  const skill = path.join(projectPath, '.codex', 'skills', 'graphify', 'SKILL.md');
  const hooks = path.join(projectPath, '.codex', 'hooks.json');
  const agents = path.join(projectPath, 'AGENTS.md');
  if (!fs.existsSync(skill) || !fs.existsSync(hooks) || !fs.existsSync(agents)) return false;
  try {
    return fs.readFileSync(agents, 'utf8').toLowerCase().includes('graphify');
  } catch {
    return false;
  }
}

class GraphifyManager {
  constructor(db, opts) {
    opts = opts || {};
    this.db = db;
    this.bin = opts.bin || process.env.CC_GRAPHIFY_BIN || 'graphify';
    this.enabled = opts.enabled ?? parseBool(process.env.CC_GRAPHIFY_ENABLED, true);
    this.watchEnabled = opts.watch ?? parseBool(process.env.CC_GRAPHIFY_WATCH, true);
    this.bootstrapEnabled = opts.bootstrap ?? parseBool(process.env.CC_GRAPHIFY_BOOTSTRAP, true);
    this.alwaysInstall = opts.alwaysInstall ?? parseBool(process.env.CC_GRAPHIFY_INSTALL_EACH_RUN, false);
    this.semanticAuto = opts.semanticAuto ?? parseBool(process.env.CC_GRAPHIFY_SEMANTIC_AUTO, hasSemanticBackendEnv());
    this.debounceMs = opts.debounceMs ?? parsePositiveInt(process.env.CC_GRAPHIFY_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS);
    this.timeoutMs = opts.timeoutMs ?? parsePositiveInt(process.env.CC_GRAPHIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.extractTimeoutMs = opts.extractTimeoutMs ?? parsePositiveInt(process.env.CC_GRAPHIFY_EXTRACT_TIMEOUT_MS, this.timeoutMs);
    this.setupTimeoutMs = opts.setupTimeoutMs ?? parsePositiveInt(process.env.CC_GRAPHIFY_SETUP_TIMEOUT_MS, DEFAULT_SETUP_TIMEOUT_MS);
    this.logger = opts.logger || console;

    this.queue = [];
    this.queueSet = new Set();
    this.rerunIds = new Set();
    this.watchers = new Map();
    this.debounceTimers = new Map();
    this.runningId = null;
    this.shuttingDown = false;
  }

  syncProjects(projects, opts) {
    opts = opts || {};
    if (!this.enabled) {
      this.closeRemovedWatchers(new Set());
      for (const project of projects || []) {
        if (project.graphify_status !== 'disabled') {
          this.mark(project.id, { graphify_status: 'disabled' });
        }
      }
      return;
    }

    const ids = new Set((projects || []).filter((p) => this.projectEnabled(p)).map((p) => p.id));
    this.closeRemovedWatchers(ids);
    for (const project of projects || []) {
      if (!this.projectEnabled(project)) {
        this.disableQueuedProject(project.id);
        if (project.graphify_status !== 'disabled') {
          this.mark(project.id, { graphify_status: 'disabled' });
        }
        continue;
      }
      this.ensureWatcher(project);
      const shouldBootstrap = opts.bootstrap ?? this.bootstrapEnabled;
      if (shouldBootstrap && this.shouldBootstrap(project)) {
        this.enqueue(project.id, 'bootstrap', { immediate: true });
      } else if (!shouldBootstrap && ['queued', 'running'].includes(project.graphify_status)) {
        this.mark(project.id, {
          graphify_status: project.graphify_last_success_at ? 'stale' : 'pending',
          graphify_last_finished_at: this.db.now(),
        });
      }
    }
  }

  projectEnabled(project) {
    return !!project && project.archived !== 1 && project.graphify_enabled !== 0;
  }

  disableQueuedProject(projectId) {
    clearTimeout(this.debounceTimers.get(projectId));
    this.debounceTimers.delete(projectId);
    this.rerunIds.delete(projectId);
    this.queue = this.queue.filter((item) => item.id !== projectId);
    this.queueSet.delete(projectId);
    const watched = this.watchers.get(projectId);
    if (watched) {
      try {
        watched.watcher.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(projectId);
    }
  }

  closeRemovedWatchers(validIds) {
    for (const [id, entry] of this.watchers) {
      if (validIds.has(id)) continue;
      try {
        entry.watcher.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(id);
    }
  }

  shouldBootstrap(project) {
    if (!this.projectEnabled(project) || !fs.existsSync(project.path)) return false;
    if (!project.graphify_last_success_at) return true;
    const info = graphifyProjectInfo(project.path);
    if (!info.graphify_graph_exists || info.graphify_needs_update) return true;
    return ['pending', 'stale', 'queued', 'missing', 'error'].includes(project.graphify_status);
  }

  ensureWatcher(project) {
    if (!this.watchEnabled || !this.projectEnabled(project) || !fs.existsSync(project.path)) return;
    const existing = this.watchers.get(project.id);
    if (existing && existing.path === project.path) return;
    if (existing) {
      try {
        existing.watcher.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(project.id);
    }

    let watcher;
    try {
      watcher = fs.watch(project.path, { recursive: true }, (_eventType, filename) => {
        if (this.shuttingDown || shouldIgnoreWatchFile(filename)) return;
        if (graphifyChangeKind(filename) === 'semantic' && !this.semanticAuto) {
          this.markSemanticStale(project.id);
          return;
        }
        this.noteChanged(project.id, graphifyChangeKind(filename) === 'semantic' ? 'semantic-change' : 'file-change');
      });
    } catch (e) {
      if (this.logger && this.logger.warn) {
        this.logger.warn(`Graphify watch disabled for ${project.path}: ${String(e && e.message)}`);
      }
      return;
    }
    watcher.on('error', (e) => {
      if (this.logger && this.logger.warn) {
        this.logger.warn(`Graphify watch failed for ${project.path}: ${String(e && e.message)}`);
      }
    });
    this.watchers.set(project.id, { path: project.path, watcher });
  }

  noteChanged(projectId, reason) {
    if (!this.enabled || this.shuttingDown) return;
    const project = this.db.getProject(projectId);
    if (!this.projectEnabled(project)) return;
    const dirtyAt = this.db.now();
    if (this.runningId === projectId) {
      this.rerunIds.add(projectId);
      this.mark(projectId, { graphify_dirty_at: dirtyAt });
      return;
    }

    this.mark(projectId, {
      graphify_status: 'queued',
      graphify_dirty_at: dirtyAt,
      graphify_last_error: null,
    });
    clearTimeout(this.debounceTimers.get(projectId));
    const delay = Math.max(0, this.debounceMs);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(projectId);
      this.enqueue(projectId, reason, { immediate: true });
    }, delay);
    timer.unref();
    this.debounceTimers.set(projectId, timer);
  }

  markSemanticStale(projectId) {
    const project = this.db.getProject(projectId);
    if (!this.projectEnabled(project)) return;
    this.mark(projectId, {
      graphify_status: 'stale',
      graphify_dirty_at: this.db.now(),
      graphify_last_error: 'A doc, PDF, image, or media file changed. Set CC_GRAPHIFY_SEMANTIC_AUTO=true with a supported Graphify backend, or run Graphify semantic update from your coding agent.',
    });
  }

  enqueueByPath(projectPath, reason, opts) {
    const project = this.db.getProjectByPath(projectPath);
    if (this.projectEnabled(project)) this.enqueue(project.id, reason, opts);
  }

  enqueue(projectId, reason, opts) {
    opts = opts || {};
    if (!this.enabled) {
      this.mark(projectId, { graphify_status: 'disabled' });
      return;
    }
    if (this.shuttingDown) return;
    const current = this.db.getProject(projectId);
    if (!this.projectEnabled(current)) {
      this.disableQueuedProject(projectId);
      this.mark(projectId, { graphify_status: 'disabled' });
      return;
    }
    clearTimeout(this.debounceTimers.get(projectId));
    this.debounceTimers.delete(projectId);
    if (this.runningId === projectId) {
      this.rerunIds.add(projectId);
      this.mark(projectId, { graphify_dirty_at: this.db.now() });
      return;
    }
    if (!this.queueSet.has(projectId)) {
      this.queue.push({ id: projectId, reason: reason || 'manual' });
      this.queueSet.add(projectId);
    }
    const project = current;
    if (project && project.graphify_status !== 'running') {
      this.mark(projectId, {
        graphify_status: 'queued',
        graphify_last_error: null,
        graphify_dirty_at: project.graphify_dirty_at || this.db.now(),
      });
    }
    if (opts.immediate === false) return;
    setImmediate(() => this.drain());
  }

  mark(projectId, patch) {
    try {
      return this.db.updateProjectGraphify(projectId, patch);
    } catch (e) {
      if (this.logger && this.logger.warn) {
        this.logger.warn(`Graphify status update failed: ${String(e && e.message)}`);
      }
      return null;
    }
  }

  async drain() {
    if (this.runningId || this.shuttingDown) return;
    const next = this.queue.shift();
    if (!next) return;
    this.queueSet.delete(next.id);

    const project = this.db.getProject(next.id);
    if (!this.projectEnabled(project) || !fs.existsSync(project.path)) {
      if (project) {
        this.mark(project.id, {
          graphify_status: this.projectEnabled(project) ? 'error' : 'disabled',
          graphify_last_finished_at: this.db.now(),
          graphify_last_error: this.projectEnabled(project) ? `project path does not exist: ${project.path}` : null,
        });
      }
      setImmediate(() => this.drain());
      return;
    }

    this.runningId = project.id;
    try {
      await this.runProject(project, next.reason);
    } finally {
      const rerun = this.rerunIds.delete(project.id);
      this.runningId = null;
      if (rerun && !this.shuttingDown) this.enqueue(project.id, 'changed-during-run', { immediate: false });
      setImmediate(() => this.drain());
    }
  }

  async runProject(project, reason) {
    if (!this.projectEnabled(project)) {
      this.mark(project.id, { graphify_status: 'disabled' });
      return;
    }
    const startedAt = this.db.now();
    this.mark(project.id, {
      graphify_status: 'running',
      graphify_last_started_at: startedAt,
      graphify_last_finished_at: null,
      graphify_last_error: null,
    });

    const version = await this.runGraphify(project.path, ['--version'], { timeoutMs: this.setupTimeoutMs });
    if (!this.projectEnabled(this.db.getProject(project.id))) {
      this.mark(project.id, { graphify_status: 'disabled' });
      return;
    }
    if (!version.ok) {
      const missing = version.error && version.error.code === 'ENOENT';
      this.mark(project.id, {
        graphify_status: missing ? 'missing' : 'error',
        graphify_last_finished_at: this.db.now(),
        graphify_last_error: missing
          ? 'graphify CLI not found. Install with: uv tool install graphifyy (or pipx install graphifyy).'
          : this.failureMessage('graphify --version', version),
      });
      return;
    }

    const setupNeeded = this.alwaysInstall
      || !project.graphify_last_success_at
      || !codexProjectInstallPresent(project.path)
      || reason === 'project-created'
      || reason === 'project-updated'
      || reason === 'bootstrap';
    if (setupNeeded) {
      const install = await this.runGraphify(project.path, ['install', '--project', '--platform', 'codex'], { timeoutMs: this.setupTimeoutMs });
      if (!this.projectEnabled(this.db.getProject(project.id))) {
        this.mark(project.id, { graphify_status: 'disabled' });
        return;
      }
      if (!install.ok) {
        this.mark(project.id, {
          graphify_status: 'error',
          graphify_last_finished_at: this.db.now(),
          graphify_last_error: this.failureMessage('graphify install --project --platform codex', install),
        });
        return;
      }
    }

    let hookStatus = project.graphify_hook_status || null;
    let hookError = null;
    if (fs.existsSync(path.join(project.path, '.git'))) {
      const hook = await this.runGraphify(project.path, ['hook', 'install'], { timeoutMs: this.setupTimeoutMs });
      if (!this.projectEnabled(this.db.getProject(project.id))) {
        this.mark(project.id, { graphify_status: 'disabled' });
        return;
      }
      hookStatus = hook.ok ? 'installed' : 'error';
      if (!hook.ok) hookError = this.failureMessage('graphify hook install', hook);
    } else {
      hookStatus = 'not_git';
    }

    const semanticRun = this.semanticAuto && ['semantic-change', 'project-created', 'project-updated', 'bootstrap', 'manual'].includes(reason);
    const updateArgs = semanticRun ? ['extract', '.'] : ['update', '.'];
    const update = await this.runGraphify(project.path, updateArgs, {
      timeoutMs: semanticRun ? this.extractTimeoutMs : this.timeoutMs,
      env: {
        GRAPHIFY_NO_TIPS: '1',
        PYTHONHASHSEED: '0',
      },
    });
    const finishedAt = this.db.now();
    if (!this.projectEnabled(this.db.getProject(project.id))) {
      this.mark(project.id, { graphify_status: 'disabled', graphify_last_finished_at: finishedAt });
      return;
    }
    if (!update.ok) {
      this.mark(project.id, {
        graphify_status: 'error',
        graphify_last_finished_at: finishedAt,
        graphify_hook_status: hookStatus,
        graphify_last_error: this.failureMessage(`graphify ${updateArgs.join(' ')}`, update),
      });
      return;
    }

    this.mark(project.id, {
      graphify_status: 'current',
      graphify_last_finished_at: finishedAt,
      graphify_last_success_at: finishedAt,
      graphify_last_error: hookError,
      graphify_hook_status: hookStatus,
      graphify_dirty_at: null,
    });
  }

  disableProject(projectId, opts) {
    opts = opts || {};
    const project = this.db.getProject(projectId);
    this.disableQueuedProject(projectId);
    this.mark(projectId, {
      graphify_status: 'disabled',
      graphify_last_finished_at: this.db.now(),
      graphify_last_error: null,
      graphify_dirty_at: null,
    });
    if (!opts.uninstall || !project || !fs.existsSync(project.path)) return;
    setImmediate(() => {
      this.uninstallProjectGraphify(project).catch((e) => {
        this.mark(project.id, {
          graphify_last_error: `Graphify disabled, but cleanup failed: ${String(e && e.message)}`,
        });
      });
    });
  }

  async uninstallProjectGraphify(project) {
    const version = await this.runGraphify(project.path, ['--version'], { timeoutMs: this.setupTimeoutMs });
    if (!version.ok) return;

    if (fs.existsSync(path.join(project.path, '.git'))) {
      await this.runGraphify(project.path, ['hook', 'uninstall'], { timeoutMs: this.setupTimeoutMs });
    }
    await this.runGraphify(project.path, ['uninstall', '--project', '--platform', 'codex'], { timeoutMs: this.setupTimeoutMs });
  }

  runGraphify(cwd, args, opts) {
    return runProcess(this.bin, args, { cwd, ...opts });
  }

  failureMessage(step, result) {
    const code = result.timedOut ? 'timeout' : result.code != null ? `exit ${result.code}` : result.signal || 'failed';
    const tail = outputTail(result);
    return tail ? `${step} failed (${code}):\n${tail}` : `${step} failed (${code})`;
  }

  shutdown() {
    this.shuttingDown = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const entry of this.watchers.values()) {
      try {
        entry.watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.clear();
  }
}

module.exports = {
  GraphifyManager,
  graphifyGraphPath,
  graphifyOutPath,
  graphifyProjectInfo,
  shouldIgnoreWatchFile,
};
