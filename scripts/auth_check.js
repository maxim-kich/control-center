'use strict';

// Optional Codex auth diagnostic. By default this only reads `codex doctor`.
// Set CC_REAL_CODEX=1 to launch a tiny real interactive Codex TUI probe.

require('../lib/ensurePty').ensureSpawnHelper();
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codex = require('../lib/codex');
const { buildHookArgs } = require('../lib/hooksSettings');
const { parseTranscript } = require('../lib/transcript');

const cwd = codex.resolveProjectPath(process.env.CC_AUTH_PROJECT || process.cwd());

const report = codex.codexDoctor();
const auth = report && report.checks && report.checks['auth.credentials'];
console.log('codex:', codex.CODEX_BIN, codex.codexVersion() || '(not found)');
console.log('auth:', auth ? `${auth.status} — ${auth.summary}` : codex.codexAuthConfigured() ? 'configured' : 'not configured');
console.log('state DB:', codex.stateDbPath());

if (process.env.CC_REAL_CODEX !== '1') {
  console.log('Real Codex launch skipped. Set CC_REAL_CODEX=1 to run the interactive smoke probe.');
  process.exit(0);
}

const launchAtMs = Date.now();
const knownThreadIds = codex.snapshotThreadIds();
const knownRolloutPaths = codex.snapshotRolloutPaths();
const args = codex.buildArgs({
  kind: 'start',
  cwd,
  prompt: 'Reply with the single word PONG and nothing else. Do not use tools.',
  model: process.env.CC_AUTH_MODEL || 'gpt-5.4-mini',
  effort: 'low',
  mode: 'build',
  skipPermissions: false,
  hookArgs: buildHookArgs(process.execPath),
});
const env = codex.buildEnv({
  CC_TASK_ID: 'auth-check',
  CC_SESSION_KIND: 'start',
  CC_DB_PATH: path.join(os.tmpdir(), 'codex-dashboard-authcheck-no-db.sqlite'),
  CC_HAS_PROMPT: '1',
  CC_LAUNCH_AT: new Date(launchAtMs).toISOString(),
  CC_LAUNCH_AT_MS: String(launchAtMs),
});

console.log('launching:', codex.CODEX_BIN, args.slice(0, 8).join(' '), '...');
const proc = pty.spawn(codex.CODEX_BIN, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env });
let out = '';
proc.onData((d) => { out += d; });

const deadline = Date.now() + 90000;
const tick = async () => {
  const captured = await codex.watchForNewSession({
    cwd,
    knownThreadIds,
    knownRolloutPaths,
    launchAtMs,
    timeoutMs: 1000,
  });
  if (captured || Date.now() >= deadline) {
    let assistant = '';
    if (captured && captured.transcript_path && fs.existsSync(captured.transcript_path)) {
      try {
        const parsed = parseTranscript(captured.transcript_path);
        assistant = parsed.events
          .filter((e) => e.role === 'assistant')
          .flatMap((e) => e.blocks)
          .filter((b) => b.kind === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
      } catch {
        /* ignore */
      }
    }
    console.log('\n--- AUTH CHECK RESULT ---');
    console.log('captured:', captured ? captured.session_id : 'no');
    console.log('transcript:', captured && captured.transcript_path ? captured.transcript_path : '(not found)');
    console.log('assistant reply:', JSON.stringify(assistant.slice(0, 120)));
    console.log('terminal head:', JSON.stringify(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 160)));
    try { proc.kill(); } catch {}
    setTimeout(() => process.exit(assistant ? 0 : 1), 500);
    return;
  }
  setTimeout(tick, 1000).unref();
};

tick().catch((err) => {
  console.error(err);
  try { proc.kill(); } catch {}
  process.exit(1);
});
