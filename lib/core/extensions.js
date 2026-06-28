'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function scalarValue(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseYamlSubset(text) {
  const root = {};
  let currentList = null;
  let currentItem = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)[0].length;
    const line = noComment.trim();
    if (indent === 0) {
      currentList = null;
      currentItem = null;
      const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
      if (!match) continue;
      if (match[2] == null || match[2] === '') {
        root[match[1]] = [];
        currentList = root[match[1]];
      } else {
        root[match[1]] = scalarValue(match[2]);
      }
      continue;
    }
    if (!currentList || !Array.isArray(currentList)) continue;
    if (line.startsWith('- ')) {
      currentItem = {};
      currentList.push(currentItem);
      const rest = line.slice(2).trim();
      if (rest) {
        const match = rest.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
        if (match) currentItem[match[1]] = scalarValue(match[2] || '');
      }
      continue;
    }
    if (currentItem) {
      const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
      if (match) currentItem[match[1]] = scalarValue(match[2] || '');
    }
  }
  return root;
}

function readManifest(dir) {
  const jsonPath = path.join(dir, 'extension.json');
  if (fs.existsSync(jsonPath)) return { manifest: readJson(jsonPath), file: jsonPath };
  const yamlPath = path.join(dir, 'extension.yaml');
  if (fs.existsSync(yamlPath)) return { manifest: parseYamlSubset(fs.readFileSync(yamlPath, 'utf8')), file: yamlPath };
  const ymlPath = path.join(dir, 'extension.yml');
  if (fs.existsSync(ymlPath)) return { manifest: parseYamlSubset(fs.readFileSync(ymlPath, 'utf8')), file: ymlPath };
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRelativePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) return null;
  return raw;
}

function extensionUrl(id, rel) {
  const clean = normalizeRelativePath(rel);
  return clean ? `/extensions/${id}/${clean}` : null;
}

function normalizeUiItems(items, id, kind) {
  return asArray(items).map((item) => {
    const itemId = String(item.id || '').trim();
    const title = String(item.title || item.name || itemId).trim();
    return {
      id: itemId,
      title,
      slot: String(item.slot || kind).trim() || kind,
      path: normalizeRelativePath(item.path),
      url: extensionUrl(id, item.path),
    };
  }).filter((item) => item.id && item.title);
}

function normalizeRoutes(routes) {
  return asArray(routes).map((route) => {
    const routePath = String(route.path || route.route || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return {
      path: routePath || '',
      method: String(route.method || 'ANY').toUpperCase(),
    };
  });
}

function normalizeMigrations(migrations) {
  return asArray(migrations).map((migration) => ({
    id: String(migration.id || migration.name || '').trim(),
    path: normalizeRelativePath(migration.path),
  })).filter((migration) => migration.id);
}

function normalizeManifest(raw, dir, manifestFile) {
  const id = String(raw.id || path.basename(dir)).trim();
  const publicDir = path.join(dir, 'public');
  const serverFile = raw.server === false
    ? null
    : path.join(dir, normalizeRelativePath(raw.server || 'server.js') || 'server.js');
  return {
    id,
    validId: ID_RE.test(id),
    name: String(raw.name || id).trim(),
    version: String(raw.version || '').trim(),
    description: String(raw.description || '').trim(),
    dir,
    manifestFile,
    publicDir: fs.existsSync(publicDir) ? publicDir : null,
    serverFile: serverFile && fs.existsSync(serverFile) ? serverFile : null,
    settingsPanels: normalizeUiItems(raw.settingsPanels || raw.settings_panels, id, 'settings'),
    taskDetailSections: normalizeUiItems(raw.taskDetailSections || raw.task_detail_sections, id, 'taskDetail'),
    projectActions: normalizeUiItems(raw.projectActions || raw.project_actions, id, 'projectAction'),
    routes: normalizeRoutes(raw.routes),
    migrations: normalizeMigrations(raw.migrations),
    errors: [],
  };
}

function listExtensionDirs(extensionsDir) {
  try {
    return fs.readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(extensionsDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function scanExtensions(extensionsDir) {
  const extensions = [];
  const conflicts = [];
  const seenIds = new Map();
  const seenRoutes = new Map();
  const seenMigrations = new Map();
  const seenSlots = new Map();

  for (const dir of listExtensionDirs(extensionsDir)) {
    const read = readManifest(dir);
    if (!read) continue;
    let extension;
    try {
      extension = normalizeManifest(read.manifest, dir, read.file);
    } catch (e) {
      extension = {
        id: path.basename(dir),
        validId: false,
        name: path.basename(dir),
        version: '',
        description: '',
        dir,
        manifestFile: read.file,
        publicDir: null,
        serverFile: null,
        settingsPanels: [],
        taskDetailSections: [],
        projectActions: [],
        routes: [],
        migrations: [],
        errors: [e && e.message ? e.message : String(e)],
      };
    }
    if (!extension.validId) {
      extension.errors.push('extension id must match /^[a-z][a-z0-9-]{1,63}$/');
    }
    const prior = seenIds.get(extension.id);
    if (prior) {
      conflicts.push({ type: 'duplicate-extension-id', id: extension.id, extensions: [prior, extension.dir] });
    } else {
      seenIds.set(extension.id, extension.dir);
    }

    for (const route of extension.routes) {
      const key = `${extension.id}:${route.method}:${route.path}`;
      const seen = seenRoutes.get(key);
      if (seen) conflicts.push({ type: 'route-conflict', key, extensions: [seen, extension.dir] });
      else seenRoutes.set(key, extension.dir);
    }
    for (const migration of extension.migrations) {
      const seen = seenMigrations.get(migration.id);
      if (seen) conflicts.push({ type: 'migration-conflict', id: migration.id, extensions: [seen, extension.dir] });
      else seenMigrations.set(migration.id, extension.dir);
    }
    for (const [kind, items] of [
      ['settings', extension.settingsPanels],
      ['task-detail', extension.taskDetailSections],
      ['project-action', extension.projectActions],
    ]) {
      for (const item of items) {
        const key = `${kind}:${item.slot}:${item.id}`;
        const seen = seenSlots.get(key);
        if (seen) conflicts.push({ type: 'ui-slot-conflict', key, extensions: [seen, extension.dir] });
        else seenSlots.set(key, extension.dir);
      }
    }
    extensions.push(extension);
  }

  return { extensions, conflicts };
}

function publicExtension(extension) {
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    description: extension.description,
    enabled: extension.errors.length === 0,
    errors: extension.errors,
    settingsPanels: extension.settingsPanels,
    taskDetailSections: extension.taskDetailSections,
    projectActions: extension.projectActions,
    routes: extension.routes.map((route) => ({ ...route, mount: `/api/extensions/${extension.id}/${route.path}`.replace(/\/$/, '') })),
    migrations: extension.migrations,
  };
}

function loadExtensionRoutes(app, extension, context) {
  if (!extension.serverFile || extension.errors.length) return;
  try {
    delete require.cache[require.resolve(extension.serverFile)];
    const mod = require(extension.serverFile);
    if (!mod || typeof mod.register !== 'function') return;
    const router = mod.register({
      ...context,
      express,
      extension: publicExtension(extension),
      extensionDir: extension.dir,
    });
    if (router) app.use(`/api/extensions/${extension.id}`, router);
  } catch (e) {
    extension.errors.push(e && e.message ? e.message : String(e));
  }
}

function loadExtensions(opts = {}) {
  const app = opts.app;
  const extensionsDir = opts.extensionsDir;
  const scanned = scanExtensions(extensionsDir);
  for (const extension of scanned.extensions) {
    if (extension.publicDir) app.use(`/extensions/${extension.id}`, express.static(extension.publicDir));
    loadExtensionRoutes(app, extension, opts.context || {});
  }
  return {
    extensionsDir,
    extensions: scanned.extensions,
    conflicts: scanned.conflicts,
    publicPayload() {
      return {
        extensionsDir,
        extensions: this.extensions.map(publicExtension),
        conflicts: this.conflicts,
      };
    },
    conflictSummary() {
      return this.conflicts.map((conflict) => conflict.type).join(', ');
    },
    shutdown() {
      /* reserved for extension lifecycle hooks */
    },
  };
}

module.exports = {
  parseYamlSubset,
  scanExtensions,
  loadExtensions,
};
