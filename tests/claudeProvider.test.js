'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadClaudeAdapter(home) {
  process.env.CONTROL_CENTER_HOME = home;
  for (const mod of [
    '../lib/core/paths',
    '../lib/providers/claude/hooks/settings',
    '../lib/providers/claude/adapter',
  ]) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch {
      /* ignore */
    }
  }
  return require('../lib/providers/claude/adapter');
}

test('claude buildEnv strips API and parent-session credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-env-'));
  const claude = loadClaudeAdapter(home);
  process.env.ANTHROPIC_API_KEY = 'secret';
  process.env.ANTHROPIC_AUTH_TOKEN = 'secret';
  process.env.CLAUDE_CODE_SESSION_ID = 'parent';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth';
  const env = claude.buildEnv({ CC_TASK_ID: 'task-1' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.CC_TASK_ID, 'task-1');
  assert.equal(env.TERM, 'xterm-256color');
  fs.rmSync(home, { recursive: true, force: true });
});

test('claude buildLaunch uses pre-generated session ids and generated settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-launch-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-project-'));
  const claude = loadClaudeAdapter(home);
  const launch = claude.buildLaunch({
    task: {
      id: 'task-1',
      title: 'Ship it',
      project_path: project,
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      mode: 'auto',
      yolo: 1,
      ultracode: 1,
    },
    kind: 'start',
    prompt: 'Do the work.',
    context: {
      dbPath: path.join(home, 'data', 'tasks.db'),
      db: { getProject: () => null },
      yolo: true,
    },
  });

  assert.equal(launch.file.endsWith('claude') || launch.file.includes('claude'), true);
  assert.equal(launch.cwd, project);
  assert.match(launch.sessionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(launch.args.slice(0, 2), ['--session-id', launch.sessionId]);
  assert.ok(launch.args.includes('--settings'));
  assert.ok(fs.existsSync(launch.args[launch.args.indexOf('--settings') + 1]));
  assert.ok(launch.args.includes('--permission-mode'));
  assert.ok(launch.args.includes('auto'));
  assert.equal(launch.args[launch.args.length - 1], 'Do the work.\n\nultracode');

  const plan = claude.buildLaunchArgs({
    kind: 'resume',
    sessionId: 'sess',
    model: 'claude-opus-4-8',
    effort: 'medium',
    mode: 'plan',
    skipPermissions: true,
  });
  assert.deepEqual(plan.slice(0, 2), ['--resume', 'sess']);
  assert.ok(plan.includes('plan'));
  assert.ok(!plan.includes('bypassPermissions'));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

test('claude launch attaches graphify MCP config when project graph exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-graph-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-project-'));
  fs.mkdirSync(path.join(project, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'graphify-out', 'graph.json'), '{"nodes":[]}\n');
  const fakeMcp = path.join(home, 'graphify-mcp');
  fs.writeFileSync(fakeMcp, '#!/bin/sh\n');
  fs.chmodSync(fakeMcp, 0o755);
  process.env.PATH = `${home}:${process.env.PATH}`;
  const claude = loadClaudeAdapter(home);

  const launch = claude.buildLaunch({
    task: {
      id: 'task-1',
      title: 'Graph task',
      project_id: 'project-1',
      project_path: project,
      model: 'claude-opus-4-8',
      effort: 'medium',
      mode: 'build',
      yolo: 1,
      ultracode: 0,
    },
    kind: 'start',
    prompt: 'Use graph.',
    context: {
      dbPath: path.join(home, 'data', 'tasks.db'),
      db: { getProject: () => ({ graphify_enabled: 1 }) },
      yolo: true,
    },
  });

  assert.ok(launch.args.includes('--mcp-config'));
  const mcpConfig = launch.args[launch.args.indexOf('--mcp-config') + 1];
  const json = JSON.parse(fs.readFileSync(mcpConfig, 'utf8'));
  assert.equal(json.mcpServers.graphify.command, fakeMcp);
  assert.equal(json.mcpServers.graphify.args[0], path.join(project, 'graphify-out', 'graph.json'));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});
