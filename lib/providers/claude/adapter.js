'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('../../core/paths');
const claudeTranscript = require('./transcript');
const { ensureSettingsFile, ensureGraphMcpConfig } = require('./hooks/settings');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_BIN = process.env.CC_CLAUDE_BIN || which('claude');
const PYTHON_BIN = process.env.CC_PYTHON || which('python3');

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

function which(bin) {
  try {
    const out = execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${bin}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || bin;
  } catch {
    return bin;
  }
}

function runCommand(file, args, opts = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs || 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout || ''), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: e && e.stdout ? String(e.stdout) : '',
      stderr: e && e.stderr ? String(e.stderr) : '',
      errorMessage: e && e.message ? String(e.message) : 'command failed',
    };
  }
}

function firstVersionLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || null;
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function claudeVersion() {
  const result = runCommand(CLAUDE_BIN, ['--version'], { timeoutMs: 8000 });
  return result.ok ? firstVersionLine(result.stdout || result.stderr) : null;
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveProjectPath(p, base) {
  return paths.resolvePath(p, base);
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function graphifyMcpBin() {
  const cand = which('graphify-mcp');
  if (cand && path.isAbsolute(cand) && isExecutable(cand)) return cand;
  for (const f of [
    path.join(os.homedir(), '.local', 'bin', 'graphify-mcp'),
    path.join(os.homedir(), '.local', 'share', 'uv', 'tools', 'graphifyy', 'bin', 'graphify-mcp'),
  ]) {
    if (isExecutable(f)) return f;
  }
  return null;
}

const PROJECT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.parcel-cache', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', 'vendor', 'target', '.gradle',
]);

function resolveGraphRoot(projectDir) {
  if (!projectDir) return projectDir;
  if (safeIsFile(path.join(projectDir, 'graphify-out', 'graph.json'))) return projectDir;
  let entries = [];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return projectDir;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || PROJECT_SKIP_DIRS.has(e.name)) continue;
    if (safeIsFile(path.join(projectDir, e.name, 'graphify-out', 'graph.json'))) {
      return path.join(projectDir, e.name);
    }
  }
  return projectDir;
}

function graphJsonFor(projectDir) {
  const graphPath = path.join(resolveGraphRoot(projectDir), 'graphify-out', 'graph.json');
  return safeIsFile(graphPath) ? graphPath : null;
}

const STRIP_ENV_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_EFFORT',
]);
const STRIP_ENV_PREFIX = ['CLAUDE_CODE_SDK_'];
const KEEP_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

function buildEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP_ENV.has(k)) {
      env[k] = v;
      continue;
    }
    if (STRIP_ENV_EXACT.has(k)) continue;
    if (STRIP_ENV_PREFIX.some((prefix) => k.startsWith(prefix))) continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return { ...env, ...extra };
}

function modelSupportsAuto(model) {
  const re = new RegExp(process.env.CC_AUTO_UNSUPPORTED || 'haiku', 'i');
  return !re.test(String(model || ''));
}

function buildLaunchArgs({ kind, sessionId, parentSessionId, name, prompt, settingsPath, mcpConfigPath, model, effort, mode, skipPermissions, ultracode }) {
  const args = [];
  if (kind === 'start') {
    if (!sessionId) throw new Error('start requires a pre-generated Claude session id');
    args.push('--session-id', sessionId);
  } else if (kind === 'resume') {
    if (!sessionId) throw new Error('resume requires a session id');
    args.push('--resume', sessionId);
  } else if (kind === 'fork') {
    if (!parentSessionId) throw new Error('fork requires a parent session id');
    args.push('--resume', parentSessionId, '--fork-session');
  } else {
    throw new Error(`unknown launch kind: ${kind}`);
  }

  if (name) args.push('--name', name);
  if (settingsPath) args.push('--settings', settingsPath);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', normalizeEffort(effort));
  if (mode === 'plan') args.push('--permission-mode', 'plan');
  else if (mode === 'auto' && modelSupportsAuto(model)) args.push('--permission-mode', 'auto');
  else if (skipPermissions) args.push('--permission-mode', 'bypassPermissions');

  if (kind === 'start' && prompt && String(prompt).trim()) {
    const finalPrompt = ultracode ? `${prompt}\n\nultracode` : prompt;
    args.push('--', finalPrompt);
  }
  return args;
}

function listAllTranscripts() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) out.push({ dir, file, sessionId: file.slice(0, -'.jsonl'.length), path: path.join(dir, file) });
    }
  }
  return out;
}

function findTranscript(sessionId) {
  if (!sessionId) return null;
  const hit = listAllTranscripts().find((t) => t.sessionId === sessionId);
  return hit ? hit.path : null;
}

function findProjectDir(sessionId) {
  const transcriptPath = findTranscript(sessionId);
  return transcriptPath ? path.dirname(transcriptPath) : null;
}

function listSessionIdsInDir(projectDir) {
  const ids = new Set();
  if (!projectDir) return ids;
  let files = [];
  try {
    files = fs.readdirSync(projectDir);
  } catch {
    return ids;
  }
  for (const file of files) {
    if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length));
  }
  return ids;
}

function watchForNewSession(projectDir, knownIds, { timeoutMs = 20000, intervalMs = 400, isCancelled } = {}) {
  return new Promise((resolve) => {
    if (!projectDir) return resolve(null);
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (isCancelled && isCancelled()) return resolve(null);
      const current = listSessionIdsInDir(projectDir);
      for (const id of current) {
        if (!knownIds.has(id)) return resolve(id);
      }
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, intervalMs).unref();
    };
    tick();
  });
}

function normalizeEffort(effort) {
  if (effort === 'xhigh') return 'max';
  return ['low', 'medium', 'high', 'max'].includes(effort) ? effort : 'medium';
}

function maybeGraphMcpConfig(task, cwd, db) {
  if (!adapter.supports.graphifyMcp) return null;
  const mcpCommand = graphifyMcpBin();
  if (!mcpCommand) return null;
  const project = task.project_id ? db.getProject(task.project_id) : null;
  const enabled = project ? project.graphify_enabled !== 0 : true;
  if (!enabled) return null;
  const graphPath = graphJsonFor(cwd);
  return graphPath ? ensureGraphMcpConfig(mcpCommand, graphPath) : null;
}

const adapter = {
  id: 'claude',
  name: 'Claude',
  launchSupported: true,
  supports: {
    autoMode: true,
    planMode: true,
    bypassPermissions: true,
    ultracode: true,
    preGeneratedSessionId: true,
    dynamicWorkflow: true,
    graphifyMcp: true,
  },

  detect(opts = {}) {
    const run = opts.runCommand || runCommand;
    const bin = opts.claudeBin || (opts.codexModule && opts.codexModule.which ? opts.codexModule.which('claude') : CLAUDE_BIN);
    const versionResult = opts.claudeVersionResult || run(bin, ['--version'], { timeoutMs: 8000 });
    const version = firstVersionLine(versionResult.stdout || versionResult.stderr);
    const installed = !!(versionResult.ok && version);
    let authPayload = null;
    if (installed) {
      const authResult = opts.claudeAuthResult || run(bin, ['auth', 'status'], { timeoutMs: 8000 });
      authPayload = parseJsonObject((authResult.stdout || '') + '\n' + (authResult.stderr || ''));
    }
    const connected = !!(authPayload && authPayload.loggedIn);
    return {
      id: adapter.id,
      name: adapter.name,
      kind: 'cli',
      bin,
      version,
      installed,
      connected,
      status: !installed ? 'missing' : connected ? 'connected' : 'needs_auth',
      auth: {
        configured: connected,
        method: authPayload && authPayload.authMethod ? authPayload.authMethod : 'none',
        provider: authPayload && authPayload.apiProvider ? authPayload.apiProvider : null,
      },
      setup: installed
        ? { title: 'Sign in to Claude Code', command: 'claude auth login', actionLabel: 'Copy command' }
        : { title: 'Install Claude Code', command: 'npm install -g @anthropic-ai/claude-code', actionLabel: 'Copy command' },
      launchSupported: adapter.launchSupported,
      supports: adapter.supports,
      models: MODELS,
      modes: adapter.modes(),
      defaultModel: adapter.defaultModel(),
    };
  },

  defaultModel() {
    return 'claude-opus-4-8';
  },

  models() {
    return MODELS;
  },

  modes() {
    return ['build', 'auto', 'plan'];
  },

  normalizeTaskSettings(task) {
    const mode = adapter.modes().includes(task.mode) ? task.mode : 'build';
    return {
      ...task,
      provider: adapter.id,
      model: task.model || adapter.defaultModel(),
      effort: ['low', 'medium', 'high', 'xhigh'].includes(task.effort) ? task.effort : 'medium',
      mode,
      yolo: mode === 'build' ? task.yolo : 0,
      ultracode: task.ultracode ? 1 : 0,
    };
  },

  resolveProjectPath,
  safeIsDir,
  buildEnv,
  buildLaunchArgs,
  findTranscript,
  parseTranscript: claudeTranscript.parseTranscript,
  streamCounts: claudeTranscript.streamCounts,
  taskOpeningPrompt(task) {
    const title = String((task && task.title) || '').trim();
    const description = String((task && task.description) || '').trim();
    return [title, description].filter(Boolean).join('\n\n');
  },

  buildLaunch({ task, kind, sessionId, parentSessionId, prompt, context }) {
    const cwd = resolveProjectPath(task.project_path);
    const preGeneratedSessionId = kind === 'start' ? (sessionId || crypto.randomUUID()) : sessionId;
    const settingsPath = ensureSettingsFile(PYTHON_BIN);
    const mcpConfigPath = maybeGraphMcpConfig(task, cwd, context.db);
    const hasPrompt = kind === 'start' && prompt && String(prompt).trim();
    let forkWatch = null;
    if (kind === 'fork' && parentSessionId) {
      const projectDir = findProjectDir(parentSessionId);
      forkWatch = { projectDir, knownIds: listSessionIdsInDir(projectDir) };
    }
    const env = buildEnv({
      CC_TASK_ID: task.id,
      CC_DB_PATH: context.dbPath,
      CC_SESSION_KIND: kind,
      ...(parentSessionId ? { CC_PARENT_SESSION_ID: parentSessionId } : {}),
      ...(hasPrompt ? { CC_HAS_PROMPT: '1' } : {}),
    });
    const args = buildLaunchArgs({
      kind,
      sessionId: preGeneratedSessionId,
      parentSessionId,
      name: task.title,
      prompt,
      settingsPath,
      mcpConfigPath,
      model: task.model,
      effort: task.effort,
      mode: task.mode,
      skipPermissions: task.yolo == null ? context.yolo : !!task.yolo,
      ultracode: !!task.ultracode,
    });
    return {
      provider: adapter.id,
      file: CLAUDE_BIN,
      args,
      cwd,
      env,
      sessionId: preGeneratedSessionId,
      forkWatch,
    };
  },

  onLaunch({ task, kind, sessionId, parentSessionId, launch, runner, db }) {
    if (kind === 'start' || kind === 'resume') {
      db.upsertSession({
        session_id: sessionId,
        provider: adapter.id,
        task_id: task.id,
        kind,
        transcript_path: findTranscript(sessionId),
        cwd: launch.cwd,
        name: task.title,
      });
      db.updateTask(task.id, { session_id: sessionId, status: 'in_progress' });
      runner.notify({ t: 'session', sessionId });
      return;
    }

    if (kind !== 'fork' || !launch.forkWatch) return;
    watchForNewSession(launch.forkWatch.projectDir, launch.forkWatch.knownIds, {
      timeoutMs: 20000,
      isCancelled: () => runner.cancelled,
    })
      .then((newId) => {
        if (!newId) return;
        const fresh = db.getTask(task.id);
        if (!fresh || fresh.session_id) return;
        db.upsertSession({
          session_id: newId,
          provider: adapter.id,
          task_id: task.id,
          kind: 'fork',
          parent_session_id: parentSessionId,
          transcript_path: findTranscript(newId),
          cwd: launch.cwd,
          name: task.title,
        });
        db.updateTask(task.id, { session_id: newId, status: 'in_progress' });
        runner.notify({ t: 'session', sessionId: newId });
      })
      .catch(() => {});
  },
};

module.exports = adapter;
