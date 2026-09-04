'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');

function harness(models) {
  const elements = {
    '#f_model': { value: '', replaceChildren(...options) { this.options = options; } },
    '#f_effort': { value: '1' }, '#effortLabel': {},
  };
  const provider = { id: 'codex', models, defaultModel: models[0].id };
  const context = {
    $: (id) => elements[id], EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    MODEL_CONNECTIONS: { providers: [provider] },
    modelLabel: (id) => id, effortLabel: (e) => e,
    syncCustomSelect() {}, h: (tag, attrs, label) => ({ ...attrs, label }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("let taskProviderId ="), source.indexOf('function activeProviderInfo()')), context);
  return { context, elements, provider };
}

test('new models and their reasoning levels become selectable without frontend constants', () => {
  const { context: c, elements: e, provider } = harness([{ id: 'future', label: 'Future', efforts: ['high', 'max', 'ultra'], defaultEffort: 'max' }]);
  c.syncTaskModelOptions(provider);
  c.syncTaskEffortControls();
  assert.equal(e['#f_model'].value, 'future');
  assert.equal(e['#f_effort'].max, '2');
  assert.equal(c.taskEffortValue(), 'max');
  e['#f_effort'].value = '2';
  assert.equal(c.taskEffortValue(), 'ultra');
});

test('editing a saved or removed model preserves its exact model and effort', () => {
  const { context: c, elements: e, provider } = harness([{ id: 'new', label: 'New', efforts: ['medium'] }]);
  c.syncTaskModelOptions(provider, 'retired');
  c.syncTaskEffortControls('max', true);
  assert.equal(e['#f_model'].value, 'retired');
  assert.ok(e['#f_model'].options.some((o) => o.value === 'retired'));
  assert.equal(c.taskEffortValue(), 'max');
  // A refresh must preserve a draft that the user has already changed.
  c.syncTaskModelOptions(provider, 'new');
  c.syncTaskEffortControls(c.taskEffortValue(), true);
  assert.equal(c.taskEffortValue(), 'max');
});

test('changing model uses supported efforts and disables the control when unsupported', () => {
  const { context: c, elements: e, provider } = harness([
    { id: 'small', efforts: ['low', 'medium'] }, { id: 'fixed', efforts: [] },
  ]);
  c.syncTaskModelOptions(provider, 'small');
  c.syncTaskEffortControls('ultra');
  assert.equal(c.taskEffortValue(), 'medium');
  c.syncTaskModelOptions(provider, 'fixed');
  c.syncTaskEffortControls();
  assert.equal(e['#f_effort'].disabled, true);
  assert.equal(e['#effortLabel'].textContent, 'Default');
});
