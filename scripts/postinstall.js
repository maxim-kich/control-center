'use strict';
// Runs after `npm install`. Makes node-pty's spawn-helper executable (see lib/ensurePty.js).
try {
  require('../lib/ensurePty').ensureSpawnHelper();
} catch (e) {
  // Never fail the install over this; the server also self-heals on boot.
  console.warn('[postinstall] could not adjust node-pty spawn-helper:', e && e.message);
}
