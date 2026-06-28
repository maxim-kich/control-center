'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

const { loadExtensions, scanExtensions } = require('../lib/core/extensions');

function writeExtension(root, folder, manifest, files = {}) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.yaml'), manifest);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

async function listen(app) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test('extension loader serves declared API routes and public assets', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-'));
  writeExtension(tmp, 'status-panel', `
id: status-panel
name: Status Panel
version: 0.1.0
settingsPanels:
  - id: status
    title: Status
    path: settings.html
routes:
  - path: status
    method: GET
`, {
    'public/settings.html': '<h1>Status</h1>',
    'server.js': `
'use strict';
exports.register = ({ express }) => {
  const router = express.Router();
  router.get('/status', (req, res) => res.json({ ok: true }));
  return router;
};
`,
  });

  const app = express();
  const manager = loadExtensions({ app, extensionsDir: tmp });
  const { server, base } = await listen(app);
  try {
    const payload = manager.publicPayload();
    assert.equal(payload.extensions.length, 1);
    assert.equal(payload.extensions[0].settingsPanels[0].url, '/extensions/status-panel/settings.html');

    const route = await fetch(`${base}/api/extensions/status-panel/status`).then((res) => res.json());
    assert.equal(route.ok, true);
    const html = await fetch(`${base}/extensions/status-panel/settings.html`).then((res) => res.text());
    assert.match(html, /Status/);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extension scanner reports duplicate ids, migrations, routes, and UI slots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-conflict-'));
  try {
    writeExtension(tmp, 'one', `
id: shared
name: One
settingsPanels:
  - id: status
    title: Status
    path: one.html
routes:
  - path: status
    method: GET
migrations:
  - id: init
    path: migrations/001.sql
`);
    writeExtension(tmp, 'two', `
id: shared
name: Two
settingsPanels:
  - id: status
    title: Status
    path: two.html
routes:
  - path: status
    method: GET
migrations:
  - id: init
    path: migrations/001.sql
`);
    const result = scanExtensions(tmp);
    const types = result.conflicts.map((conflict) => conflict.type).sort();
    assert.ok(types.includes('duplicate-extension-id'));
    assert.ok(types.includes('route-conflict'));
    assert.ok(types.includes('migration-conflict'));
    assert.ok(types.includes('ui-slot-conflict'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
