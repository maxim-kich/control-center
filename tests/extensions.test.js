'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

const {
  loadExtensions,
  scanExtensions,
  installExtensionDirectory,
  installExtensionUpload,
} = require('../lib/core/extensions');

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

function writeExtensionJson(root, folder, manifest, files = {}) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2));
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

test('disabled extensions expose no frontend, routes, hooks, or backend behavior', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-extension-disabled-'));
  try {
    const dir = path.join(tmp, 'disabled-one');
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({
      apiVersion: 1, id: 'disabled-one', name: 'Disabled', version: '1.0.0',
      permissions: ['ui:frontend', 'api:routes', 'hooks:lifecycle'],
      server: 'server.js', frontend: { scripts: [{ path: 'main.js' }] },
      routes: [{ method: 'GET', path: 'ping' }], hooks: { 'app.started': {} },
    }));
    fs.writeFileSync(path.join(dir, 'server.js'), "throw new Error('disabled backend loaded');\n");
    fs.writeFileSync(path.join(dir, 'public', 'main.js'), 'window.disabledLoaded = true;\n');
    const platform = { isEnabled: () => false, diagnostics: () => ({}) };
    const loaded = loadExtensions({ extensionsDir: tmp, platform, context: {} });
    const ext = loaded.publicPayload().extensions[0];
    assert.equal(ext.enabled, false);
    assert.equal(ext.enabledByUser, false);
    assert.deepEqual(ext.frontend.scripts, []);
    assert.deepEqual(ext.routes, []);
    assert.deepEqual(ext.hooks, []);
  } finally {
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

test('extension scanner normalizes frontend assets and UI contributions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-ui-'));
  try {
    writeExtensionJson(tmp, 'project-flags', {
      id: 'project-flags',
      name: 'Project Flags',
      version: '0.2.0',
      permissions: [
        'ui:frontend',
        'ui:project-fields',
        'ui:project-actions',
        'ui:project-badges',
        'ui:task-badges',
        'ui:modals',
        'api:extension-state',
      ],
      frontend: {
        scripts: [{ path: 'inline-ui.js', type: 'module' }],
        styles: ['inline-ui.css'],
      },
      contributes: {
        projectFields: [{ id: 'important-project', title: 'Important project' }],
        projectActions: [{ id: 'open-project-note', title: 'Open note' }],
        projectBadges: [{ id: 'important-badge', title: 'Important' }],
        taskBadges: [{ id: 'project-flag', title: 'Project flag' }],
        modals: [{ id: 'project-note', title: 'Project note' }],
      },
    }, {
      'public/inline-ui.js': 'export {};',
      'public/inline-ui.css': '.project-flags{}',
    });

    const result = scanExtensions(tmp);
    assert.equal(result.conflicts.length, 0);
    const extension = result.extensions[0];
    assert.deepEqual(extension.errors, []);
    assert.equal(extension.frontend.scripts[0].url, '/extensions/project-flags/inline-ui.js');
    assert.equal(extension.frontend.scripts[0].type, 'module');
    assert.equal(extension.frontend.styles[0].url, '/extensions/project-flags/inline-ui.css');
    assert.equal(extension.contributes.projectFields[0].slot, 'project-form');
    assert.equal(extension.contributes.projectActions[0].slot, 'projectAction');
    assert.equal(extension.contributes.projectBadges[0].slot, 'project-header');

    const app = express();
    const manager = loadExtensions({ app, extensionsDir: tmp });
    const publicExtension = manager.publicPayload().extensions[0];
    assert.equal(publicExtension.enabled, true);
    assert.equal(publicExtension.permissions.includes('api:extension-state'), true);
    assert.equal(publicExtension.contributes.modals[0].id, 'project-note');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extension scanner disables rich frontend declarations without permissions or safe paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-ui-invalid-'));
  try {
    writeExtensionJson(tmp, 'unsafe-ui', {
      id: 'unsafe-ui',
      name: 'Unsafe UI',
      frontend: {
        scripts: ['../inline-ui.js'],
      },
      contributes: {
        projectFields: [{ id: 'important-project', title: 'Important project' }],
      },
    });

    const result = scanExtensions(tmp);
    const extension = result.extensions[0];
    assert.equal(extension.errors.some((error) => error.includes('frontend asset paths')), true);
    assert.equal(extension.errors.some((error) => error.includes('ui:project-fields')), true);
    assert.equal(extension.errors.some((error) => error.includes('ui:frontend')), false);
    assert.equal(extension.frontend.scripts.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extension scanner reports conflicts for declared UI contributions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-ui-conflict-'));
  try {
    const manifest = (id) => ({
      id,
      name: id,
      permissions: ['ui:project-fields', 'ui:modals'],
      contributes: {
        projectFields: [{ id: 'important-project', title: 'Important project', slot: 'project-form' }],
        modals: [{ id: 'project-note', title: 'Project note' }],
      },
    });
    writeExtensionJson(tmp, 'one', manifest('one'));
    writeExtensionJson(tmp, 'two', manifest('two'));

    const result = scanExtensions(tmp);
    const keys = result.conflicts.map((conflict) => conflict.key).sort();
    assert.ok(keys.includes('project-field:project-form:important-project'));
    assert.ok(keys.includes('modal:modal:project-note'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extension installer copies one extension directory into the runtime extensions dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-install-'));
  const sourceRoot = path.join(tmp, 'source');
  const installedRoot = path.join(tmp, 'installed');
  try {
    writeExtensionJson(sourceRoot, 'project-flags', {
      id: 'project-flags',
      name: 'Project Flags',
      version: '0.1.0',
      permissions: ['ui:frontend'],
      frontend: {
        scripts: [{ path: 'inline-ui.js' }],
      },
    }, {
      'public/inline-ui.js': 'window.example = true;',
    });

    const installed = installExtensionDirectory(path.join(sourceRoot, 'project-flags'), {
      extensionsDir: installedRoot,
    });
    assert.equal(installed.id, 'project-flags');
    assert.equal(fs.existsSync(path.join(installedRoot, 'project-flags', 'extension.json')), true);
    assert.equal(fs.existsSync(path.join(installedRoot, 'project-flags', 'public', 'inline-ui.js')), true);
    assert.throws(
      () => installExtensionDirectory(path.join(sourceRoot, 'project-flags'), { extensionsDir: installedRoot }),
      /already installed/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extension installer accepts uploaded folder files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-ext-upload-'));
  try {
    const installed = installExtensionUpload({
      files: [
        {
          relativePath: 'project-flags/extension.json',
          contentBase64: Buffer.from(JSON.stringify({
            id: 'project-flags',
            name: 'Project Flags',
            permissions: ['ui:project-fields'],
            contributes: {
              projectFields: [{ id: 'important-project', title: 'Important project' }],
            },
          })).toString('base64'),
        },
        {
          relativePath: 'project-flags/public/inline-ui.js',
          contentBase64: Buffer.from('window.example = true;').toString('base64'),
        },
      ],
    }, {
      extensionsDir: tmp,
    });

    assert.equal(installed.id, 'project-flags');
    assert.equal(fs.existsSync(path.join(tmp, 'project-flags', 'extension.json')), true);
    assert.throws(() => installExtensionUpload({
      files: [{ relativePath: '../bad/extension.json', contentBase64: '' }],
    }, { extensionsDir: tmp }), /uploaded file paths/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
