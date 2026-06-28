'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('codex buildArgs maps task settings to interactive CLI args', () => {
  const codex = require('../lib/codex');
  const args = codex.buildArgs({
    kind: 'start',
    cwd: '/repo',
    prompt: 'do it',
    model: 'gpt-5.4',
    effort: 'high',
    mode: 'build',
    skipPermissions: true,
    hookArgs: ['-c', 'hooks.Stop=[]'],
    hookTrustFlag: true,
  });
  assert.deepEqual(args, [
    '-C', '/repo',
    '--model', 'gpt-5.4',
    '-c', 'model_reasoning_effort="high"',
    '-c', 'hooks.Stop=[]',
    '--dangerously-bypass-hook-trust',
    '--dangerously-bypass-approvals-and-sandbox',
    'do it',
  ]);

  const plan = codex.buildArgs({
    kind: 'start',
    cwd: '/repo',
    prompt: 'think first',
    model: 'claude-opus-4-8',
    effort: 'max',
    mode: 'plan',
    skipPermissions: true,
  });
  assert.equal(plan[plan.length - 1], '/plan think first');
  assert.ok(plan.includes('gpt-5.5'));
  assert.ok(plan.includes('model_reasoning_effort="xhigh"'));
  assert.ok(!plan.includes('--dangerously-bypass-approvals-and-sandbox'));

  const resume = codex.buildArgs({
    kind: 'resume',
    sessionId: 'sess',
    cwd: '/repo',
    model: 'gpt-5.5',
    effort: 'low',
    mode: 'build',
    skipPermissions: false,
  });
  assert.deepEqual(resume.slice(0, 2), ['resume', 'sess']);
  assert.ok(resume.includes('--sandbox'));
  assert.ok(resume.includes('--ask-for-approval'));
  assert.ok(!resume.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('codex buildArgs skips hook trust flag when selected CLI does not support it', () => {
  const codex = require('../lib/codex');
  const args = codex.buildArgs({
    kind: 'resume',
    sessionId: 'sess',
    cwd: '/repo',
    model: 'gpt-5.5',
    effort: 'low',
    mode: 'build',
    skipPermissions: true,
    hookArgs: ['-c', 'hooks.Stop=[]'],
    hookTrustFlag: false,
  });
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('hooks.Stop=[]'));
  assert.ok(!args.includes('--dangerously-bypass-hook-trust'));
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('codex taskOpeningPrompt uses title as the prompt base and description as additive context', () => {
  const codex = require('../lib/codex');
  assert.equal(codex.taskOpeningPrompt({ title: 'Fix login', description: '' }), 'Fix login');
  assert.equal(
    codex.taskOpeningPrompt({ title: 'Fix login', description: 'Use the auth fixture.\n\nContext files (in USER_UPLOADS):\n- USER_UPLOADS/auth.log' }),
    'Fix login\n\nUse the auth fixture.\n\nContext files (in USER_UPLOADS):\n- USER_UPLOADS/auth.log',
  );
});

test('codex buildEnv scrubs parent/session and API-key variables but keeps Codex home', () => {
  const codex = require('../lib/codex');
  process.env.CODEX_THREAD_ID = 'parent';
  process.env.CODEX_CI = '1';
  process.env.CODEX_API_KEY = 'secret';
  process.env.OPENAI_API_KEY = 'secret';
  process.env.CODEX_HOME = '/tmp/codex-home';
  const env = codex.buildEnv({ CC_TASK_ID: 'task' });
  assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.CODEX_CI, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, '/tmp/codex-home');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.CC_TASK_ID, 'task');
});

test('codex displayProjectName returns folder basenames', () => {
  const codex = require('../lib/codex');
  assert.equal(codex.displayProjectName('/Users/me/Documents/cli-workbench'), 'cli-workbench');
  assert.equal(codex.displayProjectName('/Users/me/Documents/cli-workbench/CONTROL_CENTER/'), 'CONTROL_CENTER');
});

test('SessionManager captures a fake Codex session id from state DB and rollout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-test-'));
  const project = path.join(tmp, 'project');
  const codexHome = path.join(tmp, 'codex-home');
  const dbPath = path.join(tmp, 'tasks.db');
  const stateDb = path.join(codexHome, 'state_5.sqlite');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const fake = path.join(tmp, 'fake-codex.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const args = process.argv.slice(2);
const cwd = args[args.indexOf('-C') + 1] || process.cwd();
const id = crypto.randomUUID();
const home = process.env.CODEX_HOME;
const rolloutDir = path.join(home, 'sessions', '2026', '06', '27');
fs.mkdirSync(rolloutDir, { recursive: true });
const rollout = path.join(rolloutDir, 'rollout-2026-06-27T00-00-00-' + id + '.jsonl');
fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, timestamp: new Date().toISOString(), cwd, cli_version: 'fake' } }) + '\\n');
const db = new Database(process.env.CC_CODEX_STATE_DB);
db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, model TEXT, reasoning_effort TEXT, created_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER); CREATE TABLE IF NOT EXISTS thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);');
const ms = Date.now();
db.prepare('INSERT INTO threads (id, rollout_path, cwd, title, source, model, reasoning_effort, created_at, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, rollout, cwd, 'fake', 'cli', 'gpt-5.5', 'low', Math.floor(ms / 1000), ms, ms);
db.close();
console.log('fake codex session ' + id);
setTimeout(() => process.exit(0), 1500);
`);
  fs.chmodSync(fake, 0o755);

  process.env.CC_CODEX_BIN = fake;
  process.env.CODEX_HOME = codexHome;
  process.env.CC_CODEX_STATE_DB = stateDb;
  process.env.CC_DB_PATH = dbPath;

  for (const mod of ['../lib/codex', '../lib/db', '../lib/sessionRunner']) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch {
      /* ignore */
    }
  }

  const db = require('../lib/db');
  const { SessionManager } = require('../lib/sessionRunner');
  const manager = new SessionManager();
  manager.configure({ hookArgs: [], dbPath, yolo: true });
  const task = db.createTask({
    title: 'fake',
    description: 'hello',
    project_path: project,
    model: 'gpt-5.5',
    effort: 'low',
    mode: 'build',
    yolo: 1,
  });
  db.updateTask(task.id, { status: 'in_progress', started_at: db.now() });
  manager.launch({ task: db.getTask(task.id), kind: 'start', prompt: 'hello' });

  const deadline = Date.now() + 5000;
  let fresh = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    fresh = db.getTask(task.id);
    if (fresh.session_id) break;
  }
  manager.shutdown();
  assert.ok(fresh && fresh.session_id, 'session id should be captured');
  const session = db.getSession(fresh.session_id);
  assert.ok(session.transcript_path.endsWith('.jsonl'));
  assert.equal(session.cwd, project);
});
