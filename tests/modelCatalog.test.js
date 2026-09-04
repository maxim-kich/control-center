'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelCatalog, normalizeModels } = require('../lib/modelCatalog');
const { discoverCodex, discoverClaude } = require('../lib/modelDiscovery');

function fixture(t, discover) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-catalog-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { cacheFile: path.join(dir, 'catalog.json'), discover };
  const catalog = new ModelCatalog(options);
  catalog.configure({ codex: '/missing/test-codex', claude: '/missing/test-claude' });
  return { catalog, dir, options };
}

test('normalizes new model IDs, capabilities, hidden entries and duplicates without an allowlist', () => {
  assert.deepEqual(normalizeModels('codex', [
    { model: 'future-model', displayName: 'Future', isDefault: true, defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, { reasoningEffort: 'new-effort' }] },
    { model: 'future-model' }, { model: 'secret', hidden: true }, { model: 'invalid model' }, null,
  ]), [{ id: 'future-model', label: 'Future', efforts: ['ultra', 'new-effort'], defaultEffort: 'ultra', isDefault: true }]);
  assert.deepEqual(normalizeModels('claude', [{ value: 'opus[1m]', displayName: 'Opus', supportedEffortLevels: ['high', 'max'] }]),
    [{ id: 'opus[1m]', label: 'Opus', efforts: ['high', 'max'] }]);
  assert.throws(() => normalizeModels('codex', [{ model: 'hidden', hidden: true }]), /no usable/);
});

test('serves immediately during a deduplicated refresh, persists success and retains it after failure', async (t) => {
  let release;
  let calls = 0;
  const { catalog, options } = fixture(t, { codex: async () => { calls++; return new Promise((r) => { release = r; }); } });
  const first = catalog.refresh('codex');
  assert.equal(catalog.refresh('codex', { force: true }), first);
  assert.equal(catalog.snapshot('codex').modelCatalog.source, 'fallback');
  assert.equal(catalog.snapshot('codex').modelCatalog.refreshing, true);
  await Promise.resolve();
  release([{ model: 'future', displayName: 'Future', isDefault: true }]);
  await first;
  assert.equal(calls, 1);
  assert.equal(catalog.snapshot('codex').defaultModel, 'future');
  await catalog.refresh('codex');
  assert.equal(calls, 1);
  const restarted = new ModelCatalog(options);
  restarted.configure(catalog.bins);
  assert.equal(restarted.snapshot('codex').modelCatalog.source, 'cache');
  assert.equal(restarted.snapshot('codex').defaultModel, 'future');
  catalog.discover.codex = async () => { throw new Error('offline'); };
  await catalog.refresh('codex', { force: true });
  const state = catalog.snapshot('codex');
  assert.equal(state.models[0].id, 'future');
  assert.equal(state.modelCatalog.error, 'offline');
  assert.equal(state.modelCatalog.stale, true);
});

test('provider failures are independent and empty responses never replace a usable catalog', async (t) => {
  const { catalog } = fixture(t, {
    codex: async () => [{ model: 'new-codex' }],
    claude: async () => { throw new Error('not installed'); },
  });
  await catalog.refreshAll();
  assert.equal(catalog.snapshot('codex').models[0].id, 'new-codex');
  assert.equal(catalog.snapshot('claude').modelCatalog.source, 'fallback');
  catalog.discover.codex = async () => [];
  await catalog.refresh('codex', { force: true });
  assert.equal(catalog.snapshot('codex').models[0].id, 'new-codex');
  catalog.configure({ codex: '/different/bin' });
  assert.equal(catalog.snapshot('codex').modelCatalog.source, 'fallback');
});

function executable(dir, text) {
  const file = path.join(dir, 'fake-cli');
  fs.writeFileSync(file, `#!${process.execPath}\n${text}`, { mode: 0o700 });
  return file;
}

test('Codex discovery performs the handshake, follows pagination and ignores notifications', async (t) => {
  const { dir } = fixture(t, {});
  const bin = executable(dir, `
    const readline = require('readline'); let initialized = false;
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if(m.method === 'initialized') { initialized = true; return; }
      let result;
      if(m.method === 'initialize') result = {};
      else if(m.method === 'model/list' && initialized) {
        result = m.params.cursor === 'page2' ? {data:[{model:'second'}],nextCursor:null} : {data:[{model:'first'}],nextCursor:'page2'};
      } else process.exit(2);
      process.stdout.write(JSON.stringify({method:'notification'})+'\\n');
      const text = JSON.stringify({id:m.id,result})+'\\n';
      process.stdout.write(text.slice(0,5)); setImmediate(()=>process.stdout.write(text.slice(5)));
    });
  `);
  assert.deepEqual(await discoverCodex(bin), [{ model: 'first' }, { model: 'second' }]);
});

test('discovery bounds stalled CLIs and handles missing binaries', async (t) => {
  const { dir } = fixture(t, {});
  const bin = executable(dir, 'setInterval(()=>{},1000);');
  await assert.rejects(discoverCodex(bin, { timeoutMs: 100 }), /timed out/);
  await assert.rejects(discoverClaude(bin, { timeoutMs: 500 }), /timed out/);
  await assert.rejects(discoverCodex(path.join(dir, 'missing')), /could not be started/);
});
