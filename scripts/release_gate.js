#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');

function run(label, file, args, opts = {}) {
  process.stdout.write(`\n[gate] ${label}\n`);
  const result = spawnSync(file, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function writeMigrationFixture(tmp) {
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'graphify-out'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(project, 'graphify-out', 'graph.json'), '{"nodes":[]}\n');
  const dbPath = path.join(tmp, 'tasks.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      graphify_enabled INTEGER NOT NULL DEFAULT 1,
      graphify_status TEXT NOT NULL DEFAULT 'current',
      graphify_last_success_at TEXT,
      graphify_last_error TEXT,
      graphify_hook_status TEXT,
      graphify_dirty_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO projects (
      id, name, path, archived, graphify_enabled, graphify_status,
      graphify_last_success_at, graphify_hook_status
    )
    VALUES ('project-1', 'Project', ?, 0, 1, 'current', '2026-01-01T00:00:00.000Z', 'installed')
  `).run(project);
  db.close();
  return dbPath;
}

async function migrationDryRunGate() {
  process.stdout.write('\n[gate] bundled migration dry-run fixture\n');
  const updater = require('../lib/core/updater');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-release-gate-'));
  try {
    const dbPath = writeMigrationFixture(tmp);
    const result = await updater.runBundledIntegrationMigration({
      root: ROOT,
      appHome: tmp,
      dbPath,
      extensionsDir: path.join(tmp, 'extensions'),
      dryRun: true,
    });
    if (!result.ok) throw new Error('migration dry-run returned not ok');
    if (result.plan.targets.graphify.targetOwner !== 'graphify') throw new Error('Graphify migration target missing');
    if (result.plan.targets.git.targetOwner !== 'git-workflow') throw new Error('Git Workflow migration target missing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  run('npm test', 'npm', ['test']);
  run('public verification', 'npm', ['run', 'verify:public']);
  await migrationDryRunGate();

  if (process.env.CC_RELEASE_GATE_UPDATE_SMOKE === '1') {
    run('real updater dry-run smoke', process.execPath, ['scripts/update.js', 'update', '--dry-run']);
  } else {
    process.stdout.write('\n[gate] real updater dry-run smoke skipped (set CC_RELEASE_GATE_UPDATE_SMOKE=1)\n');
  }

  if (process.env.CC_RELEASE_GATE_ROLLBACK_SMOKE === '1') {
    run('real rollback dry-run smoke', process.execPath, ['scripts/update.js', 'rollback', '--dry-run']);
  } else {
    process.stdout.write('\n[gate] real rollback dry-run smoke skipped (set CC_RELEASE_GATE_ROLLBACK_SMOKE=1)\n');
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
