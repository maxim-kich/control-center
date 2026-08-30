'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { autoCommitTaskProject } = require('../gitAutoCommit');
const { resolveProjectGit } = require('../gitRoots');
const { getProvider } = require('../providers');
const paths = require('./paths');
const { scanExtensions } = require('./extensions');
const { MANAGED_PERMISSIONS, OWNERSHIP_DOMAINS } = require('./extensionContract');

const REGISTRY_META_KEY = 'extensions.platform.registry.v1';
const OWNERSHIP_META_KEY = 'extensions.platform.ownership.v1';
const REGISTRY_VERSION = 1;
const MAX_PROCESS_OUTPUT = 16 * 1024;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function readJsonMeta(db, key, fallback) {
  try {
    const raw = db.getMetaValue(key, '');
    return raw ? JSON.parse(raw) : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

function writeJsonMeta(db, key, value) {
  db.setMetaValue(key, JSON.stringify(value));
  return value;
}

function versionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''];
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true });
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  return left[3].localeCompare(right[3], undefined, { numeric: true });
}

function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeChild(root, name) {
  const target = path.resolve(root, String(name || ''));
  if (!String(name || '') || !isWithin(root, target) || target === path.resolve(root)) {
    throw new Error('invalid extension storage path');
  }
  return target;
}

function copyExtensionTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter(from) {
      const base = path.basename(from);
      return base !== '.git' && base !== 'node_modules';
    },
  });
}

function runFile(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      timeout: opts.timeout || 30000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout || ''), stderr: String(stderr || '') };
      if (error) {
        const wrapped = new Error(String(stderr || stdout || error.message || 'command failed').trim());
        wrapped.code = error.code;
        wrapped.result = result;
        reject(wrapped);
        return;
      }
      resolve(result);
    });
  });
}

class ManagedProcessRegistry {
  constructor(owner) {
    this.owner = owner;
    this.processes = new Map();
    this.history = [];
  }

  record(item) {
    this.history.push({ ...item, at: new Date().toISOString() });
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
  }

  start(extension, name, command, args = [], opts = {}) {
    const id = `${extension.id}:${String(name || '').trim()}`;
    if (!String(name || '').trim()) throw new Error('managed process name is required');
    if (this.processes.has(id)) throw new Error(`managed process already running: ${id}`);
    this.owner.assertSideEffectOwner(extension, opts.ownership);
    const cwd = path.resolve(String(opts.cwd || extension.dir));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`managed process cwd does not exist: ${cwd}`);
    const child = spawn(String(command || ''), (args || []).map(String), {
      cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = {
      id,
      extensionId: extension.id,
      name: String(name),
      command: String(command),
      args: (args || []).map(String),
      cwd,
      pid: child.pid || null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      signal: null,
      output: '',
      child,
    };
    const append = (chunk) => {
      entry.output = (entry.output + String(chunk || '')).slice(-MAX_PROCESS_OUTPUT);
    };
    if (child.stdout) child.stdout.on('data', append);
    if (child.stderr) child.stderr.on('data', append);
    child.once('error', (error) => {
      append(errorMessage(error));
      this.record({ type: 'process-error', id, error: errorMessage(error) });
    });
    child.once('exit', (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
      entry.stoppedAt = new Date().toISOString();
      this.processes.delete(id);
      this.record({ type: 'process-exit', id, code, signal });
    });
    this.processes.set(id, entry);
    this.record({ type: 'process-start', id, pid: entry.pid });
    return this.publicEntry(entry);
  }

  run(extension, name, command, args = [], opts = {}) {
    const label = String(name || '').trim();
    if (!label) return Promise.reject(new Error('managed process name is required'));
    this.owner.assertSideEffectOwner(extension, opts.ownership);
    const cwd = path.resolve(String(opts.cwd || extension.dir));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return Promise.reject(new Error(`managed process cwd does not exist: ${cwd}`));
    }
    const runId = `${extension.id}:${label}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(1, Number(opts.timeoutMs)) : 30000;
    return new Promise((resolve) => {
      let settled = false;
      const entry = {
        id: runId,
        extensionId: extension.id,
        name: label,
        command: String(command),
        args: (args || []).map(String),
        cwd,
        pid: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        exitCode: null,
        signal: null,
        output: '',
        child: null,
      };
      const append = (chunk) => {
        entry.output = (entry.output + String(chunk || '')).slice(-MAX_PROCESS_OUTPUT);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.stoppedAt = new Date().toISOString();
        this.processes.delete(runId);
        this.record({
          type: 'process-run-exit',
          id: runId,
          code: entry.exitCode,
          signal: entry.signal,
          timedOut: !!result.timedOut,
        });
        resolve({ output: entry.output, ...result });
      };
      const timer = setTimeout(() => {
        if (entry.child) {
          try {
            entry.child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        }
        finish({ ok: false, timedOut: true, errorMessage: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref();

      try {
        entry.child = spawn(String(command || ''), (args || []).map(String), {
          cwd,
          env: { ...process.env, ...(opts.env || {}) },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        append(errorMessage(error));
        entry.exitCode = null;
        finish({ ok: false, error, errorMessage: errorMessage(error) });
        return;
      }
      entry.pid = entry.child.pid || null;
      this.processes.set(runId, entry);
      this.record({ type: 'process-run-start', id: runId, pid: entry.pid });
      if (entry.child.stdout) entry.child.stdout.on('data', append);
      if (entry.child.stderr) entry.child.stderr.on('data', append);
      entry.child.once('error', (error) => {
        append(errorMessage(error));
        entry.exitCode = null;
        this.record({ type: 'process-run-error', id: runId, error: errorMessage(error) });
        finish({ ok: false, error, errorMessage: errorMessage(error) });
      });
      entry.child.once('close', (code, signal) => {
        entry.exitCode = code;
        entry.signal = signal;
        finish({ ok: code === 0, code, signal });
      });
    });
  }

  stop(extensionId, name, signal = 'SIGTERM') {
    const id = `${extensionId}:${name}`;
    const entry = this.processes.get(id);
    if (!entry) return false;
    entry.child.kill(signal);
    this.record({ type: 'process-stop', id, signal });
    return true;
  }

  stopExtension(extensionId) {
    for (const entry of [...this.processes.values()]) {
      if (entry.extensionId === extensionId) this.stop(extensionId, entry.name);
    }
  }

  shutdown() {
    for (const entry of [...this.processes.values()]) this.stop(entry.extensionId, entry.name);
  }

  publicEntry(entry) {
    return {
      id: entry.id,
      extensionId: entry.extensionId,
      name: entry.name,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      pid: entry.pid,
      startedAt: entry.startedAt,
      stoppedAt: entry.stoppedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      output: entry.output,
    };
  }

  diagnostics() {
    return {
      running: [...this.processes.values()].map((entry) => this.publicEntry(entry)),
      history: clone(this.history),
    };
  }
}

class ExtensionPlatform {
  constructor(opts = {}) {
    if (!opts.db) throw new Error('extension platform requires db');
    this.db = opts.db;
    this.bundledDir = path.resolve(opts.bundledDir || path.join(paths.APP_ROOT, 'bundled-extensions'));
    this.extensionsDir = path.resolve(opts.extensionsDir || paths.EXTENSIONS_DIR);
    this.rollbackDir = path.resolve(opts.rollbackDir || path.join(this.extensionsDir, '.bundled-rollbacks'));
    this.providerSetup = opts.providerSetup || null;
    this.registry = readJsonMeta(this.db, REGISTRY_META_KEY, { version: REGISTRY_VERSION, extensions: {} });
    this.ownership = readJsonMeta(this.db, OWNERSHIP_META_KEY, { version: REGISTRY_VERSION, domains: {} });
    this.healthChecks = new Map();
    this.healthResults = new Map();
    this.diagnosticEvents = [];
    this.processes = new ManagedProcessRegistry(this);
    this.prepared = false;
  }

  saveRegistry() {
    this.registry.version = REGISTRY_VERSION;
    writeJsonMeta(this.db, REGISTRY_META_KEY, this.registry);
  }

  saveOwnership() {
    this.ownership.version = REGISTRY_VERSION;
    writeJsonMeta(this.db, OWNERSHIP_META_KEY, this.ownership);
  }

  record(item) {
    this.diagnosticEvents.push({ ...clone(item), at: new Date().toISOString() });
    if (this.diagnosticEvents.length > 200) this.diagnosticEvents.splice(0, this.diagnosticEvents.length - 200);
  }

  scans() {
    return {
      bundled: scanExtensions(this.bundledDir),
      installed: scanExtensions(this.extensionsDir),
    };
  }

  prepare() {
    fs.mkdirSync(this.extensionsDir, { recursive: true });
    const { bundled, installed } = this.scans();
    let changed = false;
    for (const extension of installed.extensions) {
      if (this.registry.extensions[extension.id]) {
        const state = this.registry.extensions[extension.id];
        let repaired = false;
        if (state.missing) {
          state.missing = false;
          repaired = true;
        }
        if (!state.origin) {
          state.origin = 'external';
          repaired = true;
        }
        if (state.installedVersion !== (extension.version || null)) {
          state.installedVersion = extension.version || null;
          repaired = true;
        }
        if (state.enabled == null) {
          state.enabled = true;
          repaired = true;
        }
        if (!state.migrations || typeof state.migrations !== 'object') {
          state.migrations = {};
          repaired = true;
        }
        if (repaired) {
          state.updatedAt = new Date().toISOString();
          changed = true;
        }
        continue;
      }
      this.registry.extensions[extension.id] = {
        id: extension.id,
        origin: 'external',
        installedVersion: extension.version || null,
        enabled: true,
        installedAt: null,
        updatedAt: new Date().toISOString(),
        migrations: {},
        rollback: null,
      };
      changed = true;
    }
    for (const [id, state] of Object.entries(this.registry.extensions)) {
      const extension = installed.extensions.find((item) => item.id === id);
      if (extension) continue;
      if (state.installedVersion != null) {
        state.missing = true;
        state.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.saveRegistry();
    this.reconcileOwnership(installed.extensions);
    this.prepared = true;
    return this.publicCatalog({ bundled, installed });
  }

  reloadState() {
    this.registry = readJsonMeta(this.db, REGISTRY_META_KEY, { version: REGISTRY_VERSION, extensions: {} });
    this.ownership = readJsonMeta(this.db, OWNERSHIP_META_KEY, { version: REGISTRY_VERSION, domains: {} });
    this.reconcileOwnership();
    return this.diagnostics();
  }

  stateFor(id) {
    return this.registry.extensions[id] || null;
  }

  isEnabled(id) {
    const state = this.stateFor(id);
    return state ? state.enabled !== false && !state.missing : true;
  }

  enabledInstalledExtensions(installedExtensions) {
    return (installedExtensions || this.scans().installed.extensions)
      .filter((extension) => this.isEnabled(extension.id) && extension.errors.length === 0);
  }

  ownershipClaims(extension) {
    return Array.isArray(extension && extension.ownership) ? extension.ownership : [];
  }

  duplicateOwners(installedExtensions) {
    const byDomain = new Map();
    for (const extension of this.enabledInstalledExtensions(installedExtensions)) {
      for (const domain of this.ownershipClaims(extension)) {
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(extension.id);
      }
    }
    return [...byDomain.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([domain, owners]) => ({ domain, owners }));
  }

  reconcileOwnership(installedExtensions) {
    const installed = installedExtensions || this.scans().installed.extensions;
    const enabled = this.enabledInstalledExtensions(installed);
    const duplicates = new Map(this.duplicateOwners(installed).map((item) => [item.domain, item.owners]));
    const domains = new Set([...OWNERSHIP_DOMAINS, ...Object.keys(this.ownership.domains || {})]);
    for (const extension of enabled) for (const domain of this.ownershipClaims(extension)) domains.add(domain);

    for (const domain of domains) {
      const current = this.ownership.domains[domain] || {};
      const preferredOwner = current.preferredOwner || 'legacy';
      let activeOwner = 'legacy';
      let fallbackReason = null;
      const duplicate = duplicates.get(domain);
      if (duplicate) {
        fallbackReason = `duplicate enabled owners: ${duplicate.join(', ')}`;
      } else if (preferredOwner !== 'legacy') {
        const extension = enabled.find((item) => item.id === preferredOwner && this.ownershipClaims(item).includes(domain));
        const state = this.stateFor(preferredOwner);
        if (!extension) fallbackReason = 'preferred extension is unavailable, disabled, or invalid';
        else if (state && state.unhealthyOwnership && state.unhealthyOwnership[domain]) fallbackReason = state.unhealthyOwnership[domain];
        else activeOwner = preferredOwner;
      }
      this.ownership.domains[domain] = {
        domain,
        preferredOwner,
        activeOwner,
        fallbackOwner: 'legacy',
        fallbackReason,
        updatedAt: new Date().toISOString(),
      };
      if (fallbackReason) this.record({ type: 'ownership-fallback', domain, preferredOwner, fallbackReason });
    }
    this.saveOwnership();
    return clone(this.ownership.domains);
  }

  owner(domain) {
    const state = this.ownership.domains[domain];
    return state ? state.activeOwner : 'legacy';
  }

  isOwner(domain, owner) {
    return this.owner(domain) === owner;
  }

  switchOwnership(domain, owner) {
    if (!OWNERSHIP_DOMAINS.has(domain)) throw new Error(`unknown ownership domain: ${domain}`);
    const requested = String(owner || '').trim();
    if (!requested) throw new Error('ownership owner is required');
    if (requested !== 'legacy') {
      const installed = this.scans().installed.extensions;
      const extension = installed.find((item) => item.id === requested);
      if (!extension || !this.isEnabled(requested) || extension.errors.length) throw new Error(`ownership extension is not enabled and healthy: ${requested}`);
      if (!this.ownershipClaims(extension).includes(domain)) throw new Error(`${requested} does not declare ownership of ${domain}`);
      const duplicates = this.duplicateOwners(installed).find((item) => item.domain === domain);
      if (duplicates) throw new Error(`duplicate enabled ownership for ${domain}: ${duplicates.owners.join(', ')}`);
    }
    this.ownership.domains[domain] = {
      ...(this.ownership.domains[domain] || {}),
      domain,
      preferredOwner: requested,
      updatedAt: new Date().toISOString(),
    };
    this.saveOwnership();
    this.reconcileOwnership();
    this.record({ type: 'ownership-switch', domain, owner: requested, activeOwner: this.owner(domain) });
    return clone(this.ownership.domains[domain]);
  }

  reportOwnershipFailure(domain, extensionId, error) {
    const state = this.stateFor(extensionId);
    if (!state) return null;
    state.unhealthyOwnership = state.unhealthyOwnership || {};
    state.unhealthyOwnership[domain] = errorMessage(error) || 'extension owner failed its health check';
    state.updatedAt = new Date().toISOString();
    this.saveRegistry();
    this.reconcileOwnership();
    return clone(this.ownership.domains[domain]);
  }

  reportOwnershipHealthy(domain, extensionId) {
    const state = this.stateFor(extensionId);
    if (!state || !state.unhealthyOwnership || !state.unhealthyOwnership[domain]) return null;
    delete state.unhealthyOwnership[domain];
    state.updatedAt = new Date().toISOString();
    this.saveRegistry();
    this.reconcileOwnership();
    return clone(this.ownership.domains[domain]);
  }

  assertSideEffectOwner(extension, requestedDomain) {
    const claims = this.ownershipClaims(extension);
    const domain = requestedDomain || (claims.length === 1 ? claims[0] : '');
    if (!domain) throw new Error('managed side effect requires an ownership domain');
    if (!claims.includes(domain)) throw new Error(`${extension.id} does not declare ownership of ${domain}`);
    if (!this.isOwner(domain, extension.id)) {
      throw new Error(`${extension.id} is not the active owner of ${domain}; active owner is ${this.owner(domain)}`);
    }
    return domain;
  }

  assertPermission(extension, permission) {
    if (!(extension.permissions || []).includes(permission)) throw new Error(`${extension.id} does not declare ${permission}`);
  }

  extensionById(id, source = 'installed') {
    return this.scans()[source].extensions.find((extension) => extension.id === id) || null;
  }

  assertEnableable(extension) {
    if (!extension) throw new Error('extension not found');
    if (extension.errors.length) throw new Error(`extension is invalid: ${extension.errors.join('; ')}`);
    const installed = this.enabledInstalledExtensions().filter((item) => item.id !== extension.id);
    for (const domain of this.ownershipClaims(extension)) {
      const owner = installed.find((item) => this.ownershipClaims(item).includes(domain));
      if (owner) throw new Error(`duplicate enabled ownership for ${domain}: ${owner.id}, ${extension.id}`);
    }
  }

  enable(id) {
    const extension = this.extensionById(id);
    this.assertEnableable(extension);
    this.runMigrations(extension);
    const state = this.stateFor(id) || {};
    const timestamp = new Date().toISOString();
    state.id = id;
    state.origin = state.origin || 'external';
    state.installedVersion = extension.version || state.installedVersion || null;
    state.installedAt = state.installedAt || timestamp;
    state.migrations = state.migrations && typeof state.migrations === 'object' ? state.migrations : {};
    state.rollback = state.rollback || null;
    state.enabled = true;
    state.missing = false;
    state.updatedAt = timestamp;
    this.registry.extensions[id] = state;
    this.saveRegistry();
    this.reconcileOwnership();
    this.record({ type: 'extension-enabled', extensionId: id });
    return this.extensionStatus(id);
  }

  disable(id) {
    const state = this.stateFor(id);
    if (!state) throw new Error(`extension is not installed: ${id}`);
    state.enabled = false;
    state.updatedAt = new Date().toISOString();
    this.saveRegistry();
    this.processes.stopExtension(id);
    this.reconcileOwnership();
    this.record({ type: 'extension-disabled', extensionId: id });
    return this.extensionStatus(id);
  }

  runMigrations(extension) {
    if (!extension || !extension.migrations.length) return [];
    this.assertPermission(extension, 'migrations:run');
    const state = this.stateFor(extension.id) || { id: extension.id, migrations: {} };
    state.migrations = state.migrations || {};
    const pending = extension.migrations.filter((migration) => !state.migrations[migration.id]);
    if (!pending.length) return [];
    if (!this.db.db || typeof this.db.db.transaction !== 'function') throw new Error('extension migrations require a transactional database');
    const appliedAt = new Date().toISOString();
    const nextState = clone(state);
    const apply = this.db.db.transaction(() => {
      for (const migration of pending) {
        if (!migration.path) throw new Error(`migration path is required: ${extension.id}:${migration.id}`);
        const file = path.resolve(extension.dir, migration.path);
        if (!isWithin(extension.dir, file) || !fs.existsSync(file)) throw new Error(`migration file not found: ${extension.id}:${migration.id}`);
        this.db.db.exec(fs.readFileSync(file, 'utf8'));
        nextState.migrations[migration.id] = { version: extension.version || null, appliedAt };
      }
      this.registry.extensions[extension.id] = nextState;
      this.saveRegistry();
    });
    apply();
    this.record({ type: 'migrations-applied', extensionId: extension.id, migrations: pending.map((item) => item.id) });
    return pending.map((item) => item.id);
  }

  installBundled(id, opts = {}) {
    const bundle = this.extensionById(id, 'bundled');
    if (!bundle) throw new Error(`bundled extension not found: ${id}`);
    if (!bundle.version) throw new Error(`bundled extension version is required: ${id}`);
    if (bundle.errors.length) throw new Error(`bundled extension is invalid: ${bundle.errors.join('; ')}`);
    const currentState = this.stateFor(id);
    const current = this.extensionById(id);
    if (current && !opts.upgrade && !opts.replace) throw new Error(`extension already installed: ${id}`);
    if (current && (!currentState || currentState.origin !== 'bundled')) {
      throw new Error(`refusing to replace non-bundled extension: ${id}`);
    }
    if (current && opts.upgrade && compareVersions(bundle.version, current.version) <= 0) {
      throw new Error(`bundled extension ${id} is not newer than installed version ${current.version}`);
    }

    fs.mkdirSync(this.extensionsDir, { recursive: true });
    fs.mkdirSync(this.rollbackDir, { recursive: true });
    const target = safeChild(this.extensionsDir, id);
    const staging = fs.mkdtempSync(path.join(this.extensionsDir, `.install-${id}-`));
    const stagedTarget = path.join(staging, id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = current ? path.join(this.rollbackDir, `${id}-${current.version || 'unknown'}-${stamp}`) : null;
    let targetMoved = false;
    try {
      copyExtensionTree(bundle.dir, stagedTarget);
      const stagedScan = scanExtensions(staging).extensions.find((item) => item.id === id);
      if (!stagedScan || stagedScan.errors.length) throw new Error(`staged bundled extension failed validation: ${(stagedScan && stagedScan.errors || []).join('; ')}`);
      if (current) {
        fs.renameSync(target, backup);
        targetMoved = true;
      }
      fs.renameSync(stagedTarget, target);
      const installedAt = currentState && currentState.installedAt || new Date().toISOString();
      this.registry.extensions[id] = {
        ...(currentState || {}),
        id,
        origin: 'bundled',
        installedVersion: bundle.version,
        enabled: currentState ? currentState.enabled !== false : !!opts.enable,
        missing: false,
        installedAt,
        updatedAt: new Date().toISOString(),
        migrations: currentState && currentState.migrations || {},
        rollback: current ? { path: backup, version: current.version || null } : null,
      };
      this.saveRegistry();
      if (this.registry.extensions[id].enabled) {
        const installed = this.extensionById(id);
        this.assertEnableable(installed);
        this.runMigrations(installed);
      }
      this.reconcileOwnership();
      this.record({ type: current ? 'bundled-extension-upgraded' : 'bundled-extension-installed', extensionId: id, version: bundle.version });
      return this.extensionStatus(id);
    } catch (error) {
      try {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        if (targetMoved && backup && fs.existsSync(backup)) fs.renameSync(backup, target);
        if (currentState) this.registry.extensions[id] = currentState;
        else delete this.registry.extensions[id];
        this.saveRegistry();
        this.reconcileOwnership();
      } catch (rollbackError) {
        error.rollbackError = errorMessage(rollbackError);
      }
      this.record({ type: 'bundled-extension-install-rollback', extensionId: id, error: errorMessage(error) });
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  upgradeBundled(id) {
    return this.installBundled(id, { upgrade: true });
  }

  rollbackBundled(id) {
    const state = this.stateFor(id);
    if (!state || state.origin !== 'bundled' || !state.rollback || !state.rollback.path) {
      throw new Error(`no bundled extension rollback available: ${id}`);
    }
    const rollbackPath = path.resolve(state.rollback.path);
    if (!isWithin(this.rollbackDir, rollbackPath) || !fs.existsSync(rollbackPath)) throw new Error(`bundled extension rollback is missing: ${id}`);
    const target = safeChild(this.extensionsDir, id);
    const failed = path.join(this.rollbackDir, `${id}-failed-${Date.now()}`);
    try {
      if (fs.existsSync(target)) fs.renameSync(target, failed);
      fs.renameSync(rollbackPath, target);
      const restored = this.extensionById(id);
      if (!restored || restored.errors.length) throw new Error(`rolled back extension is invalid: ${id}`);
      state.installedVersion = restored.version || state.rollback.version || null;
      state.rollback = null;
      state.updatedAt = new Date().toISOString();
      this.saveRegistry();
      this.reconcileOwnership();
      fs.rmSync(failed, { recursive: true, force: true });
      this.record({ type: 'bundled-extension-rolled-back', extensionId: id, version: state.installedVersion });
      return { ...this.extensionStatus(id), migrationsRetained: true };
    } catch (error) {
      try {
        if (fs.existsSync(target)) {
          if (!fs.existsSync(rollbackPath)) fs.renameSync(target, rollbackPath);
          else fs.rmSync(target, { recursive: true, force: true });
        }
        if (fs.existsSync(failed)) fs.renameSync(failed, target);
      } catch (rollbackError) {
        error.rollbackError = errorMessage(rollbackError);
      }
      throw error;
    }
  }

  extensionStatus(id) {
    const installed = this.extensionById(id);
    const bundled = this.extensionById(id, 'bundled');
    const state = this.stateFor(id);
    return {
      id,
      origin: state && state.origin || null,
      installed: !!installed,
      installedVersion: installed && installed.version || state && state.installedVersion || null,
      bundledVersion: bundled && bundled.version || null,
      updateAvailable: !!(installed && bundled && compareVersions(bundled.version, installed.version) > 0),
      enabled: !!(installed && this.isEnabled(id) && installed.errors.length === 0),
      restartRequired: true,
      rollbackAvailable: !!(state && state.rollback && state.rollback.path && fs.existsSync(state.rollback.path)),
      ownership: installed ? clone(installed.ownership || []) : [],
      errors: installed ? clone(installed.errors) : [],
    };
  }

  publicCatalog(scans) {
    const { bundled, installed } = scans || this.scans();
    const ids = new Set([
      ...bundled.extensions.map((item) => item.id),
      ...installed.extensions.map((item) => item.id),
      ...Object.keys(this.registry.extensions),
    ]);
    return [...ids].sort().map((id) => this.extensionStatus(id));
  }

  capabilitiesFor(extension, context = {}) {
    const granted = new Set(extension.permissions || []);
    const capabilities = {};
    if (granted.has('git:read') || granted.has('git:write')) {
      capabilities.git = Object.freeze({
        inspect: async (projectPath) => {
          const info = resolveProjectGit(projectPath);
          if (!info.repoRoot) return { ...info, branch: null, status: '' };
          const [branch, status] = await Promise.all([
            runFile('git', ['branch', '--show-current'], { cwd: info.repoRoot }),
            runFile('git', ['status', '--porcelain'], { cwd: info.repoRoot }),
          ]);
          return { ...info, branch: branch.stdout.trim() || null, status: status.stdout };
        },
        init: async (projectPath, opts = {}) => {
          this.assertPermission(extension, 'git:write');
          this.assertSideEffectOwner(extension, opts.ownership);
          const cwd = path.resolve(String(projectPath || ''));
          if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`project path does not exist: ${cwd}`);
          const existing = resolveProjectGit(cwd);
          if (existing.kind === 'parent') throw new Error(existing.warning);
          if (existing.hasOwnGit) return { initialized: false, repoRoot: existing.repoRoot };
          await runFile('git', ['init'], { cwd });
          return { initialized: true, repoRoot: cwd };
        },
        commitTask: async (task, opts = {}) => {
          this.assertPermission(extension, 'git:write');
          this.assertSideEffectOwner(extension, opts.ownership);
          return autoCommitTaskProject(task, opts);
        },
      });
    }
    if (granted.has('process:managed')) {
      capabilities.processes = Object.freeze({
        start: (name, command, args, opts) => this.processes.start(extension, name, command, args, opts),
        run: (name, command, args, opts) => this.processes.run(extension, name, command, args, opts),
        stop: (name, signal) => this.processes.stop(extension.id, name, signal),
        status: () => this.processes.diagnostics().running.filter((item) => item.extensionId === extension.id),
      });
    }
    if (this.ownershipClaims(extension).length) {
      capabilities.ownership = Object.freeze({
        activeOwner: (domain) => this.owner(domain),
        isActive: (domain) => this.isOwner(domain, extension.id),
        assert: (domain) => {
          this.assertSideEffectOwner(extension, domain);
          return true;
        },
      });
    }
    if (granted.has('providers:setup')) {
      capabilities.providers = Object.freeze({
        setup: async (providerId, project, opts = {}) => {
          this.assertSideEffectOwner(extension, opts.ownership);
          if (this.providerSetup) return this.providerSetup({ extension, providerId, project, opts, context });
          const provider = getProvider(providerId);
          const detected = provider.detect();
          if (!detected.installed) throw new Error(`${providerId} CLI not found`);
          const projectPath = provider.resolveProjectPath(project && project.path ? project.path : project);
          if (!provider.safeIsDir(projectPath)) throw new Error(`project path does not exist: ${projectPath}`);
          if (typeof provider.setupExtension === 'function') {
            const normalizedProject = project && typeof project === 'object' ? { ...project, path: projectPath } : { path: projectPath };
            return provider.setupExtension({ extension, project: normalizedProject, ...opts });
          }
          return {
            provider: detected.id,
            projectPath,
            installed: detected.installed,
            connected: detected.connected,
            capabilities: clone(detected.supports || {}),
          };
        },
        detect: (providerId) => getProvider(providerId).detect(),
      });
    }
    if (granted.has('health:checks')) {
      capabilities.health = Object.freeze({
        register: (name, check) => this.registerHealthCheck(extension.id, name, check),
        report: (name, result) => this.reportHealth(extension.id, name, result),
      });
    }
    if (granted.has('migrations:run')) {
      capabilities.migrations = Object.freeze({ applied: () => clone((this.stateFor(extension.id) || {}).migrations || {}) });
    }
    return Object.freeze(capabilities);
  }

  registerHealthCheck(extensionId, name, check) {
    if (typeof check !== 'function') throw new Error('health check must be a function');
    const id = `${extensionId}:${String(name || '').trim()}`;
    if (!String(name || '').trim()) throw new Error('health check name is required');
    this.healthChecks.set(id, { extensionId, name: String(name), check });
    return id;
  }

  reportHealth(extensionId, name, result) {
    const id = `${extensionId}:${name}`;
    const normalized = typeof result === 'boolean' ? { ok: result } : { ...(result || {}) };
    const value = { extensionId, name, ok: normalized.ok !== false, detail: normalized.detail || null, checkedAt: new Date().toISOString() };
    this.healthResults.set(id, value);
    return clone(value);
  }

  async runHealthChecks(extensionId) {
    const results = [];
    for (const entry of this.healthChecks.values()) {
      if (extensionId && entry.extensionId !== extensionId) continue;
      try {
        results.push(this.reportHealth(entry.extensionId, entry.name, await entry.check()));
      } catch (error) {
        results.push(this.reportHealth(entry.extensionId, entry.name, { ok: false, detail: errorMessage(error) }));
      }
    }
    const byExtension = new Map();
    for (const result of results) {
      if (!byExtension.has(result.extensionId)) byExtension.set(result.extensionId, []);
      byExtension.get(result.extensionId).push(result);
    }
    for (const [id, checks] of byExtension) {
      const extension = this.extensionById(id);
      if (!extension) continue;
      for (const domain of this.ownershipClaims(extension)) {
        const failed = checks.find((item) => !item.ok);
        if (failed) this.reportOwnershipFailure(domain, id, failed.detail || `${failed.name} health check failed`);
        else this.reportOwnershipHealthy(domain, id);
      }
    }
    return results;
  }

  permissionDiagnostics(extension) {
    const declared = extension.permissions || [];
    const rejectedPermissions = declared.filter((permission) =>
      extension.errors.some((error) => error.includes(`permission ${permission}`) || error.includes(`unknown permission ${permission}`)),
    );
    return {
      declared: clone(declared),
      managed: declared.filter((permission) => MANAGED_PERMISSIONS.has(permission)),
      granted: declared.filter((permission) => !rejectedPermissions.includes(permission)),
      rejected: clone(extension.errors.filter((error) => /permission|ownership/.test(error))),
    };
  }

  diagnostics() {
    const scans = this.scans();
    return {
      bundledDir: this.bundledDir,
      extensionsDir: this.extensionsDir,
      catalog: this.publicCatalog(scans),
      ownership: clone(this.ownership.domains),
      duplicateOwnership: this.duplicateOwners(scans.installed.extensions),
      permissions: Object.fromEntries(scans.installed.extensions.map((extension) => [extension.id, this.permissionDiagnostics(extension)])),
      health: [...this.healthResults.values()].map(clone),
      processes: this.processes.diagnostics(),
      events: clone(this.diagnosticEvents),
    };
  }

  shutdown() {
    this.processes.shutdown();
  }
}

module.exports = {
  ExtensionPlatform,
  ManagedProcessRegistry,
  compareVersions,
  REGISTRY_META_KEY,
  OWNERSHIP_META_KEY,
};
