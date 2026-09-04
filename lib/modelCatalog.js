'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./core/paths');
const fallbacks = require('./modelFallbacks');
const { discoverCodex, discoverClaude } = require('./modelDiscovery');

const REFRESH_MS = 60 * 60 * 1000;

function normalizeModels(provider, rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid model list');
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    if (!row || row.hidden) continue;
    const id = provider === 'codex' ? row.model || row.id : row.value || row.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\s\x00-\x1f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const efforts = row.supportedReasoningEfforts || row.supportedEffortLevels || row.efforts;
    const model = { id, label: String(row.displayName || row.label || id).slice(0, 256) };
    if (typeof row.description === 'string') model.description = row.description.slice(0, 2000);
    if (Array.isArray(efforts)) {
      model.efforts = [...new Set(efforts.map((e) => typeof e === 'string' ? e : e?.reasoningEffort)
        .filter((e) => typeof e === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(e)))];
    } else if (row.supportsEffort === false) model.efforts = [];
    const defaultEffort = row.defaultReasoningEffort || row.defaultEffort;
    if (model.efforts?.includes(defaultEffort)) model.defaultEffort = defaultEffort;
    if (row.isDefault === true) model.isDefault = true;
    models.push(model);
  }
  if (!models.length) throw new Error('Provider returned no usable models');
  return models;
}

class ModelCatalog {
  constructor({ cacheFile = path.join(paths.APP_HOME, 'model-catalog.json'), discover = { codex: discoverCodex, claude: discoverClaude }, now = Date.now } = {}) {
    this.cacheFile = cacheFile;
    this.discover = discover;
    this.now = now;
    this.entries = {};
    this.inflight = new Map();
    this.controllers = new Map();
    this.bins = {};
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (data.version === 1) {
        for (const id of Object.keys(fallbacks)) {
          const entry = data.providers?.[id];
          if (entry && Number.isFinite(Date.parse(entry.updatedAt))) {
            this.entries[id] = { ...entry, models: normalizeModels(id, entry.models), source: 'cache' };
          }
        }
      }
    } catch { /* Missing or invalid cache: use the bundled fallback. */ }
  }

  configure(bins, environments = {}) {
    this.environments = environments;
    this.bins = { ...bins };
    for (const id of Object.keys(this.bins)) this.checkIdentity(id);
  }

  identity(id) {
    const env = this.environments?.[id]?.() || process.env;
    const files = id === 'codex'
      ? ['auth.json', 'config.toml'].map((file) => path.join(env.CODEX_HOME || path.join(require('os').homedir(), '.codex'), file))
      : ['.credentials.json', 'settings.json'].map((file) => path.join(env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'), file));
    const stats = [this.bins[id], ...files].map((file) => {
      try { const stat = fs.statSync(file); return [file, stat.mtimeMs, stat.size]; } catch { return [file]; }
    });
    // Hash environment identity without persisting or logging credentials.
    return crypto.createHash('sha256').update(JSON.stringify([stats, id === 'codex'
      ? [env.CODEX_HOME, env.OPENAI_BASE_URL, env.OPENAI_API_KEY, env.CODEX_ACCESS_TOKEN]
      : [env.CLAUDE_CONFIG_DIR, env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_KEY,
        env.ANTHROPIC_AUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN, env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX]])).digest('hex');
  }

  checkIdentity(id) {
    const identity = this.identity(id);
    if (this.entries[id] && this.entries[id].identity !== identity) delete this.entries[id];
    return identity;
  }

  snapshot(id) {
    const entry = this.entries[id];
    const models = entry?.models || fallbacks[id];
    return {
      models,
      defaultModel: models.find((m) => m.isDefault)?.id || models[0].id,
      modelCatalog: {
        source: entry?.source || 'fallback',
        updatedAt: entry?.updatedAt || null,
        stale: !entry?.updatedAt || this.now() - Date.parse(entry.updatedAt) >= REFRESH_MS || !!entry.error,
        refreshing: this.inflight.has(id),
        error: entry?.error || null,
      },
    };
  }

  refresh(id, { force = false } = {}) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    if (!this.bins[id] || !this.discover[id]) return Promise.resolve(this.snapshot(id));
    const identity = this.checkIdentity(id);
    const previous = this.entries[id];
    if (!force && previous?.checkedAt && this.now() - previous.checkedAt < REFRESH_MS) return Promise.resolve(this.snapshot(id));
    const controller = new AbortController();
    this.controllers.set(id, controller);
    // Start in a microtask so concurrent callers always share this operation.
    const operation = Promise.resolve().then(async () => {
      try {
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
        const rows = await this.discover[id](this.bins[id], { cwd: path.dirname(this.cacheFile), env: this.environments?.[id]?.() || process.env, signal: controller.signal });
        const models = normalizeModels(id, rows);
        if (identity !== this.identity(id)) return;
        this.entries[id] = { identity, models, source: 'live', updatedAt: new Date(this.now()).toISOString(), checkedAt: this.now() };
        this.persist();
      } catch (error) {
        if (identity === this.identity(id)) {
          this.entries[id] = { ...previous, identity, checkedAt: this.now(), error: error.message || 'Model discovery failed' };
        }
      }
    }).finally(() => { this.inflight.delete(id); this.controllers.delete(id); }).then(() => this.snapshot(id));
    this.inflight.set(id, operation);
    return operation;
  }

  persist() {
    const providers = {};
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.models) providers[id] = { identity: entry.identity, models: entry.models, updatedAt: entry.updatedAt };
    }
    const temporary = `${this.cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
    fs.renameSync(temporary, this.cacheFile);
  }

  refreshAll(options) { return Promise.all(Object.keys(this.bins).map((id) => this.refresh(id, options))); }
  start() {
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), REFRESH_MS);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
  }
}

const catalog = new ModelCatalog();
module.exports = { catalog, ModelCatalog, normalizeModels };
