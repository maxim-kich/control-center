'use strict';

/**
 * node-pty (microsoft) ships a `spawn-helper` binary that the native addon execs to set
 * up the PTY on macOS/Linux. Some prebuilt packages extract it WITHOUT the execute bit,
 * which makes every pty.spawn() fail with "posix_spawnp failed." This best-effort fix
 * restores +x so the dashboard works straight after `npm install`. (See PLAN.md R4.)
 */

const fs = require('fs');
const path = require('path');

function ensureSpawnHelper() {
  if (process.platform === 'win32') return; // no spawn-helper on Windows
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return;
  }
  const candidates = [
    path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(pkgDir, 'build', 'Release', 'spawn-helper'),
    path.join(pkgDir, 'build', 'Debug', 'spawn-helper'),
  ];
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (!(st.mode & 0o111)) fs.chmodSync(p, 0o755);
    } catch {
      /* missing candidate — ignore */
    }
  }
}

module.exports = { ensureSpawnHelper };
