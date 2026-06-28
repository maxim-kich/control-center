#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  control-center start [--port <port>] [--home <path>] [--workspace <path>] [--db-path <path>]
  control-center import --from <old-control-center-path> --source-provider <codex|claude> [--home <path>] [--db-path <path>]
  control-center check-updates [--repo <owner/repo>] [--home <path>] [--db-path <path>]
  control-center update [--target <git-ref>] [--dry-run] [--allow-extension-conflicts] [--home <path>] [--db-path <path>]
  control-center rollback [--target <git-ref>] [--dry-run] [--allow-extension-conflicts] [--home <path>] [--db-path <path>]

Environment:
  CONTROL_CENTER_HOME  Instance state root. Defaults to ~/.control-center.
  CC_WORKSPACE_ROOT    Workspace folder shown in the project picker.
  CC_UPDATE_REPO       GitHub repository for release checks, as owner/repo.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function appHome(opts) {
  return path.resolve(opts.home || process.env.CONTROL_CENTER_HOME || path.join(os.homedir(), '.control-center'));
}

function ensureHome(home) {
  for (const name of ['', 'data', 'backups', 'extensions', 'releases', 'logs']) {
    fs.mkdirSync(path.join(home, name), { recursive: true });
  }
  const configPath = path.join(home, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, [
      '# Control Center instance configuration',
      'update_channel: stable',
      '',
    ].join('\n'));
  }
}

function runNode(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  });
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
if (!cmd || opts.help || opts.h) usage(0);

if (cmd === 'start') {
  const home = appHome(opts);
  ensureHome(home);
  const env = { ...process.env, CONTROL_CENTER_HOME: home };
  if (opts['db-path']) env.CC_DB_PATH = path.resolve(opts['db-path']);
  else delete env.CC_DB_PATH;
  if (opts.port) env.PORT = String(opts.port);
  if (opts.workspace) env.CC_WORKSPACE_ROOT = path.resolve(opts.workspace);
  runNode(path.join(ROOT, 'server.js'), [], env);
} else if (cmd === 'import') {
  const home = appHome(opts);
  ensureHome(home);
  const env = { ...process.env, CONTROL_CENTER_HOME: home };
  if (opts['db-path']) env.CC_DB_PATH = path.resolve(opts['db-path']);
  else delete env.CC_DB_PATH;
  const args = [];
  for (const key of ['from', 'source-provider', 'home', 'db-path']) {
    if (opts[key]) args.push(`--${key}`, String(opts[key]));
  }
  runNode(path.join(ROOT, 'scripts', 'import_legacy.js'), args, env);
} else if (cmd === 'check-updates' || cmd === 'update' || cmd === 'rollback') {
  const home = appHome(opts);
  ensureHome(home);
  const env = { ...process.env, CONTROL_CENTER_HOME: home };
  if (opts['db-path']) env.CC_DB_PATH = path.resolve(opts['db-path']);
  else delete env.CC_DB_PATH;
  const scriptCmd = cmd === 'check-updates' ? 'check' : cmd;
  const args = [scriptCmd];
  for (const key of ['repo', 'target', 'home', 'db-path']) {
    if (opts[key]) args.push(`--${key}`, String(opts[key]));
  }
  if (opts['dry-run']) args.push('--dry-run');
  if (opts['allow-extension-conflicts']) args.push('--allow-extension-conflicts');
  runNode(path.join(ROOT, 'scripts', 'update.js'), args, env);
} else {
  usage(1);
}
