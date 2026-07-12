'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const {
  SUPPORTED_HOOKS,
  ExtensionLifecycle,
  normalizeHookDeclarations,
} = require('./extensionLifecycle');
const {
  MANAGED_PERMISSIONS,
  normalizeOwnership,
  validateOwnership,
} = require('./extensionContract');

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_UPLOAD_FILES = 800;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const RESERVED_EXTENSION_API_SEGMENTS = new Set(['state']);
const FRONTEND_PERMISSIONS = new Set([
  'ui:frontend',
  'ui:panels',
  'ui:project-fields',
  'ui:project-actions',
  'ui:project-badges',
  'ui:task-actions',
  'ui:task-badges',
  'ui:task-detail',
  'ui:modals',
  'api:extension-state',
  'hooks:lifecycle',
  ...MANAGED_PERMISSIONS,
]);

const CONTRIBUTION_DEFS = {
  settingsPanels: { slot: 'settings', permission: null, legacy: ['settings_panels'] },
  taskDetailSections: { slot: 'taskDetail', permission: null, legacy: ['task_detail_sections'] },
  projectActions: { slot: 'projectAction', permission: null, legacy: ['project_actions'] },
  projectFields: { slot: 'project-form', permission: 'ui:project-fields', legacy: ['project_fields'] },
  projectBadges: { slot: 'project-header', permission: 'ui:project-badges', legacy: ['project_badges'] },
  taskActions: { slot: 'task-card', permission: 'ui:task-actions', legacy: ['task_actions'] },
  taskBadges: { slot: 'task-card', permission: 'ui:task-badges', legacy: ['task_badges'] },
  panels: { slot: 'panel', permission: 'ui:panels', legacy: [] },
  modals: { slot: 'modal', permission: 'ui:modals', legacy: [] },
};

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

function normalizePermissions(raw) {
  const values = asArray(raw.permissions || raw.capabilities).map((item) => String(item || '').trim()).filter(Boolean);
  return [...new Set(values)];
}

function normalizeFrontendAssets(items, id, kind) {
  return asArray(items).map((item) => {
    const raw = typeof item === 'string' ? { path: item } : item || {};
    const rel = normalizeRelativePath(raw.path || raw.src || raw.href);
    if (!rel) return null;
    const asset = {
      path: rel,
      url: extensionUrl(id, rel),
    };
    if (kind === 'scripts') {
      asset.type = raw.type === 'module' ? 'module' : 'classic';
    } else if (raw.media) {
      asset.media = String(raw.media);
    }
    return asset;
  }).filter(Boolean);
}

function normalizeFrontend(raw, id) {
  const frontend = raw.frontend || {};
  return {
    scripts: normalizeFrontendAssets(frontend.scripts || raw.frontendScripts || raw.frontend_scripts, id, 'scripts'),
    styles: normalizeFrontendAssets(frontend.styles || raw.frontendStyles || raw.frontend_styles, id, 'styles'),
  };
}

function frontendAssetDeclarations(raw, kind) {
  const frontend = raw.frontend || {};
  if (kind === 'scripts') return asArray(frontend.scripts || raw.frontendScripts || raw.frontend_scripts);
  return asArray(frontend.styles || raw.frontendStyles || raw.frontend_styles);
}

function frontendInvalidAssetCount(raw, kind) {
  return frontendAssetDeclarations(raw, kind).filter((item) => {
    const asset = typeof item === 'string' ? { path: item } : item || {};
    return !normalizeRelativePath(asset.path || asset.src || asset.href);
  }).length;
}

function rawContributionList(raw, key) {
  const source = raw.contributes || raw.contributions || {};
  const def = CONTRIBUTION_DEFS[key] || {};
  for (const candidate of [source[key], raw[key], ...(def.legacy || []).map((legacyKey) => source[legacyKey] || raw[legacyKey])]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeContributionItems(items, id, kind) {
  const def = CONTRIBUTION_DEFS[kind] || {};
  return asArray(items).map((item) => {
    const itemId = String(item.id || item.name || '').trim();
    const title = String(item.title || item.label || item.name || itemId).trim();
    const rel = normalizeRelativePath(item.path || item.src || item.href);
    const slot = String(item.slot || item.mount || def.slot || kind).trim() || def.slot || kind;
    const out = {
      id: itemId,
      title,
      label: String(item.label || title || itemId).trim(),
      slot,
      mount: slot,
      path: rel,
      url: rel ? extensionUrl(id, rel) : null,
    };
    for (const key of ['description', 'variant', 'icon', 'modal', 'action', 'placement']) {
      if (item[key] != null) out[key] = String(item[key]);
    }
    if (Number.isFinite(Number(item.order))) out.order = Number(item.order);
    return out;
  }).filter((item) => item.id && item.title);
}

function normalizeContributes(raw, id) {
  const out = {};
  for (const key of Object.keys(CONTRIBUTION_DEFS)) {
    const items = rawContributionList(raw, key);
    out[key] = key === 'settingsPanels' || key === 'taskDetailSections' || key === 'projectActions'
      ? normalizeUiItems(items, id, CONTRIBUTION_DEFS[key].slot)
      : normalizeContributionItems(items, id, key);
  }
  return out;
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

function normalizeHooks(raw) {
  return normalizeHookDeclarations(raw.hooks || raw.lifecycle);
}

function normalizeManifest(raw, dir, manifestFile) {
  const id = String(raw.id || path.basename(dir)).trim();
  const apiVersion = Number(raw.apiVersion || raw.api_version || 1);
  const publicDir = path.join(dir, 'public');
  const serverFile = raw.server === false
    ? null
    : path.join(dir, normalizeRelativePath(raw.server || 'server.js') || 'server.js');
  const contributes = normalizeContributes(raw, id);
  const frontend = normalizeFrontend(raw, id);
  const permissions = normalizePermissions(raw);
  const ownership = normalizeOwnership(raw);
  const hooks = normalizeHooks(raw);
  const errors = [];
  if (apiVersion !== 1) errors.push(`unsupported extension apiVersion ${apiVersion}`);
  const invalidFrontendAssets = frontendInvalidAssetCount(raw, 'scripts') + frontendInvalidAssetCount(raw, 'styles');
  if (invalidFrontendAssets) errors.push('frontend asset paths must be relative and cannot contain ..');
  const hasFrontendAssets = frontend.scripts.length || frontend.styles.length;
  if (hasFrontendAssets && !permissions.includes('ui:frontend')) errors.push('missing permission ui:frontend for frontend assets');
  for (const [kind, def] of Object.entries(CONTRIBUTION_DEFS)) {
    if (def.permission && contributes[kind].length && !permissions.includes(def.permission)) {
      errors.push(`missing permission ${def.permission} for ${kind}`);
    }
  }
  for (const permission of permissions) {
    if (!FRONTEND_PERMISSIONS.has(permission) && !permission.startsWith('api:')) {
      errors.push(`unknown permission ${permission}`);
    }
  }
  errors.push(...validateOwnership(ownership, permissions));
  if (ownership.length && !permissions.includes('health:checks')) {
    errors.push('missing permission health:checks for compatibility ownership');
  }
  if (ownership.length && !serverFile) {
    errors.push('compatibility ownership requires a backend server.js');
  }
  if (hooks.length && !permissions.includes('hooks:lifecycle')) {
    errors.push('missing permission hooks:lifecycle for lifecycle hooks');
  }
  for (const hook of hooks) {
    if (!SUPPORTED_HOOKS.has(hook.name)) errors.push(`unsupported lifecycle hook ${hook.name}`);
  }
  return {
    id,
    apiVersion,
    validId: ID_RE.test(id),
    name: String(raw.name || id).trim(),
    version: String(raw.version || '').trim(),
    description: String(raw.description || '').trim(),
    dir,
    manifestFile,
    publicDir: fs.existsSync(publicDir) ? publicDir : null,
    serverFile: serverFile && fs.existsSync(serverFile) ? serverFile : null,
    permissions,
    ownership,
    frontend,
    contributes,
    settingsPanels: contributes.settingsPanels,
    taskDetailSections: contributes.taskDetailSections,
    projectActions: contributes.projectActions,
    routes: normalizeRoutes(raw.routes),
    migrations: normalizeMigrations(raw.migrations),
    hooks,
    errors,
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

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    force: false,
    filter: (from) => {
      const base = path.basename(from);
      return base !== '.git' && base !== 'node_modules';
    },
  });
}

function extensionManifestFiles(root, opts = {}) {
  const maxDepth = opts.maxDepth == null ? 6 : opts.maxDepth;
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const name of ['extension.json', 'extension.yaml', 'extension.yml']) {
      if (names.has(name)) out.push(path.join(dir, name));
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

function findSingleExtensionRoot(root, preferredSubdir) {
  const base = preferredSubdir ? path.join(root, normalizeRelativePath(preferredSubdir) || '') : root;
  if (!base || !fs.existsSync(base)) throw new Error('extension folder not found');
  if (!fs.statSync(base).isDirectory()) throw new Error('extension source must be a directory');
  if (readManifest(base)) return base;
  const manifests = extensionManifestFiles(base);
  if (!manifests.length) throw new Error('no extension manifest found');
  const dirs = [...new Set(manifests.map((file) => path.dirname(file)))];
  if (dirs.length > 1) throw new Error('multiple extension manifests found; choose one extension folder');
  return dirs[0];
}

function safeInstallTarget(extensionsDir, id) {
  const root = path.resolve(extensionsDir);
  const target = path.resolve(root, id);
  if (!target.startsWith(root + path.sep)) throw new Error('invalid extension install target');
  return target;
}

function installedExtensionPayload(extension, target, source) {
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    description: extension.description,
    target,
    source: source || 'folder',
    enabled: extension.enabledByUser !== false && extension.errors.length === 0,
    errors: extension.errors,
    restartRequired: !!extension.serverFile,
  };
}

function installExtensionDirectory(sourceDir, opts = {}) {
  const extensionsDir = opts.extensionsDir;
  if (!extensionsDir) throw new Error('extensions directory is required');
  const root = findSingleExtensionRoot(sourceDir, opts.subdir);
  const read = readManifest(root);
  if (!read) throw new Error('no extension manifest found');
  const extension = normalizeManifest(read.manifest, root, read.file);
  if (!extension.validId) throw new Error('extension id must match /^[a-z][a-z0-9-]{1,63}$/');
  fs.mkdirSync(extensionsDir, { recursive: true });
  const target = safeInstallTarget(extensionsDir, extension.id);
  if (fs.existsSync(target)) {
    if (!opts.overwrite) throw new Error(`extension already installed: ${extension.id}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `control-center-extension-${extension.id}-`));
  const stagedTarget = path.join(staging, extension.id);
  try {
    copyDir(root, stagedTarget);
    fs.renameSync(stagedTarget, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const installed = normalizeManifest(readManifest(target).manifest, target, readManifest(target).file);
  return installedExtensionPayload(installed, target, opts.source);
}

function safeUploadRelativePath(raw) {
  const rel = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || rel.includes('..')) return null;
  if (parts.some((part) => part === '.git' || part === 'node_modules')) return null;
  return parts.join('/');
}

function installExtensionUpload(payload, opts = {}) {
  const files = Array.isArray(payload && payload.files) ? payload.files : [];
  if (!files.length) throw new Error('no extension files uploaded');
  if (files.length > MAX_UPLOAD_FILES) throw new Error(`too many files uploaded; maximum is ${MAX_UPLOAD_FILES}`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-extension-upload-'));
  let total = 0;
  try {
    for (const file of files) {
      const rel = safeUploadRelativePath(file.relativePath || file.path || file.name);
      if (!rel) throw new Error('uploaded file paths must be relative and cannot include .., .git, or node_modules');
      const body = Buffer.from(String(file.contentBase64 || ''), 'base64');
      total += body.length;
      if (total > MAX_UPLOAD_BYTES) throw new Error(`uploaded extension is too large; maximum is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
      const out = path.join(staging, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, body);
    }
    return installExtensionDirectory(staging, {
      extensionsDir: opts.extensionsDir,
      overwrite: !!opts.overwrite,
      source: 'upload',
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function parseGithubTreeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  const treeIndex = parts.indexOf('tree');
  if (treeIndex === -1) return { cloneUrl: `https://github.com/${owner}/${repo}.git`, branch: '', subdir: '' };
  const branch = parts[treeIndex + 1] || '';
  const subdir = parts.slice(treeIndex + 2).join('/');
  return { cloneUrl: `https://github.com/${owner}/${repo}.git`, branch, subdir };
}

function normalizeGitSource(source) {
  const raw = String(source || '').trim();
  if (!raw) throw new Error('Git source is required');
  const github = parseGithubTreeUrl(raw);
  if (github) return github;
  if (/^(https:\/\/|ssh:\/\/|git@)/.test(raw)) return { cloneUrl: raw, branch: '', subdir: '' };
  throw new Error('Git source must be a GitHub HTTPS URL, HTTPS Git URL, SSH Git URL, or git@ URL');
}

function gitClone(source, dest, branch) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch, '--single-branch');
    args.push(source, dest);
    execFile('git', args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || stdout || err.message || 'git clone failed').trim()));
        return;
      }
      resolve();
    });
  });
}

async function installExtensionGit(opts = {}) {
  const source = normalizeGitSource(opts.source);
  const branch = String(opts.branch || source.branch || '').trim();
  const subdir = String(opts.subdir || source.subdir || '').trim();
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'control-center-extension-git-'));
  const cloneDir = path.join(staging, 'repo');
  try {
    await gitClone(source.cloneUrl, cloneDir, branch);
    return installExtensionDirectory(cloneDir, {
      extensionsDir: opts.extensionsDir,
      overwrite: !!opts.overwrite,
      subdir,
      source: source.cloneUrl,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
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
        apiVersion: 1,
        validId: false,
        name: path.basename(dir),
        version: '',
        description: '',
        dir,
        manifestFile: read.file,
        publicDir: null,
        serverFile: null,
        permissions: [],
        ownership: [],
        frontend: { scripts: [], styles: [] },
        contributes: Object.fromEntries(Object.keys(CONTRIBUTION_DEFS).map((key) => [key, []])),
        settingsPanels: [],
        taskDetailSections: [],
        projectActions: [],
        routes: [],
        migrations: [],
        hooks: [],
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
      const firstSegment = String(route.path || '').split('/').filter(Boolean)[0];
      if (RESERVED_EXTENSION_API_SEGMENTS.has(firstSegment)) {
        extension.errors.push(`route path is reserved: ${firstSegment}`);
      }
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
      ['project-field', extension.contributes.projectFields],
      ['project-badge', extension.contributes.projectBadges],
      ['task-action', extension.contributes.taskActions],
      ['task-badge', extension.contributes.taskBadges],
      ['panel', extension.contributes.panels],
      ['modal', extension.contributes.modals],
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
    apiVersion: extension.apiVersion,
    name: extension.name,
    version: extension.version,
    description: extension.description,
    enabled: extension.errors.length === 0,
    errors: extension.errors,
    permissions: extension.permissions,
    ownership: extension.ownership,
    frontend: extension.frontend,
    contributes: extension.contributes,
    settingsPanels: extension.settingsPanels,
    taskDetailSections: extension.taskDetailSections,
    projectActions: extension.projectActions,
    routes: extension.routes.map((route) => ({ ...route, mount: `/api/extensions/${extension.id}/${route.path}`.replace(/\/$/, '') })),
    migrations: extension.migrations,
    hooks: extension.hooks,
  };
}

function loadExtensionBackend(app, extension, context, lifecycle, platform) {
  if (extension.errors.length || extension.enabledByUser === false) return;
  if (!extension.serverFile) {
    if (extension.hooks.length) extension.errors.push('lifecycle hooks require a backend server.js');
    return;
  }
  try {
    delete require.cache[require.resolve(extension.serverFile)];
    const mod = require(extension.serverFile);
    lifecycle.register(extension, mod);
    if (app && mod && typeof mod.register === 'function') {
      const capabilities = platform ? platform.capabilitiesFor(extension, context) : Object.freeze({});
      const router = mod.register({
        ...context,
        express,
        extension: publicExtension(extension),
        extensionDir: extension.dir,
        capabilities,
      });
      if (router) app.use(`/api/extensions/${extension.id}`, router);
    }
  } catch (e) {
    extension.errors.push(e && e.message ? e.message : String(e));
  }
}

function loadExtensions(opts = {}) {
  const app = opts.app;
  const extensionsDir = opts.extensionsDir;
  const scanned = scanExtensions(extensionsDir);
  const lifecycle = new ExtensionLifecycle({
    db: opts.context && opts.context.db,
    timeoutMs: opts.hookTimeoutMs,
    capabilityFactory: opts.platform
      ? (extension) => opts.platform.capabilitiesFor(extension, opts.context || {})
      : null,
  });
  for (const extension of scanned.extensions) {
    extension.enabledByUser = opts.platform ? opts.platform.isEnabled(extension.id) : true;
    if (app && extension.publicDir && extension.enabledByUser) app.use(`/extensions/${extension.id}`, express.static(extension.publicDir));
    loadExtensionBackend(app, extension, opts.context || {}, lifecycle, opts.platform);
  }
  return {
    extensionsDir,
    extensions: scanned.extensions,
    conflicts: scanned.conflicts,
    lifecycle,
    publicPayload() {
      return {
        extensionsDir,
        extensions: this.extensions.map(publicExtension),
        conflicts: this.conflicts,
        lifecycleDiagnostics: this.lifecycle.publicDiagnostics(),
        platform: opts.platform ? opts.platform.diagnostics() : undefined,
      };
    },
    conflictSummary() {
      return this.conflicts.map((conflict) => conflict.type).join(', ');
    },
    notify(name, context) {
      return this.lifecycle.notify(name, context);
    },
    enrich(name, context) {
      return this.lifecycle.enrich(name, context);
    },
    evaluatePolicy(name, context) {
      return this.lifecycle.evaluatePolicy(name, context);
    },
    shutdown(context = {}) {
      return this.notify('app.stopping', context);
    },
  };
}

module.exports = {
  parseYamlSubset,
  scanExtensions,
  loadExtensions,
  installExtensionDirectory,
  installExtensionUpload,
  installExtensionGit,
};
