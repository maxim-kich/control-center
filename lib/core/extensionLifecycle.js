'use strict';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_DIAGNOSTICS = 200;

const SUPPORTED_HOOKS = new Set([
  'app.started',
  'app.stopping',
  'task.statusChanged',
  'task.completed',
  'project.created',
  'project.updated',
  'project.archived',
  'project.unarchived',
  'project.deleted',
  'project.metadata',
  'git.autoCommitPolicy',
  'update.checking',
  'update.checked',
  'migration.before',
  'migration.after',
]);

function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.round(parsed), 1), MAX_TIMEOUT_MS);
}

function normalizeHookDeclarations(rawHooks) {
  if (!rawHooks || typeof rawHooks !== 'object' || Array.isArray(rawHooks)) return [];
  return Object.entries(rawHooks).map(([name, raw]) => {
    const config = typeof raw === 'number' ? { order: raw } : raw || {};
    return {
      name: String(name || '').trim(),
      order: Number.isFinite(Number(config.order)) ? Number(config.order) : 100,
      timeoutMs: clampTimeout(config.timeoutMs || config.timeout_ms),
    };
  }).filter((hook) => hook.name);
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`);
        error.code = 'EXTENSION_HOOK_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function stateCapability(db, extensionId) {
  return Object.freeze({
    get(scopeType = 'global', scopeId = 'global') {
      return db.listExtensionState(extensionId, scopeType, scopeId);
    },
    set(scopeType, scopeId, values) {
      return db.setExtensionState(extensionId, scopeType, scopeId, values);
    },
    setValue(scopeType, scopeId, key, value) {
      return db.setExtensionStateValue(extensionId, scopeType, scopeId, key, value);
    },
    delete(scopeType, scopeId, key) {
      return db.deleteExtensionStateValue(extensionId, scopeType, scopeId, key);
    },
  });
}

class ExtensionLifecycle {
  constructor(opts = {}) {
    this.db = opts.db;
    this.defaultTimeoutMs = clampTimeout(opts.timeoutMs);
    this.capabilityFactory = typeof opts.capabilityFactory === 'function' ? opts.capabilityFactory : null;
    this.handlers = [];
    this.diagnostics = [];
  }

  register(extension, moduleExports) {
    const exported = moduleExports && moduleExports.hooks;
    for (const declaration of extension.hooks || []) {
      const handler = exported && exported[declaration.name];
      if (typeof handler !== 'function') {
        extension.errors.push(`missing backend handler for hook ${declaration.name}`);
        continue;
      }
      this.handlers.push({
        extension,
        name: declaration.name,
        order: declaration.order,
        timeoutMs: clampTimeout(declaration.timeoutMs, this.defaultTimeoutMs),
        handler,
      });
    }
    this.handlers.sort((a, b) => a.order - b.order || a.extension.id.localeCompare(b.extension.id));
  }

  handlersFor(name) {
    return this.handlers.filter((entry) => entry.name === name && entry.extension.enabledByUser !== false && entry.extension.errors.length === 0);
  }

  capability(entry) {
    const prefix = `[extension:${entry.extension.id}]`;
    const capability = {
      extension: Object.freeze({
        id: entry.extension.id,
        name: entry.extension.name,
        version: entry.extension.version,
      }),
      logger: Object.freeze({
        info: (...args) => console.log(prefix, ...args),
        warn: (...args) => console.warn(prefix, ...args),
        error: (...args) => console.error(prefix, ...args),
      }),
    };
    if ((entry.extension.permissions || []).includes('api:extension-state') && this.db) {
      capability.state = stateCapability(this.db, entry.extension.id);
    }
    if (this.capabilityFactory) {
      const managed = this.capabilityFactory(entry.extension) || {};
      for (const [name, value] of Object.entries(managed)) {
        if (!(name in capability)) capability[name] = value;
      }
    }
    return Object.freeze(capability);
  }

  record(item) {
    this.diagnostics.push(item);
    if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
  }

  async invoke(entry, context) {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        entry.handler(clone(context || {}), this.capability(entry)),
        entry.timeoutMs,
        `${entry.extension.id}:${entry.name}`,
      );
      const outcome = {
        extensionId: entry.extension.id,
        hook: entry.name,
        order: entry.order,
        ok: true,
        durationMs: Date.now() - startedAt,
        result: clone(result),
      };
      this.record({ ...outcome, at: new Date().toISOString() });
      return outcome;
    } catch (error) {
      const outcome = {
        extensionId: entry.extension.id,
        hook: entry.name,
        order: entry.order,
        ok: false,
        timedOut: error && error.code === 'EXTENSION_HOOK_TIMEOUT',
        durationMs: Date.now() - startedAt,
        error: errorMessage(error),
      };
      this.record({ ...outcome, at: new Date().toISOString() });
      return outcome;
    }
  }

  async notify(name, context, { extensionId } = {}) {
    const results = [];
    for (const entry of this.handlersFor(name)) {
      if (extensionId != null && entry.extension.id !== extensionId) continue;
      results.push(await this.invoke(entry, context));
    }
    return { hook: name, ok: results.every((result) => result.ok), results };
  }

  async enrich(name, context) {
    const results = [];
    const metadata = {};
    for (const entry of this.handlersFor(name)) {
      const outcome = await this.invoke(entry, context);
      results.push(outcome);
      if (outcome.ok && outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result)) {
        metadata[entry.extension.id] = outcome.result;
      }
    }
    return { hook: name, ok: results.every((result) => result.ok), metadata, results };
  }

  async evaluatePolicy(name, context) {
    const results = [];
    const decisions = [];
    for (const entry of this.handlersFor(name)) {
      const outcome = await this.invoke(entry, context);
      results.push(outcome);
      if (!outcome.ok) continue;
      const decision = outcome.result && outcome.result.decision;
      if (!['allow', 'deny', 'abstain'].includes(decision)) continue;
      decisions.push({
        extensionId: entry.extension.id,
        decision,
        reason: String(outcome.result.reason || ''),
      });
    }
    const allows = decisions.filter((item) => item.decision === 'allow');
    const denies = decisions.filter((item) => item.decision === 'deny');
    const conflict = allows.length > 0 && denies.length > 0;
    if (conflict) {
      this.record({
        type: 'policy-conflict',
        hook: name,
        at: new Date().toISOString(),
        decisions: clone(decisions),
      });
    }
    return {
      hook: name,
      decision: denies.length ? 'deny' : allows.length ? 'allow' : 'abstain',
      reason: denies.length ? denies.map((item) => item.reason).filter(Boolean).join('; ') : '',
      conflict,
      decisions,
      results,
    };
  }

  publicDiagnostics() {
    return clone(this.diagnostics);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  SUPPORTED_HOOKS,
  ExtensionLifecycle,
  normalizeHookDeclarations,
};
