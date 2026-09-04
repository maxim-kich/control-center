'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function source(start, end) {
  assert.ok(app.includes(start) && app.includes(end));
  return app.slice(app.indexOf(start), app.indexOf(end));
}

function harness() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: false,
      closest() { return this; }, focus() {},
      addEventListener(event, handler) { this[event] = handler; },
    });
    return elements.get(id);
  };
  const cache = new Map();
  const mode = { value: 'build' };
  const context = {
    $, COLUMNS: ['backlog', 'in_progress', 'done'], byId: new Map(),
    tabs: { activeId: null }, STATUS_LABELS: {}, EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    EFFORT_LABELS: [], taskUploads: [], projectValue: '', healthYoloDefault: false,
    document: { querySelector: (selector) => selector.includes('f_mode') ? mode : { querySelector: $ } },
    boardCardCache: () => cache, extensionRenderVersion: () => 0,
    stableReplaceChildren() {}, renderExtensionNodes: () => [], displayProject: (p) => p,
    h(tag, attrs, ...children) {
      return { tag, ...attrs, children, dataset: attrs.dataset || {},
        append(...nodes) { this.children.push(...nodes); }, addEventListener() {} };
    },
    syncTaskProviderControls(task) {
      $('#f_model').value = task.model;
      $('#f_ultracode').checked = !!task.ultracode;
      mode.value = task.mode;
    },
    refreshModeUi() {}, setProjectLabel() {}, renderUploadList() {}, loadProjects() {},
    show() {}, hide() {}, setTimeout() {}, toast(message) { assert.fail(message); },
  };
  vm.createContext(context);
  for (const code of [
    source('function isEditable(', 'function taskSource('),
    source('function taskBoardSignature(', 'function boardSignature('),
    source('function columnSortValue(', 'function stableReplaceChildren('),
    source('function renderTaskBoard(', 'function clearBoardDropIndicators('),
    source('function openTaskModal(', "$('#f_effort').addEventListener"),
    source("$('#taskForm').addEventListener('submit'", '/* project picker dropdown */'),
  ]) vm.runInContext(code, context);
  return { context, $, cache };
}
const original = {
  id: 'task', status: 'backlog', title: 'Test', description: '', project_path: '/project',
  provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', mode: 'build',
  yolo: false, ultracode: false, started_at: null,
};

for (const [field, value] of Object.entries({
  provider: 'claude', model: 'gpt-6-astra', effort: 'high', mode: 'plan',
  yolo: true, ultracode: true, started_at: '2026-09-04T12:00:00Z',
})) {
  test(`changing ${field} invalidates its card while unchanged cards stay cached`, () => {
    const { context: c, cache } = harness();
    const other = { ...original, id: 'other' };
    c.renderTaskBoard('dashboard', [original, other], 'Empty');
    const before = cache.get(original.id).el;
    const unchanged = cache.get(other.id).el;
    const saved = { ...original, [field]: value };
    assert.notEqual(c.taskBoardSignature(original), c.taskBoardSignature(saved));
    c.renderTaskBoard('dashboard', [saved, { ...other }], 'Empty');
    assert.notEqual(cache.get(original.id).el, before);
    assert.equal(cache.get(other.id).el, unchanged);
    let edited;
    c.openTaskModal = (task) => { edited = task; };
    const actions = cache.get(original.id).el.children.find((node) => node.class === 'card-actions');
    actions.children.find((node) => node.children.includes('Edit')).onclick();
    assert.equal(edited, saved, 'Edit must receive the latest task object');
    const current = cache.get(original.id).el;
    c.renderTaskBoard('dashboard', [{ ...saved }, { ...other }], 'Empty');
    assert.equal(cache.get(original.id).el, current);
  });
}

test('save waits for refresh before closing, and reopening then saving preserves settings', async () => {
  const { context: c, $, cache } = harness();
  let stored = { ...original };
  c.api = { async send(method, url, body) {
    assert.equal(method, 'PATCH');
    assert.equal(url, '/api/tasks/task');
    stored = { ...stored, ...body };
  } };
  let finishRefresh;
  let closed = false;
  c.hide = () => { closed = true; };
  c.refresh = async (force) => {
    assert.equal(force, true);
    await new Promise((resolve) => { finishRefresh = resolve; });
    c.renderTaskBoard('dashboard', [{ ...stored }], 'Empty');
  };
  const edit = () => {
    const actions = cache.get('task').el.children.find((node) => node.class === 'card-actions');
    actions.children.find((node) => node.children.includes('Edit')).onclick();
  };
  c.renderTaskBoard('dashboard', [stored], 'Empty');
  edit();
  $('#f_model').value = 'gpt-6-astra';
  $('#f_effort').value = 2;
  c.document.querySelector('f_mode').value = 'plan';
  $('#f_ultracode').checked = true;
  for (let save = 0; save < 2; save++) {
    closed = false;
    const pending = $('#taskForm').submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, 'form must stay open while refresh is pending');
    finishRefresh();
    await pending;
    assert.equal(closed, true);
    edit();
    assert.equal($('#f_model').value, 'gpt-6-astra');
    assert.equal($('#f_effort').value, 2);
    assert.equal(c.document.querySelector('f_mode').value, 'plan');
    assert.equal($('#f_ultracode').checked, true);
    assert.equal(stored.model, 'gpt-6-astra');
    assert.equal(stored.effort, 'high');
    assert.equal(stored.mode, 'plan');
  }
});
