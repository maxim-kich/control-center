'use strict';

/**
 * Codex CLI integration and local artifact discovery.
 *
 * The dashboard launches real interactive Codex TUI sessions only. It never uses
 * `codex exec`; the child process is always spawned through node-pty.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

function which(bin) {
  try {
    const out = execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${bin}`], { encoding: 'utf8' }).trim();
    return out || bin;
  } catch {
    return bin;
  }
}

const CODEX_BIN = process.env.CC_CODEX_BIN || which('codex');

function codexHome() {
  return resolveProjectPath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function codexSqliteHome() {
  return resolveProjectPath(process.env.CODEX_SQLITE_HOME || codexHome());
}

function stateDbPath() {
  return process.env.CC_CODEX_STATE_DB || path.join(codexSqliteHome(), 'state_5.sqlite');
}

function sessionsDir() {
  return path.join(codexHome(), 'sessions');
}

function codexVersion() {
  try {
    return execFileSync(CODEX_BIN, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const helpCache = new Map();
const HELP_TIMEOUT_MS = 1000;

function codexHelp(args = []) {
  const key = args.join('\0');
  if (helpCache.has(key)) return helpCache.get(key);
  try {
    const out = execFileSync(CODEX_BIN, [...args, '--help'], {
      encoding: 'utf8',
      timeout: HELP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    helpCache.set(key, out);
    return out;
  } catch {
    helpCache.set(key, null);
    return null;
  }
}

function codexSupportsFlag(flag) {
  const help = codexHelp();
  return !!(help && help.includes(flag));
}

let doctorCache = null;

function codexDoctor({ cacheMs = 30000 } = {}) {
  const now = Date.now();
  if (doctorCache && now - doctorCache.at < cacheMs) return doctorCache.report;
  try {
    const raw = execFileSync(CODEX_BIN, ['doctor', '--json'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const report = JSON.parse(raw);
    doctorCache = { at: now, report };
    return report;
  } catch {
    doctorCache = { at: now, report: null };
    return null;
  }
}

function codexAuthConfigured() {
  const report = codexDoctor();
  const auth = report && report.checks && report.checks['auth.credentials'];
  if (auth) return auth.status === 'ok';
  try {
    return fs.existsSync(path.join(codexHome(), 'auth.json'));
  } catch {
    return false;
  }
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveProjectPath(p, base) {
  if (!p) return p;
  let out = String(p).trim();
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  return path.resolve(base || process.cwd(), out);
}

function displayProjectName(p) {
  if (!p) return '';
  const resolved = resolveProjectPath(p);
  return path.basename(resolved) || resolved;
}

const PROJECT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.parcel-cache', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', 'vendor', 'target', '.gradle',
]);

function readDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !PROJECT_SKIP_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listProjects(root) {
  const out = [];
  for (const name of readDirs(root)) {
    const full = path.join(root, name);
    out.push(full);
    if (name.toUpperCase() === 'PROJECTS') {
      for (const child of readDirs(full)) out.push(path.join(full, child));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

const STRIP_ENV_EXACT = new Set([
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]);
const STRIP_ENV_PREFIX = [
  'CODEX_INTERNAL_',
  'CODEX_MANAGED_',
];
const KEEP_ENV = new Set([
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CODEX_ACCESS_TOKEN',
  'CODEX_CA_CERTIFICATE',
]);

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

function normalizeModel(model) {
  if (!model || /^claude-/i.test(String(model))) return 'gpt-5.5';
  return String(model).trim();
}

function normalizeEffort(effort) {
  if (effort === 'max') return 'xhigh';
  return ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'medium';
}

function promptForMode(prompt, mode) {
  const text = String(prompt || '');
  if (mode !== 'plan' || !text.trim()) return text;
  return text.trimStart().startsWith('/plan') ? text : `/plan ${text}`;
}

function taskOpeningPrompt(task) {
  const title = String((task && task.title) || '').trim();
  const description = String((task && task.description) || '').trim();
  return [title, description].filter(Boolean).join('\n\n');
}

function buildArgs({
  kind,
  sessionId,
  parentSessionId,
  cwd,
  prompt,
  model,
  effort,
  mode,
  skipPermissions,
  hookArgs = [],
  hookTrustFlag,
}) {
  const args = [];
  const normalizedModel = normalizeModel(model);
  const normalizedEffort = normalizeEffort(effort);

  if (kind === 'start') {
    // no subcommand
  } else if (kind === 'resume') {
    if (!sessionId) throw new Error('resume requires a session id');
    args.push('resume', sessionId);
  } else if (kind === 'fork') {
    if (!parentSessionId) throw new Error('fork requires a parent session id');
    args.push('fork', parentSessionId);
  } else {
    throw new Error(`unknown launch kind: ${kind}`);
  }

  if (cwd) args.push('-C', cwd);
  if (normalizedModel) args.push('--model', normalizedModel);
  args.push('-c', `model_reasoning_effort=${JSON.stringify(normalizedEffort)}`);
  args.push(...hookArgs);
  const useHookTrustFlag = hookArgs.length && (hookTrustFlag ?? codexSupportsFlag('--dangerously-bypass-hook-trust'));
  if (useHookTrustFlag) args.push('--dangerously-bypass-hook-trust');

  if (mode === 'build' && skipPermissions) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request');
  }

  if (kind === 'start') {
    const finalPrompt = promptForMode(prompt, mode);
    if (finalPrompt.trim()) args.push(finalPrompt);
  }
  return args;
}

function openStateDb() {
  const p = stateDbPath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function snapshotThreadIds() {
  const ids = new Set();
  const db = openStateDb();
  if (!db) return ids;
  try {
    for (const row of db.prepare('SELECT id FROM threads').all()) ids.add(row.id);
  } catch {
    /* ignore */
  } finally {
    try { db.close(); } catch {}
  }
  return ids;
}

function findNewThread({ cwd, knownIds, launchAtMs }) {
  const db = openStateDb();
  if (!db) return null;
  try {
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, title, source, model, reasoning_effort, created_at, created_at_ms, updated_at_ms
      FROM threads
      WHERE cwd = ?
      ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC
      LIMIT 20
    `).all(cwd);
    const cutoff = Number(launchAtMs || 0) - 5000;
    return rows.find((r) => !knownIds.has(r.id) && Number(r.created_at_ms || r.created_at * 1000 || 0) >= cutoff) || null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

function getThread(sessionId) {
  if (!sessionId) return null;
  const db = openStateDb();
  if (!db) return null;
  try {
    return db.prepare(`
      SELECT id, rollout_path, cwd, title, source, model, reasoning_effort, created_at, created_at_ms, updated_at_ms
      FROM threads WHERE id = ?
    `).get(sessionId) || null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

function listRollouts(dir = sessionsDir()) {
  const out = [];
  function walk(cur) {
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function readSessionMeta(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.type === 'session_meta' && o.payload) return o.payload;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function findNewRollout({ cwd, knownPaths, launchAtMs }) {
  const cutoff = Number(launchAtMs || 0) - 5000;
  const candidates = [];
  for (const p of listRollouts()) {
    if (knownPaths && knownPaths.has(p)) continue;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    const meta = readSessionMeta(p);
    if (meta && meta.cwd === cwd && meta.id) {
      candidates.push({ id: meta.id, rollout_path: p, cwd: meta.cwd, created_at_ms: Date.parse(meta.timestamp || '') || st.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.created_at_ms - a.created_at_ms);
  return candidates[0] || null;
}

function snapshotRolloutPaths() {
  return new Set(listRollouts());
}

function watchForNewSession({ cwd, knownThreadIds, knownRolloutPaths, launchAtMs, timeoutMs = 30000, intervalMs = 400, isCancelled } = {}) {
  const knownIds = knownThreadIds || snapshotThreadIds();
  const knownPaths = knownRolloutPaths || snapshotRolloutPaths();
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (isCancelled && isCancelled()) return resolve(null);
      const row = findNewThread({ cwd, knownIds, launchAtMs });
      if (row) return resolve({ session_id: row.id, transcript_path: row.rollout_path, cwd: row.cwd, source: 'threads' });
      const rollout = findNewRollout({ cwd, knownPaths, launchAtMs });
      if (rollout) return resolve({ session_id: rollout.id, transcript_path: rollout.rollout_path, cwd: rollout.cwd, source: 'rollout' });
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, intervalMs).unref();
    };
    tick();
  });
}

function findTranscriptPath(sessionId) {
  const row = getThread(sessionId);
  if (row && row.rollout_path && fs.existsSync(row.rollout_path)) return row.rollout_path;
  for (const p of listRollouts()) {
    const meta = readSessionMeta(p);
    if (meta && meta.id === sessionId) return p;
  }
  return null;
}

function getSpawnedAgents(parentSessionId) {
  if (!parentSessionId) return [];
  const db = openStateDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT e.child_thread_id AS id, e.status, t.title, t.model, t.reasoning_effort, t.rollout_path, t.cwd
      FROM thread_spawn_edges e
      LEFT JOIN threads t ON t.id = e.child_thread_id
      WHERE e.parent_thread_id = ?
      ORDER BY t.created_at_ms ASC, e.child_thread_id ASC
    `).all(parentSessionId);
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

module.exports = {
  CODEX_BIN,
  which,
  codexHome,
  codexSqliteHome,
  stateDbPath,
  sessionsDir,
  codexVersion,
  codexSupportsFlag,
  codexDoctor,
  codexAuthConfigured,
  safeIsDir,
  resolveProjectPath,
  displayProjectName,
  listProjects,
  buildEnv,
  normalizeModel,
  normalizeEffort,
  promptForMode,
  taskOpeningPrompt,
  buildArgs,
  snapshotThreadIds,
  snapshotRolloutPaths,
  watchForNewSession,
  findTranscriptPath,
  getThread,
  getSpawnedAgents,
};
