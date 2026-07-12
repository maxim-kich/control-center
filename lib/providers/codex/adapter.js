'use strict';

const { execFile } = require('child_process');
const codex = require('../../codex');
const transcript = require('../../transcript');

const MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
];

function runGraphifyCommand(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = String(stderr || stdout || '');
      if (error) {
        resolve({
          ok: false,
          error: output.trim() || error.message,
          code: error.code,
          output,
        });
        return;
      }
      resolve({ ok: true, output });
    });
  });
}

const adapter = {
  id: 'codex',
  name: 'Codex',
  launchSupported: true,
  supports: {
    autoMode: false,
    planMode: true,
    bypassPermissions: true,
    ultracode: false,
    preGeneratedSessionId: false,
    dynamicWorkflow: false,
    graphifyMcp: false,
  },

  detect(opts = {}) {
    const codexModule = opts.codexModule || codex;
    const bin = opts.codexBin || codexModule.CODEX_BIN;
    const version = opts.codexVersion !== undefined ? opts.codexVersion : codexModule.codexVersion();
    const installed = !!version;
    const connected = installed && (opts.codexConnected !== undefined ? !!opts.codexConnected : !!codexModule.codexAuthConfigured());
    return {
      id: adapter.id,
      name: adapter.name,
      kind: 'cli',
      bin,
      version,
      installed,
      connected,
      status: !installed ? 'missing' : connected ? 'connected' : 'needs_auth',
      auth: { configured: connected, method: connected ? 'codex credentials' : 'none' },
      setup: installed
        ? { title: 'Sign in to Codex', command: 'codex login', actionLabel: 'Copy command' }
        : { title: 'Install Codex CLI', command: 'npm install -g @openai/codex', actionLabel: 'Copy command' },
      launchSupported: adapter.launchSupported,
      supports: adapter.supports,
      models: MODELS,
      modes: adapter.modes(),
      defaultModel: adapter.defaultModel(),
    };
  },

  defaultModel() {
    return 'gpt-5.6-sol';
  },

  models() {
    return MODELS;
  },

  modes() {
    return ['build', 'plan'];
  },

  normalizeTaskSettings(task) {
    const mode = task.mode === 'plan' ? 'plan' : 'build';
    return {
      ...task,
      provider: adapter.id,
      model: codex.normalizeModel(task.model),
      effort: codex.normalizeEffort(task.effort),
      mode,
      yolo: mode === 'build' ? task.yolo : 0,
      ultracode: 0,
    };
  },

  taskOpeningPrompt: codex.taskOpeningPrompt,
  resolveProjectPath: codex.resolveProjectPath,
  safeIsDir: codex.safeIsDir,
  buildEnv: codex.buildEnv,
  buildLaunchArgs: codex.buildArgs,
  findTranscript: codex.findTranscriptPath,
  parseTranscript: transcript.parseTranscript,
  streamCounts: transcript.streamCounts,

  async setupExtension({ extension, project, integration, action, graphifyBin, setupNeeded = true, timeoutMs } = {}) {
    const id = extension && extension.id;
    if (id !== 'graphify' && integration !== 'graphify') return { ok: true, skipped: true, reason: 'unsupported extension setup' };
    const projectPath = codex.resolveProjectPath(project && project.path ? project.path : project);
    if (!codex.safeIsDir(projectPath)) return { ok: false, error: `project path does not exist: ${projectPath}` };
    const bin = graphifyBin || process.env.CC_GRAPHIFY_BIN || 'graphify';
    if (action === 'cleanup') {
      return runGraphifyCommand(bin, ['uninstall', '--project', '--platform', 'codex'], { cwd: projectPath, timeoutMs });
    }
    if (!setupNeeded) return { ok: true, skipped: true };
    return runGraphifyCommand(bin, ['install', '--project', '--platform', 'codex'], { cwd: projectPath, timeoutMs });
  },

  buildLaunch({ task, kind, sessionId, parentSessionId, prompt, context }) {
    const cwd = codex.resolveProjectPath(task.project_path);
    const launchAtMs = Date.now();
    const knownThreadIds = codex.snapshotThreadIds();
    const knownRolloutPaths = codex.snapshotRolloutPaths();
    const hasPrompt = kind === 'start' && prompt && String(prompt).trim();
    const env = codex.buildEnv({
      CC_TASK_ID: task.id,
      CC_DB_PATH: context.dbPath,
      CC_SESSION_KIND: kind,
      CC_LAUNCH_AT: new Date(launchAtMs).toISOString(),
      CC_LAUNCH_AT_MS: String(launchAtMs),
      ...(parentSessionId ? { CC_PARENT_SESSION_ID: parentSessionId } : {}),
      ...(hasPrompt ? { CC_HAS_PROMPT: '1' } : {}),
    });
    const args = codex.buildArgs({
      kind,
      sessionId,
      parentSessionId,
      cwd,
      prompt,
      model: task.model,
      effort: task.effort,
      mode: task.mode,
      skipPermissions: task.yolo == null ? context.yolo : !!task.yolo,
      hookArgs: context.hookArgs,
    });
    return {
      provider: adapter.id,
      file: codex.CODEX_BIN,
      args,
      cwd,
      env,
      launchAtMs,
      knownThreadIds,
      knownRolloutPaths,
      sessionId,
    };
  },

  onLaunch({ task, kind, sessionId, parentSessionId, launch, runner, db }) {
    if (kind === 'resume') {
      db.upsertSession({
        session_id: sessionId,
        provider: adapter.id,
        task_id: task.id,
        kind,
        transcript_path: codex.findTranscriptPath(sessionId),
        cwd: launch.cwd,
        name: task.title,
      });
      return;
    }

    if (kind !== 'start' && kind !== 'fork') return;
    codex
      .watchForNewSession({
        cwd: launch.cwd,
        knownThreadIds: launch.knownThreadIds,
        knownRolloutPaths: launch.knownRolloutPaths,
        launchAtMs: launch.launchAtMs,
        timeoutMs: 30000,
        isCancelled: () => runner.cancelled,
      })
      .then((captured) => {
        if (!captured || !captured.session_id) return;
        const fresh = db.getTask(task.id);
        if (!fresh) return;
        if (fresh.session_id && fresh.session_id !== captured.session_id) return;
        db.upsertSession({
          session_id: captured.session_id,
          provider: adapter.id,
          task_id: task.id,
          kind,
          parent_session_id: parentSessionId || null,
          transcript_path: captured.transcript_path || codex.findTranscriptPath(captured.session_id),
          cwd: captured.cwd || launch.cwd,
          name: task.title,
          source: captured.source,
        });
        db.updateTask(task.id, { session_id: captured.session_id, status: 'in_progress' });
        runner.notify({ t: 'session', sessionId: captured.session_id });
      })
      .catch(() => {});
  },
};

module.exports = adapter;
