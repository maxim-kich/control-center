#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const paths = require('../lib/core/paths');
const updater = require('../lib/core/updater');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  node scripts/update.js check [--repo <owner/repo>] [--home <path>] [--db-path <path>]
  node scripts/update.js update [--target <git-ref>] [--dry-run] [--allow-extension-conflicts] [--home <path>] [--db-path <path>]
  node scripts/update.js rollback [--target <git-ref>] [--dry-run] [--allow-extension-conflicts] [--home <path>] [--db-path <path>]

Environment:
  CONTROL_CENTER_HOME  Instance state root. Defaults to ~/.control-center.
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

function resolveAppHome(opts) {
  return path.resolve(opts.home || process.env.CONTROL_CENTER_HOME || paths.defaultAppHome());
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

function dbPathFor(opts, home) {
  return path.resolve(opts['db-path'] || process.env.CC_DB_PATH || path.join(home, 'data', 'tasks.db'));
}

function backupDirFor(home) {
  return path.join(home, 'backups');
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || opts.help || opts.h) usage(0);

  const home = resolveAppHome(opts);
  ensureHome(home);
  const dbPath = dbPathFor(opts, home);

  if (cmd === 'check') {
    const result = await updater.checkForUpdates({
      root: ROOT,
      repo: opts.repo,
      dbPath,
      currentVersion: pkg.version,
    });
    if (!result.ok) {
      printJson(result);
      process.exit(1);
    }
    printJson(result);
    return;
  }

  if (cmd === 'update') {
    const result = updater.updateGitCheckout({
      root: ROOT,
      appHome: home,
      dbPath,
      backupDir: backupDirFor(home),
      extensionsDir: path.join(home, 'extensions'),
      target: opts.target,
      dryRun: !!opts['dry-run'],
      allowExtensionConflicts: !!opts['allow-extension-conflicts'],
    });
    printJson(result);
    return;
  }

  if (cmd === 'rollback') {
    const result = updater.rollbackGitCheckout({
      root: ROOT,
      appHome: home,
      dbPath,
      backupDir: backupDirFor(home),
      extensionsDir: path.join(home, 'extensions'),
      target: opts.target,
      dryRun: !!opts['dry-run'],
      allowExtensionConflicts: !!opts['allow-extension-conflicts'],
    });
    printJson(result);
    return;
  }

  usage(1);
}

main().catch((e) => {
  const payload = {
    ok: false,
    error: e && e.message ? e.message : String(e),
    code: e && e.code ? e.code : undefined,
    changes: e && e.changes ? e.changes : undefined,
    rollbackError: e && e.rollbackError ? e.rollbackError : undefined,
  };
  printJson(payload);
  process.exit(1);
});
