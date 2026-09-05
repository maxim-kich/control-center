'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function harness() {
  const elements = new Map();
  const requests = [];
  const messages = [];
  const context = {
    $(id) {
      if (!elements.has(id)) elements.set(id, { focus() {} });
      return elements.get(id);
    },
    GENERAL_SETTINGS: { version: { version: '0.1.4', latestReleaseVersion: '0.1.5' } },
    updateActionSaving: null, restartingServer: false, quittingServer: false,
    show(id) { context.$('#' + id).hidden = false; },
    hide(id) { context.$('#' + id).hidden = true; },
    renderVersionSettings() {}, renderGeneralSettings() {},
    toast(message) { messages.push(message); },
    manager: { liveTaskIds: () => ['active-task', 'active-console'] },
  };
  vm.createContext(context);
  vm.runInContext(server.slice(server.indexOf('function rejectLiveSessions('), server.indexOf("app.post('/api/update/dry-run'")), context);
  context.api = { async send(method, url, body) {
    requests.push({ method, url, body });
    if (url !== '/api/update/dry-run') {
      let rejection;
      const response = { status() { return this; }, json(value) { rejection = value; } };
      if (context.rejectLiveSessions({ body }, response)) throw new Error(rejection.error);
    }
    return { ok: true };
  } };
  vm.runInContext(app.slice(app.indexOf('async function runUpdateAction('), app.indexOf('function skillProviderName(')), context);
  return { context, requests, messages };
}

for (const kind of ['apply', 'rollback']) {
  test(`${kind} asks before authorizing closure of all active sessions`, async () => {
    const { context: c, requests, messages } = harness();
    await c.runUpdateAction(kind);
    assert.equal(requests.length, 0, 'opening or cancelling the modal must not update or stop sessions');
    assert.equal(c.$('#updateConfirmModal').hidden, false);
    assert.match(c.$('#confirmUpdateBtn').textContent, /Close sessions and/);
    await c.confirmUpdateAction();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `/api/update/${kind}`);
    assert.equal(requests[0].body.force, true);
    assert.equal(c.$('#updateConfirmModal').hidden, true);
    assert.ok(messages.some((message) => message.endsWith('passed')));
    await c.confirmUpdateAction();
    assert.equal(requests.length, 1, 'confirmation cannot be submitted twice');
  });
}

test('dry runs do not authorize session closure and unconfirmed updates retain the guard', async () => {
  const { context: c, requests, messages } = harness();
  await c.runUpdateAction('dryRun');
  assert.equal(requests[0].body.force, undefined);
  await c.executeUpdateAction('apply');
  assert.equal(requests[1].body.force, undefined);
  assert.ok(messages.some((message) => message.includes('active terminal sessions')));
});

test('the accessible confirmation explains preservation and relaunching', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /aria-describedby="updateConfirmDescription updateConfirmSessions"/);
  assert.match(html, /All active consoles and sessions will close when the app restarts/);
  assert.match(html, /Your task data and saved conversations will stay in each task/);
  assert.match(html, /You can relaunch sessions from their tasks after the update/);
});
