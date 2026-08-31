'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('dashboard and project archive visibility have independent persisted state', () => {
  assert.match(app, /let dashboardShowArchive = false;/);
  assert.match(app, /let projectArchiveVisibility = \{\};/);
  assert.match(app, /dashboardShowArchive,\s*\n\s*projectArchiveVisibility,/);
  assert.match(app, /setDashboardShowArchive\(\$\('#showArchive'\)\.checked\)/);
  assert.match(app, /setProjectShowArchive\(\$\('#projectShowArchive'\)\.checked\)/);
  assert.doesNotMatch(app, /function setShowArchive\(/);
});

test('all core select controls use the shared in-app dropdown enhancer', () => {
  const selectIds = [...html.matchAll(/<select\s+id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(selectIds.sort(), ['f_model', 'projectFilter']);
  for (const id of selectIds) assert.match(app, new RegExp(`enhanceCustomSelect\\(\\$\\('#${id}'\\)\\)`));
  assert.match(css, /\.custom-select-menu\s*\{/);
  assert.match(css, /\.custom-select-option\.selected/);
});

test('boards keep equal tracks and independently scroll each column', () => {
  assert.match(css, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.col-body\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.column\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.card-desc\s*\{[\s\S]*?-webkit-line-clamp:\s*3;/);
});

test('terminal detail keeps only project identity metadata', () => {
  assert.match(html, /id="tdProject"/);
  assert.match(html, /id="tdPath"/);
  for (const removed of ['tdTokens', 'tdContext', 'tdModel', 'tdEffort']) {
    assert.doesNotMatch(html, new RegExp(`id="${removed}"`));
    assert.doesNotMatch(app, new RegExp(`#${removed}`));
  }
});

test('pointer focus stays neutral while keyboard focus remains visible', () => {
  assert.match(css, /input\[type='checkbox'\]:focus-visible/);
  assert.match(css, /\.form input:focus,[\s\S]*?border-color:\s*var\(--border-2\);/);
  assert.match(css, /\.form input\[type='range'\]:focus-visible/);
});

test('ASCII wordmark is a compact accessible link to the dashboard home', () => {
  assert.match(html, /<a id="appHomeLink" class="brand-home" href="\/" aria-label="Control Center home"/);
  assert.match(html, /class="brand-ascii-logo" aria-hidden="true">[\s\S]*?██████/);
  assert.match(css, /\.brand-ascii-logo\s*\{[\s\S]*?font:\s*600 5px\/6px "JetBrains Mono", monospace;/);
  assert.match(css, /\.brand-ascii-logo\s*\{[\s\S]*?linear-gradient\([\s\S]*?to bottom,[\s\S]*?var\(--color-visual-gradient-start\),[\s\S]*?var\(--color-visual-gradient-end\)/);
  assert.match(app, /\$\('#appHomeLink'\)\.addEventListener\('click',[\s\S]*?ev\.preventDefault\(\);[\s\S]*?setPage\('dashboard'\);/);
});

test('bundled integration modal actions keep page-edge padding', () => {
  assert.match(html, /<footer class="form-actions extension-modal-actions" id="extensionModalActions">/);
  assert.match(css, /\.extension-modal-actions\s*\{[\s\S]*?padding:\s*var\(--space-3\) var\(--space-4\) var\(--space-4\);/);
});

test('task form actions stay outside the scrollable form content', () => {
  assert.match(html, /<form id="taskForm" class="form task-form">[\s\S]*?<div class="task-form-scroll">[\s\S]*?<\/div>\s*<div class="form-actions task-form-actions">/);
  assert.match(css, /\.form\.task-form\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.task-form-scroll\s*\{[\s\S]*?overflow:\s*auto;/);
  assert.match(css, /\.task-form-actions\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?border-top:/);
});

test('a server boot change reloads stale extension UI state', () => {
  assert.match(server, /res\.setHeader\('X-Control-Center-Boot-Id', BOOT_ID\);/);
  assert.match(app, /function reloadForChangedServerBoot\(response\)[\s\S]*?response\.headers\.get\('x-control-center-boot-id'\)/);
  assert.match(app, /responseBootId === currentBootId\) return false;[\s\S]*?window\.location\.reload\(\);/);
  assert.equal((app.match(/reloadForChangedServerBoot\(r\)/g) || []).length, 2);
});

test('primary app surfaces use the compact shared horizontal gutter', () => {
  assert.match(css, /--page-gutter:\s*20px;/);
  for (const selector of ['.topbar', '.subpanel', '.board']) {
    assert.match(css, new RegExp(`\\${selector}\\s*\\{[\\s\\S]*?padding:[^;]*var\\(--page-gutter\\)`));
  }
  assert.match(css, /\.projects-shell,[\s\S]*?\.settings-shell\s*\{[\s\S]*?padding:[^;]*var\(--page-gutter\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?padding-inline:\s*var\(--space-4\);/);
});

test('task details Media button uses a plain text label', () => {
  assert.match(html, /<button id="tdMedia"[^>]*>Media<\/button>/);
  assert.doesNotMatch(html, /<button id="tdMedia"[^>]*>[^<]*🖼/);
});

test('task details Done button uses a plain text label', () => {
  assert.match(html, /<button id="termDone"[^>]*>Done<\/button>/);
  assert.doesNotMatch(html, /<button id="termDone"[^>]*>[^<]*✓/);
});

test('kanban and task details buttons use plain text labels', () => {
  assert.match(html, /<button class="btn btn-sm" data-close="detailsModal">Close<\/button>/);
  for (const label of ['Details', 'Unarchive', 'Start', 'Edit', 'Open', 'Resume', 'Fork']) {
    assert.match(app, new RegExp(`h\\('button',[^\\n]+(?:'${label}'|\\? '${label}')`));
  }
  for (const symbol of ['☰', '⟲', '▶', '✎', '⧉', '⑂']) {
    assert.doesNotMatch(app, new RegExp(`h\\('button',[^\\n]+${symbol}`));
  }
});

test('Media modal Upload control uses a plain text label', () => {
  assert.match(html, /<label[^>]*id="mediaUploadBtn"[^>]*>Upload<\/label>/);
  assert.doesNotMatch(html, /<label[^>]*id="mediaUploadBtn"[^>]*>[^<]*⤒/);
});

test('dashboard and project header actions use plain text labels', () => {
  assert.match(html, /<button id="newTaskBtn"[^>]*>New task<\/button>/);
  assert.match(html, /<button id="newProjectBtn"[\s\S]*?<span>New<\/span>[\s\S]*?<\/button>/);
  assert.match(html, /<button id="editProjectBtn"[^>]*>Edit<\/button>/);
  assert.match(html, /<button id="newProjectTaskBtn"[^>]*>New task<\/button>/);
  for (const id of ['newTaskBtn', 'newProjectBtn', 'editProjectBtn', 'newProjectTaskBtn']) {
    assert.doesNotMatch(html, new RegExp(`<button id="${id}"[^>]*>[\\s\\S]*?[+✎][\\s\\S]*?<\\/button>`));
  }
});
