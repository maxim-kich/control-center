'use strict';

/* ------------------------------------------------------------------ helpers */

function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

function svgIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function bellIcon(slashed) {
  const paths = [
    'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9',
    'M10.3 21a2 2 0 0 0 3.4 0',
  ];
  if (slashed) paths.push('M4 4l16 16');
  return svgIcon(paths);
}

const $ = (sel) => document.querySelector(sel);
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

let toastTimer = null;
function toast(msg, opts) {
  opts = opts || {};
  const old = $('.toast');
  if (old) old.remove();
  const t = h('div', { class: 'toast' + (opts.err ? ' err' : '') }, msg);
  if (opts.undo) {
    t.append(h('span', { class: 'undo', onclick: () => { t.remove(); opts.undo(); } }, 'Undo'));
  }
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), opts.undo ? 6000 : 3800);
}

const shortId = (id) => (id ? id.slice(0, 8) : '');
function fmtNum(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_LABELS = ['Low', 'Medium', 'High', 'X-High'];
const MODEL_LABELS = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};
const modelLabel = (m) => MODEL_LABELS[m] || m || '—';
const effortLabel = (e) => EFFORT_LABELS[EFFORTS.indexOf(e)] || e || '—';
const STATUS_LABELS = { waiting: 'Waiting for go', running: 'Running', needs_attention: 'Needs attention', done: 'Done' };
const SUBTASK_LABELS = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled', removed: 'Removed' };
const GRAPHIFY_LABELS = {
  pending: 'Graphify pending',
  queued: 'Graphify working',
  running: 'Graphify working',
  current: 'Graphify up to date',
  stale: 'Graphify needs update',
  missing: 'Graphify missing',
  error: 'Graphify error',
  disabled: 'Graphify off',
};
const MODEL_STATUS_LABELS = {
  connected: 'Connected',
  needs_auth: 'Needs auth',
  missing: 'Missing',
};

/* ------------------------------------------------------------------- state */

let TASKS = [];
let PROJECTS = [];
let MODEL_CONNECTIONS = { activeProvider: 'codex', providers: [], updatedAt: null };
let GENERAL_SETTINGS = { caffeinateEnabled: true, caffeinate: null, version: null };
let EXTENSION_SETTINGS = { extensionsDir: '', extensions: [], conflicts: [] };
let byId = new Map();
let lastSig = null;
let workspaceRoot = null;
let projectFilter = '';
let selectedProjectId = null;
let currentPage = 'dashboard';
let currentSettingsSection = 'general';
let showArchive = false;
let healthYoloDefault = true;
let ultracodeEnabled = false;
let currentBootId = null;
let restartingServer = false;
let quittingServer = false;
let generalSettingsSaving = false;
let updateCheckSaving = false;
let updateActionSaving = null;
let archivedCache = [];
let tabsRestored = false; // one-shot guard: re-open live terminals on the first page load
const OPEN_TABS_KEY = 'dashboard.openTabs'; // persisted { ids, activeId } for the terminal tabs
const OLD_OPEN_TABS_KEY = 'planora.openTabs';
const BOARD_RENDER_SETTLE_MS = 180;
const TERMINAL_WRITE_CHUNK = 64 * 1024;
let pendingBoardRender = false;
let pendingProjectFilterSync = false;
let boardRenderTimer = null;
let deferBoardRenderUntil = 0;
let mouseButtonDown = false;
const activePointers = new Set();
const cardCaches = new Map();

function migrateStorageKey(oldKey, newKey) {
  try {
    if (localStorage.getItem(newKey) == null && localStorage.getItem(oldKey) != null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey));
      localStorage.removeItem(oldKey);
    }
  } catch {
    /* storage unavailable — best-effort */
  }
}
migrateStorageKey(OLD_OPEN_TABS_KEY, OPEN_TABS_KEY);

function relPath(p) {
  if (workspaceRoot && p && p.startsWith(workspaceRoot + '/')) return p.slice(workspaceRoot.length + 1);
  return p;
}
function projectByPath(projectPath) {
  return PROJECTS.find((p) => p.path === projectPath) || null;
}

function projectById(id) {
  return PROJECTS.find((p) => p.id === id) || null;
}

function selectedProject() {
  return projectById(selectedProjectId);
}

// Display a project by its dashboard name, falling back to the folder name.
function displayProject(p) {
  const project = projectByPath(p);
  if (project && project.name) return project.name;
  if (!p) return '';
  const parts = String(p).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function graphifyUiState(project) {
  if (project && project.graphify_enabled === 0) return 'disabled';
  const status = (project && project.graphify_status) || 'pending';
  if (status === 'queued' || status === 'running') return 'working';
  if (status === 'current') return 'current';
  if (status === 'stale') return 'stale';
  if (status === 'missing') return 'missing';
  if (status === 'error') return 'error';
  if (status === 'disabled') return 'disabled';
  return 'pending';
}

async function queueProjectGraphify(project) {
  if (!project || ['queued', 'running'].includes(project.graphify_status)) return;
  try {
    await api.send('POST', `/api/projects/${project.id}/graphify`);
    await loadProjects();
    toast((project.graphify_enabled === 0 ? 'Graphify added for ' : 'Graphify queued for ') + (project.name || displayProject(project.path)));
  } catch (e) {
    toast('Graphify failed: ' + e.message, { err: true });
  }
}

function renderGraphifyPill(project, opts) {
  opts = opts || {};
  const raw = (project && project.graphify_status) || 'pending';
  const state = graphifyUiState(project);
  const label = 'Graphify';
  const statusLabel = project && project.graphify_enabled === 0 ? GRAPHIFY_LABELS.disabled : GRAPHIFY_LABELS[raw] || GRAPHIFY_LABELS.pending;
  const details = [];
  details.push(statusLabel);
  if (project && project.graphify_last_success_at) details.push('Last success: ' + project.graphify_last_success_at);
  if (project && project.graphify_hook_status) details.push('Hook: ' + project.graphify_hook_status);
  if (project && project.graphify_last_error) details.push(project.graphify_last_error);
  const working = raw === 'queued' || raw === 'running';
  if (opts.action && !working) {
    return h('button', {
      type: 'button',
      class: 'graphify-pill graphify-pill-btn gf-' + state,
      title: details.join('\n'),
      onclick: () => queueProjectGraphify(project),
    }, label);
  }
  return h('span', {
    class: 'graphify-pill gf-' + state,
    title: details.join('\n'),
  }, label);
}

async function refresh(force) {
  try {
    const data = await api.get('/api/tasks');
    TASKS = data;
    rebuildIndex();
    notifier.scan(TASKS);
    const sig = boardSignature();
    if (force || sig !== lastSig) {
      lastSig = sig;
      requestBoardRender({ syncFilter: true });
    }
    tabs.sync();
    if (!tabsRestored) restoreOpenTabs(); // one-shot, after the first successful task load
  } catch (e) {
    if (restartingServer) return;
    toast('Failed to load tasks: ' + e.message, { err: true });
  }
}

function rebuildIndex() {
  byId = new Map(TASKS.map((t) => [t.id, t]));
  for (const t of archivedCache) if (!byId.has(t.id)) byId.set(t.id, t);
}

/* ------------------------------------------------------------------- board */

const COLUMNS = ['backlog', 'in_progress', 'done'];

function isEditable(t) {
  return !!t && t.status === 'backlog' && !t.started_at && !t.session_id && !t.archived;
}

function taskSource(includeArchived = showArchive) {
  const base = includeArchived ? [...TASKS, ...archivedCache] : TASKS;
  const seen = new Set();
  const out = [];
  for (const t of base) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function visibleTasks() {
  return taskSource().filter((t) => !projectFilter || t.project_path === projectFilter);
}

function taskBoardSignature(t) {
  return [
    t.id,
    t.status,
    t.displayStatus || '',
    t.live ? 1 : 0,
    t.archived ? 1 : 0,
    t.title || '',
    t.description || '',
    t.project_path || '',
    t.parent_task_id || '',
    t.session_id ? 1 : 0,
    (t.children || []).join(','),
    t.column_changed_at || '',
    t.created_at || '',
  ].join('\u001f');
}

function boardSignature() {
  const sigTasks = showArchive ? [...TASKS, ...archivedCache] : TASKS;
  return JSON.stringify({
    showArchive,
    projectFilter,
    selectedProjectId,
    tasks: sigTasks.map(taskBoardSignature),
  });
}

function noteUiPointerActivity() {
  deferBoardRenderUntil = Math.max(deferBoardRenderUntil, Date.now() + BOARD_RENDER_SETTLE_MS);
  if (pendingBoardRender) schedulePendingBoardRender();
}

function shouldDeferBoardRender() {
  return mouseButtonDown || activePointers.size > 0 || Date.now() < deferBoardRenderUntil;
}

function schedulePendingBoardRender() {
  if (boardRenderTimer) return;
  const delay = Math.max(0, deferBoardRenderUntil - Date.now()) + 20;
  boardRenderTimer = setTimeout(() => {
    boardRenderTimer = null;
    flushPendingBoardRender();
  }, delay);
}

function flushPendingBoardRender() {
  if (!pendingBoardRender) return;
  if (shouldDeferBoardRender()) {
    schedulePendingBoardRender();
    return;
  }
  pendingBoardRender = false;
  const syncFilter = pendingProjectFilterSync;
  pendingProjectFilterSync = false;
  renderBoard();
  if (syncFilter) syncProjectFilter();
}

function requestBoardRender(opts) {
  opts = opts || {};
  if (opts.syncFilter) pendingProjectFilterSync = true;
  if (shouldDeferBoardRender()) {
    pendingBoardRender = true;
    schedulePendingBoardRender();
    return;
  }
  pendingBoardRender = false;
  const syncFilter = pendingProjectFilterSync;
  pendingProjectFilterSync = false;
  renderBoard();
  if (syncFilter) syncProjectFilter();
}

document.addEventListener('pointerdown', (ev) => {
  activePointers.add(ev.pointerId);
  noteUiPointerActivity();
}, true);
document.addEventListener('pointerup', (ev) => {
  activePointers.delete(ev.pointerId);
  noteUiPointerActivity();
}, true);
document.addEventListener('pointercancel', (ev) => {
  activePointers.delete(ev.pointerId);
  noteUiPointerActivity();
}, true);
document.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  mouseButtonDown = true;
  noteUiPointerActivity();
}, true);
document.addEventListener('mouseup', () => {
  mouseButtonDown = false;
  noteUiPointerActivity();
}, true);
document.addEventListener('click', noteUiPointerActivity, true);
window.addEventListener('blur', () => {
  activePointers.clear();
  mouseButtonDown = false;
  if (pendingBoardRender) schedulePendingBoardRender();
});

function columnSortValue(t) {
  return Date.parse(t.column_changed_at || t.created_at || t.updated_at || '') || 0;
}

function cardRenderSignature(t) {
  const childSig = (t.children || []).map((cid) => {
    const child = byId.get(cid);
    return cid + ':' + (child ? child.title : '');
  }).join(',');
  return [taskBoardSignature(t), childSig].join('\u001e');
}

function syncCardShell(card, t) {
  const ds = t.displayStatus || 'waiting';
  card.className = `card s-${ds}` + (t.id === tabs.activeId ? ' active-session' : '') + (t.archived ? ' archived' : '');
  card.dataset.id = t.id;
}

function stableReplaceChildren(parent, nodes) {
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
    } else {
      parent.insertBefore(node, cursor);
    }
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

async function markTaskDone(id) {
  const updated = await api.send('POST', `/api/tasks/${id}/done`);
  const task = byId.get(id);
  if (task) {
    Object.assign(task, updated, { live: false, activity: null, displayStatus: 'done' });
    rebuildIndex();
    renderBoard();
    tabs.sync();
    notifier.scan(TASKS);
  }
  return updated;
}

function gitCommitNotice(updated) {
  const commit = updated && updated.git_commit;
  if (!commit || !commit.ok || !commit.hash) return '';
  return 'Committed ' + commit.hash;
}

async function completeTaskAndClose(id, { message } = {}) {
  const updated = await markTaskDone(id);
  const commitNotice = gitCommitNotice(updated);
  if (message || commitNotice) toast([message, commitNotice].filter(Boolean).join(' · '));
  tabs.remove(id, { stop: false });
  await refresh(true);
  return updated;
}

function boardCardCache(boardKey) {
  if (!cardCaches.has(boardKey)) cardCaches.set(boardKey, new Map());
  return cardCaches.get(boardKey);
}

function projectBoardTasks() {
  const project = selectedProject();
  if (!project) return [];
  return taskSource().filter((t) => t.project_path === project.path);
}

function renderBoard() {
  renderTaskBoard('dashboard', visibleTasks(), 'No tasks');
  renderTaskBoard('project', projectBoardTasks(), selectedProject() ? 'No tasks' : 'No project selected');
  renderProjectsPage();
}

function renderTaskBoard(boardKey, shown, emptyText) {
  const root = document.querySelector(`[data-board="${boardKey}"]`);
  if (!root) return;
  const cache = boardCardCache(boardKey);
  const counts = { backlog: 0, in_progress: 0, done: 0 };
  const renderedIds = new Set();
  for (const s of COLUMNS) {
    const body = root.querySelector(`.col-body[data-drop="${s}"]`);
    const items = shown
      .filter((t) => t.status === s)
      .sort((a, b) => columnSortValue(b) - columnSortValue(a) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    counts[s] = items.length;
    const nodes = [];
    if (items.length === 0) {
      nodes.push(h('div', { class: 'col-empty' }, emptyText));
    } else {
      for (const t of items) {
        renderedIds.add(t.id);
        const sig = cardRenderSignature(t);
        let entry = cache.get(t.id);
        if (!entry || entry.sig !== sig) {
          entry = { sig, el: renderCard(t) };
          cache.set(t.id, entry);
        } else {
          syncCardShell(entry.el, t);
        }
        nodes.push(entry.el);
      }
    }
    stableReplaceChildren(body, nodes);
  }
  for (const s of COLUMNS) root.querySelector(`[data-count="${s}"]`).textContent = counts[s];
  for (const id of [...cache.keys()]) if (!renderedIds.has(id) && !byId.has(id)) cache.delete(id);
}

function renderCard(t) {
  const isFork = !!t.parent_task_id;
  const ds = t.displayStatus || 'waiting';
  const card = h('div', {
    class: `card s-${ds}` + (t.id === tabs.activeId ? ' active-session' : '') + (t.archived ? ' archived' : ''),
    draggable: 'true',
    dataset: { id: t.id },
    onclick: (ev) => {
      if (ev.target.closest('button')) return;
      openDetails(t.id);
    },
  });

  card.addEventListener('dragstart', (ev) => {
    if (ev.target.closest('button, .fork-chip')) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.setData('text/plain', t.id);
    ev.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  // status line on top: a prominent status pill leads the card
  const tags = h('div', { class: 'card-tags' });
  tags.append(h('span', { class: 'status-pill st-' + ds }, STATUS_LABELS[ds] || ds));
  if (isFork) tags.append(h('span', { class: 'tag fork' }, '⑂ fork'));
  if (t.children && t.children.length) tags.append(h('span', { class: 'tag parent' }, '⑂ ' + t.children.length));
  card.append(tags);

  card.append(h('div', { class: 'card-title' }, t.title));
  card.append(h('div', { class: 'card-path' }, displayProject(t.project_path)));
  if (t.description) card.append(h('div', { class: 'card-desc' }, t.description));

  const actions = h('div', { class: 'card-actions' });
  if (t.archived) {
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => openDetails(t.id) }, '☰ Details'));
    actions.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => unarchiveTask(t) }, '⟲ Unarchive'));
  } else if (t.status === 'backlog') {
    // Backlog = not started yet → editable, and Start launches it.
    actions.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => startTask(t) }, '▶ Start'));
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => openTaskModal(t) }, '✎ Edit'));
    actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => archiveTask(t) }, 'Archive'));
  } else {
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => (t.live ? openTab(t) : resumeTask(t)) }, t.live ? '⧉ Open' : '▶ Resume'));
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => openDetails(t.id) }, '☰ Details'));
    if (t.session_id) actions.append(h('button', { class: 'btn btn-sm', onclick: () => forkTask(t) }, '⑂ Fork'));
    actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => archiveTask(t) }, 'Archive'));
  }
  card.append(actions);

  if (t.children && t.children.length) {
    const wrap = h('div', { class: 'card-forks' }, h('div', { class: 'forks-label' }, 'Forks'));
    for (const cid of t.children) {
      const child = byId.get(cid);
      if (!child) continue;
      wrap.append(h('span', { class: 'fork-chip', onclick: () => openDetails(cid) }, '⑂ ' + child.title));
    }
    card.append(wrap);
  }
  return card;
}

/* drag & drop between columns — dropping into In Progress auto-starts/resumes */
for (const body of document.querySelectorAll('.col-body')) {
  body.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    body.classList.add('drag-over');
  });
  body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
  body.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    body.classList.remove('drag-over');
    const id = ev.dataTransfer.getData('text/plain');
    const status = body.dataset.drop;
    const task = byId.get(id);
    if (!task || task.status === status) return;
    task.status = status;
    renderBoard();
    try {
      if (status === 'in_progress' && !task.archived) {
        // Auto-launch: resume if it already has a session, otherwise start fresh.
        if (task.session_id) await api.send('POST', `/api/tasks/${id}/resume`);
        else await api.send('POST', `/api/tasks/${id}/start`);
        await refresh(true);
        openTab(byId.get(id) || task);
      } else if (status === 'done') {
        await completeTaskAndClose(id);
      } else {
        await api.send('PATCH', `/api/tasks/${id}`, { status });
        await refresh(true);
      }
    } catch (e) {
      toast('Move failed: ' + e.message, { err: true });
      refresh(true);
    }
  });
}

/* ------------------------------------------------------------ task actions */

async function startTask(t) {
  try {
    await api.send('POST', `/api/tasks/${t.id}/start`);
    await refresh(true);
    openTab(byId.get(t.id) || t);
  } catch (e) {
    toast('Start failed: ' + e.message, { err: true });
  }
}

async function resumeTask(t) {
  try {
    await api.send('POST', `/api/tasks/${t.id}/resume`);
    await refresh(true);
    openTab(byId.get(t.id) || t);
  } catch (e) {
    toast('Resume failed: ' + e.message, { err: true });
  }
}

async function forkTask(t) {
  try {
    const child = await api.send('POST', `/api/tasks/${t.id}/fork`);
    toast('Forked → ' + child.title);
    await refresh(true);
    openTab(child);
  } catch (e) {
    toast('Fork failed: ' + e.message, { err: true });
  }
}

// Archive with no confirmation modal — reversible via the toast's Undo or the Show-archive view.
async function archiveTask(t) {
  try {
    tabs.remove(t.id, { stop: true });
    await api.send('POST', `/api/tasks/${t.id}/archive`);
    if (showArchive) await loadArchived();
    await refresh(true);
    toast('Archived “' + t.title + '”', { undo: () => unarchiveTask(t, true) });
  } catch (e) {
    toast('Archive failed: ' + e.message, { err: true });
  }
}

async function unarchiveTask(t, quiet) {
  try {
    await api.send('POST', `/api/tasks/${t.id}/unarchive`);
    if (!quiet) toast('Restored: ' + t.title);
    archivedCache = archivedCache.filter((x) => x.id !== t.id);
    await refresh(true);
  } catch (e) {
    toast('Unarchive failed: ' + e.message, { err: true });
  }
}

async function loadArchived() {
  try {
    archivedCache = await api.get('/api/tasks/archived');
  } catch {
    archivedCache = [];
  }
  rebuildIndex();
}

/* ----------------------------------------------------------- task modal */

let projectValue = '';
let taskUploads = []; // [{ name, path, ext }]

function activeProviderInfo() {
  return (MODEL_CONNECTIONS.providers || []).find((p) => p.active) || (MODEL_CONNECTIONS.providers || [])[0] || {
    id: 'codex',
    name: 'Codex',
    defaultModel: 'gpt-5.5',
    models: Object.entries(MODEL_LABELS).filter(([id]) => id.startsWith('gpt-')).map(([id, label]) => ({ id, label })),
    modes: ['build', 'plan'],
    supports: { ultracode: false },
  };
}

function syncTaskProviderControls(task) {
  const provider = task && task.provider
    ? (MODEL_CONNECTIONS.providers || []).find((p) => p.id === task.provider) || activeProviderInfo()
    : activeProviderInfo();
  const models = provider.models && provider.models.length ? provider.models : [{ id: provider.defaultModel || 'gpt-5.5', label: modelLabel(provider.defaultModel || 'gpt-5.5') }];
  const select = $('#f_model');
  select.replaceChildren(...models.map((m) => h('option', { value: m.id }, m.label || modelLabel(m.id))));
  select.value = task ? task.model : provider.defaultModel || models[0].id;
  if (!select.value && models[0]) select.value = models[0].id;

  const modes = provider.modes && provider.modes.length ? provider.modes : ['build', 'plan'];
  for (const card of document.querySelectorAll('.mode-card')) {
    const input = card.querySelector('input[name="f_mode"]');
    const available = !input || modes.includes(input.value);
    card.hidden = !available;
    if (!available && input.checked) input.checked = false;
  }
  let mode = task ? task.mode || 'build' : 'build';
  if (!modes.includes(mode)) mode = modes.includes('build') ? 'build' : modes[0];
  for (const input of document.querySelectorAll('input[name="f_mode"]')) input.checked = input.value === mode;

  const supports = provider.supports || {};
  const ultracodeLine = $('#f_ultracode').closest('.checkbox');
  const showUltracode = !!supports.ultracode || ultracodeEnabled;
  if (ultracodeLine) ultracodeLine.hidden = !showUltracode;
  $('#f_ultracode').checked = showUltracode && task ? !!task.ultracode : false;
}

function setProjectLabel(text) {
  const el = $('#projectTriggerLabel');
  el.textContent = text || 'Select a project…';
  $('#projectTrigger').classList.toggle('placeholder', !text);
}

function openTaskModal(task, opts) {
  opts = opts || {};
  if (task && !isEditable(task)) {
    toast('This task has already started — its details are locked.', { err: true });
    return;
  }
  $('#taskModalTitle').textContent = task ? 'Edit task' : 'New task';
  $('#taskId').value = task ? task.id : '';
  $('#f_title').value = task ? task.title : '';
  $('#f_description').value = task ? task.description : '';
  syncTaskProviderControls(task);
  const taskEffort = task && task.effort === 'max' ? 'xhigh' : task && task.effort;
  const eIdx = task ? EFFORTS.indexOf(taskEffort) : 1;
  $('#f_effort').value = eIdx >= 0 ? eIdx : 1;
  $('#effortLabel').textContent = EFFORT_LABELS[+$('#f_effort').value];
  $('#f_yolo').checked = task ? !!task.yolo : healthYoloDefault;
  refreshModeUi();

  const presetProjectPath = task ? task.project_path : opts.projectPath || '';
  projectValue = presetProjectPath;
  setProjectLabel(presetProjectPath ? displayProject(presetProjectPath) : '');
  $('#projectMenu').hidden = true;
  $('#projectManual').hidden = true;
  $('#f_projectPath').value = '';
  taskUploads = [];
  renderUploadList();
  $('#f_uploadNote').textContent = '';

  loadProjects();
  show('taskModal');
  setTimeout(() => $('#f_title').focus(), 30);
}

$('#f_effort').addEventListener('input', () => {
  $('#effortLabel').textContent = EFFORT_LABELS[+$('#f_effort').value];
});

// Grey YOLO when Plan mode overrides it.
function refreshModeUi() {
  const mode = (document.querySelector('input[name="f_mode"]:checked') || {}).value || 'build';
  const overridden = mode === 'plan' || mode === 'auto';
  const yolo = $('#f_yolo');
  yolo.disabled = overridden;
  const yoloLabel = yolo.closest('.checkbox');
  if (yoloLabel) {
    yoloLabel.classList.toggle('disabled', overridden);
    yoloLabel.title = overridden ? 'This mode sets its own permission behavior.' : 'Bypass approvals and sandbox where the active provider supports it.';
  }
}
$('#f_model').addEventListener('change', refreshModeUi);
for (const r of document.querySelectorAll('input[name="f_mode"]')) r.addEventListener('change', refreshModeUi);

$('#taskForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('#taskId').value;
  const project = (projectValue || '').trim();
  let description = $('#f_description').value;
  if (taskUploads.length) {
    const refs = taskUploads.map((u) => '- ' + u.path).join('\n');
    description = (description ? description.trimEnd() + '\n\n' : '') + 'Context files (in USER_UPLOADS):\n' + refs;
  }
  const mode = (document.querySelector('input[name="f_mode"]:checked') || {}).value || 'build';
  const body = {
    title: $('#f_title').value.trim(),
    project_path: project,
    description,
    model: $('#f_model').value,
    effort: EFFORTS[+$('#f_effort').value] || 'medium',
    mode,
    yolo: mode === 'build' && $('#f_yolo').checked,
    ultracode: !$('#f_ultracode').closest('.checkbox').hidden && $('#f_ultracode').checked,
  };
  if (!body.title) return toast('Title is required', { err: true });
  if (!body.project_path) return toast('Pick a project', { err: true });
  try {
    if (id) await api.send('PATCH', `/api/tasks/${id}`, body);
    else await api.send('POST', '/api/tasks', body);
    hide('taskModal');
    refresh(true);
  } catch (e) {
    toast('Save failed: ' + e.message, { err: true });
  }
});

/* project picker dropdown */
$('#projectTrigger').addEventListener('click', () => {
  const m = $('#projectMenu');
  m.hidden = !m.hidden;
});
$('#projectManualToggle').addEventListener('click', () => {
  const man = $('#projectManual');
  man.hidden = !man.hidden;
  $('#projectMenu').hidden = true;
  $('#projectManualToggle').textContent = man.hidden ? 'Enter a path manually' : 'Choose from the list';
  if (!man.hidden) setTimeout(() => $('#f_projectPath').focus(), 20);
});
$('#f_projectPath').addEventListener('input', () => {
  projectValue = $('#f_projectPath').value.trim();
  setProjectLabel(projectValue ? '✎ ' + projectValue : '');
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.project-picker')) $('#projectMenu').hidden = true;
});

function selectProject(path, name) {
  projectValue = path;
  setProjectLabel(name);
  $('#projectMenu').hidden = true;
  $('#projectManual').hidden = true;
  $('#f_projectPath').value = '';
  $('#projectManualToggle').textContent = 'Enter a path manually';
}

/* ------- context-file upload (New task) ------- */
$('#f_uploadBtn').addEventListener('click', (ev) => {
  if (projectValue) return;
  ev.preventDefault();
  toast('Pick a project first — files copy into its USER_UPLOADS.', { err: true });
});
$('#f_uploadInput').addEventListener('change', async (ev) => {
  const input = ev.currentTarget;
  const files = [...(input.files || [])];
  if (!files.length) return;
  $('#f_uploadNote').textContent = 'Uploading…';
  try {
    for (const f of files) {
      try {
        const item = await uploadFile(projectValue, f);
        taskUploads.push({ name: item.name, path: item.path, ext: item.ext });
      } catch (e) {
        toast('Upload failed: ' + e.message, { err: true });
      }
    }
  } finally {
    input.value = '';
    $('#f_uploadNote').textContent = '';
  }
  renderUploadList();
});

function renderUploadList() {
  const list = $('#f_uploadList');
  list.replaceChildren();
  taskUploads.forEach((u, i) => {
    list.append(
      h('div', { class: 'upload-item' },
        h('span', { class: 'ext' }, (u.ext || '').replace('.', '').toUpperCase() || 'FILE'),
        h('span', {}, u.name),
        h('span', { class: 'rm', title: 'Remove from context', onclick: () => { taskUploads.splice(i, 1); renderUploadList(); } }, '✕'),
      ),
    );
  });
}

async function uploadFile(project, file) {
  const url = `/api/media?project=${encodeURIComponent(project)}&name=${encodeURIComponent(file.name)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

/* ------------------------------------------------------- details modal */

let detailsTaskId = null;

async function openDetails(taskId) {
  const t = byId.get(taskId);
  if (!t) return;
  detailsTaskId = taskId;
  $('#dTitle').textContent = t.title;
  $('#dMeta').textContent = (t.session_id ? 'sid ' + shortId(t.session_id) + ' · ' : '') + displayProject(t.project_path);
  renderDetailBar(t);
  const body = $('#dBody');
  body.replaceChildren(renderDetailInfo(t), renderPromptSection(t), h('div', { class: 'empty-state' }, t.session_id ? 'Loading session details…' : 'Not started yet — click Start to launch a session.'));
  show('detailsModal');
  if (!t.session_id) return;
  try {
    const conv = await api.get(`/api/tasks/${t.id}/conversation`);
    if (detailsTaskId !== taskId) return;
    body.replaceChildren(
      renderDetailInfo(t),
      renderPromptSection(t),
      renderStats(conv.counts),
      renderSubtasks(conv.subtasks),
      renderAgents(conv.agents),
      renderActivity(conv),
    );
  } catch (e) {
    body.replaceChildren(renderDetailInfo(t), renderPromptSection(t), h('div', { class: 'empty-state' }, 'Session details not available yet: ' + e.message));
  }
}

function section(title, opts, ...children) {
  opts = opts || {};
  const summary = h('summary', {}, title);
  if (opts.count != null) summary.append(h('span', { class: 'sec-count' }, opts.count));
  const det = h('details', { class: 'detail-section' }, summary, h('div', { class: 'section-body' }, ...children));
  if (opts.open !== false) det.open = true;
  return det;
}

function renderDetailInfo(t) {
  const ds = t.displayStatus || 'waiting';
  const kv = h('div', { class: 'kv' });
  const row = (k, v) => kv.append(h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  row('Project', displayProject(t.project_path));
  kv.append(h('span', { class: 'k' }, 'Status'), h('span', { class: 'v' }, h('span', { class: 'status-pill st-' + ds }, STATUS_LABELS[ds] || ds)));
  row('Session', t.session_id ? t.session_id : '— (not started)');
  const chips = h('div', { class: 'settings-chips' },
    h('span', { class: 'chip' }, 'model: ' + modelLabel(t.model)),
    h('span', { class: 'chip' }, 'effort: ' + effortLabel(t.effort)),
    h('span', { class: 'chip' }, 'mode: ' + (t.mode || 'build')),
    h('span', { class: 'chip ' + (t.mode === 'build' && t.yolo ? 'on' : 'off') }, t.mode === 'build' && t.yolo ? 'permissions: YOLO' : 'permissions: prompt'),
    ultracodeEnabled && t.ultracode && h('span', { class: 'chip on' }, 'ultracode legacy'),
  );
  return section('Task', {}, kv, chips);
}

function taskOpeningPrompt(t) {
  return [t.title, t.description].map((v) => String(v || '').trim()).filter(Boolean).join('\n\n');
}

function renderPromptSection(t) {
  const body = h('div', {});
  const prompt = taskOpeningPrompt(t);
  if (!prompt) {
    body.append(h('div', { class: 'prompt-empty' }, 'No opening prompt.'));
  } else {
    const txt = h('div', { class: 'prompt-text' }, prompt);
    const more = h('button', { class: 'link-btn', style: 'margin-top:8px' }, 'more…');
    more.addEventListener('click', () => {
      const open = txt.classList.toggle('expanded');
      more.textContent = open ? 'less' : 'more…';
    });
    body.append(txt, more);
    // hide the toggle if the text isn't actually clamped
    requestAnimationFrame(() => {
      if (txt.scrollHeight <= txt.clientHeight + 2) more.hidden = true;
    });
  }
  return section('Opening Prompt', {}, body);
}

function renderStats(c) {
  c = c || {};
  const stat = (num, lbl) => h('div', { class: 'stat' }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));
  return section('Stats', {},
    h('div', { class: 'stats' },
      stat(fmtNum(c.toolCalls), 'tool calls'),
      stat(fmtNum(c.tokensInput) + ' / ' + fmtNum(c.tokensOutput), 'tokens (in / out)'),
      stat(fmtNum(c.contextTokens) + (c.modelContextWindow ? ' / ' + fmtNum(c.modelContextWindow) : ''), 'context'),
    ),
  );
}

function renderSubtasks(subtasks) {
  subtasks = subtasks || [];
  const body = h('div', {});
  if (subtasks.length === 0) {
    body.append(h('div', { class: 'fc-empty' }, 'Codex has not created any subtasks.'));
  } else {
    const list = h('div', { class: 'subtask-list' });
    for (const s of subtasks) {
      const st = s.status || 'pending';
      list.append(
        h('div', { class: 'subtask' },
          h('span', { class: 'subtask-num' }, '#' + s.id),
          h('div', { class: 'subtask-main' },
            h('div', { class: 'subtask-subject' }, s.subject),
            s.description ? h('div', { class: 'subtask-desc' }, s.description) : null,
          ),
          h('span', { class: 'tp tp-' + st }, SUBTASK_LABELS[st] || st),
        ),
      );
    }
    body.append(list);
  }
  return section('Subtasks', { count: subtasks.length || null }, body);
}

function renderAgents(agents) {
  agents = agents || [];
  const body = h('div', {});
  if (agents.length === 0) {
    body.append(h('div', { class: 'fc-empty' }, 'No subagents were used.'));
  } else {
    const list = h('div', { class: 'agent-list' });
    for (const a of agents) {
      const head = h('div', { class: 'agent-head' },
        h('span', { class: 'agent-type' }, a.type),
        a.model ? h('span', { class: 'agent-model' }, a.model) : null,
        h('span', { class: 'tp tp-' + (a.status === 'completed' ? 'completed' : a.status === 'error' ? 'cancelled' : 'in_progress') }, a.status),
      );
      const stats = h('div', { class: 'agent-stats' });
      stats.append(h('span', {}, 'tokens ', h('b', {}, a.totalTokens != null ? fmtNum(a.totalTokens) : '—')));
      if (a.toolUses != null) stats.append(h('span', {}, 'tools ', h('b', {}, a.toolUses)));
      if (a.durationMs != null) stats.append(h('span', {}, 'time ', h('b', {}, fmtDuration(a.durationMs))));
      list.append(h('div', { class: 'agent-card' }, head, a.task ? h('div', { class: 'agent-task' }, a.task) : null, stats));
    }
    body.append(list);
  }
  return section('Agents', { count: agents.length || null }, body);
}

function renderActivity(conv) {
  const files = conv.filesTouched || [];
  const cmds = conv.commands || [];
  const filesList = h('div', { class: 'fc-list' });
  if (files.length === 0) filesList.append(h('div', { class: 'fc-empty' }, 'none'));
  for (const f of files) filesList.append(h('div', { class: 'fc-item' }, h('span', { class: 'op' }, f.ops.includes('write') ? '✎ ' : '👁 '), relPath(f.path)));
  const cmdList = h('div', { class: 'fc-list' });
  if (cmds.length === 0) cmdList.append(h('div', { class: 'fc-empty' }, 'none'));
  for (const c of cmds) cmdList.append(h('div', { class: 'fc-item', title: c.description || '' }, c.command.split('\n')[0]));
  return section('Activity', { open: false },
    h('div', { class: 'fc-grid' },
      h('div', { class: 'fc-panel' }, h('h4', {}, `Files touched (${files.length})`), filesList),
      h('div', { class: 'fc-panel' }, h('h4', {}, `Commands run (${cmds.length})`), cmdList),
    ),
  );
}

function renderDetailBar(t) {
  const bar = $('#dBar');
  bar.replaceChildren();
  if (t.archived) {
    bar.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => { unarchiveTask(t); hide('detailsModal'); } }, '⟲ Unarchive'));
    return;
  }
  if (isEditable(t)) {
    bar.append(h('button', { class: 'btn btn-sm', onclick: () => { hide('detailsModal'); openTaskModal(t); } }, '✎ Edit'));
    bar.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => { hide('detailsModal'); startTask(t); } }, '▶ Start'));
  } else {
    bar.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => { hide('detailsModal'); t.live ? openTab(t) : resumeTask(t); } }, t.live ? '⧉ Open' : '▶ Resume'));
    if (t.session_id) bar.append(h('button', { class: 'btn btn-sm', onclick: () => { hide('detailsModal'); forkTask(t); } }, '⑂ Fork'));
  }
  bar.append(h('span', { class: 'spacer' }));
  bar.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { archiveTask(t); hide('detailsModal'); } }, 'Archive'));
}

/* ------------------------------------------------------ tabbed terminal */

const tabs = {
  map: new Map(),
  activeId: null,

  showDrawer() {
    $('#drawer').hidden = false;
    $('#drawer').classList.remove('collapsed');
  },

  // Persist which tabs are open + which is active so a page reload can restore them.
  persist() {
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ ids: [...this.map.keys()], activeId: this.activeId }));
    } catch {
      /* storage unavailable — best-effort */
    }
  },

  queueWrite(tab, data) {
    if (!tab || !data) return;
    tab.writeBuffer += data;
    this.scheduleWrite(tab);
  },

  scheduleWrite(tab) {
    if (!tab || tab.writeScheduled) return;
    tab.writeScheduled = true;
    requestAnimationFrame(() => this.flushWrite(tab));
  },

  flushWrite(tab) {
    tab.writeScheduled = false;
    if (this.map.get(tab.taskId) !== tab) {
      tab.writeBuffer = '';
      return;
    }
    if (!tab.writeBuffer) return;
    const chunk = tab.writeBuffer.slice(0, TERMINAL_WRITE_CHUNK);
    tab.writeBuffer = tab.writeBuffer.slice(chunk.length);
    try {
      tab.term.write(chunk, () => {
        if (tab.writeBuffer) this.scheduleWrite(tab);
      });
    } catch {
      if (tab.writeBuffer) this.scheduleWrite(tab);
    }
  },

  open(task, opts) {
    opts = opts || {};
    this.showDrawer();
    const existing = this.map.get(task.id);
    if (existing) {
      const dead = !existing.ws || existing.ws.readyState >= WebSocket.CLOSING;
      if (existing.exited || dead) this.connect(existing, task);
      this.activate(existing.taskId, { focusTerminal: !!opts.focusTerminal });
      return;
    }
    const hostEl = h('div', { class: 'term-host', dataset: { tab: task.id } });
    $('#termArea').append(hostEl);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#000000', foreground: '#e6edf3' },
      scrollback: 5000,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(hostEl);
    hostEl.addEventListener('mousedown', () => term.focus());
    term.onData((d) => {
      const tb = this.map.get(task.id);
      if (tb && tb.ws && tb.ws.readyState === WebSocket.OPEN) {
        tb.ws.send(JSON.stringify({ t: 'data', d }));
      }
    });

    const dotEl = h('span', { class: 'tab-dot' });
    const nameEl = h('span', { class: 'tab-name' }, task.title);
    const tabEl = h('div', { class: 'tab', dataset: { tab: task.id }, onclick: (ev) => {
      if (ev.target.closest('.tab-close')) return;
      this.activate(task.id);
    } },
      dotEl,
      nameEl,
      h('span', { class: 'tab-close', title: 'Stop session & close tab', onclick: () => this.remove(task.id, { stop: true }) }, '✕'),
    );
    $('#tabList').append(tabEl);

    const tab = { taskId: task.id, title: task.title, term, fit, ws: null, hostEl, tabEl, dotEl, nameEl, exited: false, writeBuffer: '', writeScheduled: false };
    this.map.set(task.id, tab);
    this.connect(tab, task);
    this.activate(task.id, { focusTerminal: !!opts.focusTerminal });
  },

  connect(tab, task) {
    if (tab.ws) {
      try { tab.ws.close(); } catch {}
    }
    if (tab.exited) {
      try { tab.term.reset(); } catch {}
    }
    tab.writeBuffer = '';
    tab.exited = false;
    const ws = new WebSocket(`ws://${location.host}/pty?taskId=${encodeURIComponent(task.id)}`);
    tab.ws = ws;
    ws.onopen = () => this.fit(tab);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'data') this.queueWrite(tab, m.d);
      else if (m.t === 'exit') {
        tab.exited = true;
        this.queueWrite(tab, `\r\n\x1b[90m[codex session ended${m.code != null ? ' · exit ' + m.code : ''}]\x1b[0m\r\n`);
        refresh(true);
      } else if (m.t === 'session') {
        toast('Session captured: ' + shortId(m.sessionId));
        refresh(true);
      } else if (m.t === 'restart') {
        this.queueWrite(tab, '\r\n\x1b[90m[server restarting]\x1b[0m\r\n');
      } else if (m.t === 'quit') {
        this.queueWrite(tab, '\r\n\x1b[90m[server shutting down]\x1b[0m\r\n');
      }
    };
    ws.onerror = () => {
      if (!restartingServer && !quittingServer) toast('Terminal connection error', { err: true });
    };
    ws.onclose = () => {
      if (tab.ws !== ws) return;
      tab.exited = true;
      tabs.sync();
    };
  },

  activate(taskId, opts) {
    opts = opts || {};
    this.activeId = taskId;
    for (const [id, tb] of this.map) {
      const on = id === taskId;
      tb.hostEl.classList.toggle('active', on);
      tb.tabEl.classList.toggle('active', on);
    }
    this.updateDetail();
    this.refreshUsage();
    this.sync();
    const tab = this.map.get(taskId);
    if (tab) requestAnimationFrame(() => {
      this.fit(tab);
      if (opts.focusTerminal) tab.term.focus();
    });
    this.highlightCard();
    this.persist();
  },

  remove(taskId, { stop } = {}) {
    const tab = this.map.get(taskId);
    if (!tab) return;
    if (stop && tab.ws && tab.ws.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ t: 'stop' }));
    tab.writeBuffer = '';
    try { tab.ws && tab.ws.close(); } catch {}
    try { tab.term.dispose(); } catch {}
    tab.hostEl.remove();
    tab.tabEl.remove();
    this.map.delete(taskId);
    if (this.activeId === taskId) {
      const next = this.map.keys().next();
      if (!next.done) this.activate(next.value);
      else {
        this.activeId = null;
        $('#drawer').hidden = true;
        this.highlightCard();
      }
    }
    this.persist();
    refresh(true);
  },

  doneActive() {
    const tab = this.map.get(this.activeId);
    if (!tab) return;
    const id = this.activeId;
    completeTaskAndClose(id, { message: 'Marked done · ending session' })
      .catch((e) => toast('Done failed: ' + e.message, { err: true }));
  },

  fit(tab) {
    if (!tab || $('#drawer').hidden || $('#drawer').classList.contains('collapsed')) return;
    if (this.activeId !== tab.taskId) return;
    try { tab.fit.fit(); } catch {}
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ t: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
  },

  updateDetail() {
    const t = byId.get(this.activeId);
    if (!t) return;
    $('#tdPath').textContent = displayProject(t.project_path);
    $('#tdModel').textContent = modelLabel(t.model);
    $('#tdEffort').textContent = 'effort: ' + effortLabel(t.effort);
    $('#tdTokens').textContent = 'tokens —';
    $('#tdContext').textContent = 'ctx —';
  },

  async refreshUsage() {
    const id = this.activeId;
    if (!id) return;
    try {
      const u = await api.get(`/api/tasks/${id}/usage`);
      if (this.activeId !== id) return;
      const hasUsage = u.tokensInput || u.tokensOutput || u.contextTokens || u.modelContextWindow;
      $('#tdTokens').textContent = hasUsage ? 'in ' + fmtNum(u.tokensInput) + ' / out ' + fmtNum(u.tokensOutput) : 'tokens —';
      $('#tdContext').textContent = hasUsage ? 'ctx ' + fmtNum(u.contextTokens) + (u.modelContextWindow ? ' / ' + fmtNum(u.modelContextWindow) : '') : 'ctx —';
    } catch {
      /* best-effort */
    }
  },

  sync() {
    for (const [id, tab] of this.map) {
      const t = byId.get(id);
      const ds = (t && t.displayStatus) || 'waiting';
      const attention = ds === 'needs_attention' && id !== this.activeId ? ' attention' : '';
      tab.dotEl.className = 'tab-dot st-' + ds + attention;
      if (t && tab.nameEl.textContent !== t.title) tab.nameEl.textContent = t.title;
    }
    if (this.activeId) this.updateDetail();
  },

  highlightCard() {
    for (const el of document.querySelectorAll('.card.active-session')) el.classList.remove('active-session');
    if (this.activeId) {
      for (const el of document.querySelectorAll(`.card[data-id="${this.activeId}"]`)) el.classList.add('active-session');
    }
  },
};

function openTab(task) {
  tabs.open(task);
}

// On page load, re-open a terminal tab for every session still running on the server. The PTY is
// tmux-like: it survives a reload, so reconnecting reattaches and replays the screen — it never
// reruns Codex. Only `live` tasks are restored (a dead "needs attention" session is left closed
// so we never silently relaunch one). Tab order + the active tab come from localStorage when set.
function restoreOpenTabs() {
  tabsRestored = true;
  const liveById = new Map(TASKS.filter((t) => t.live).map((t) => [t.id, t]));
  if (!liveById.size) return;
  let saved = { ids: [], activeId: null };
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '{}') || {};
    saved = { ids: Array.isArray(v.ids) ? v.ids : [], activeId: v.activeId || null };
  } catch {
    /* ignore malformed state */
  }
  // Honour the saved order for tabs still live, then append any other live sessions.
  const ordered = [];
  const seen = new Set();
  for (const id of saved.ids) {
    if (liveById.has(id) && !seen.has(id)) { ordered.push(liveById.get(id)); seen.add(id); }
  }
  for (const [id, t] of liveById) if (!seen.has(id)) ordered.push(t);
  for (const t of ordered) tabs.open(t);
  const activeId = saved.activeId && liveById.has(saved.activeId) ? saved.activeId : ordered[ordered.length - 1].id;
  tabs.activate(activeId);
}

$('#termDone').addEventListener('click', () => tabs.doneActive());
$('#tdMedia').addEventListener('click', () => {
  const t = byId.get(tabs.activeId);
  if (t) openMedia(t.project_path, { addToContext: true });
});
$('#drawerChevron').addEventListener('click', () => {
  $('#drawer').classList.toggle('collapsed');
  const tab = tabs.map.get(tabs.activeId);
  if (tab) requestAnimationFrame(() => tabs.fit(tab));
});
window.addEventListener('resize', () => {
  const tab = tabs.map.get(tabs.activeId);
  if (tab) tabs.fit(tab);
});

/* drawer resize (drag the handle) */
(() => {
  const handle = $('#drawerResize');
  const drawer = $('#drawer');
  let startY = 0;
  let startH = 0;
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const max = window.innerHeight - 140;
    const next = Math.max(120, Math.min(max, startH + dy));
    drawer.style.height = next + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    drawer.classList.remove('resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const tab = tabs.map.get(tabs.activeId);
    if (tab) tabs.fit(tab);
  };
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = drawer.getBoundingClientRect().height;
    drawer.classList.add('resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
})();

/* ----------------------------------------------------- media browser */

let mediaState = { project: null, items: [], selected: new Set(), addToContext: false };

async function openMedia(project, opts) {
  opts = opts || {};
  if (!project) {
    toast('Pick a project first.', { err: true });
    return;
  }
  const addToContext = !!opts.addToContext;
  mediaState = { project, items: [], selected: new Set(), addToContext };
  $('#mediaSub').textContent = displayProject(project) + ' › USER_UPLOADS';
  $('#mediaAdd').hidden = !addToContext;
  $('#mediaClose').textContent = addToContext ? 'Cancel' : 'Close';
  updateMediaFoot();
  $('#mediaGrid').replaceChildren(h('div', { class: 'media-empty' }, 'Loading…'));
  show('mediaModal');
  await loadMedia();
}

async function loadMedia() {
  try {
    const data = await api.get(`/api/media?project=${encodeURIComponent(mediaState.project)}`);
    mediaState.items = data.files || [];
  } catch (e) {
    mediaState.items = [];
  }
  renderMediaGrid();
  updateMediaFoot();
}

// Delete a file from the project's USER_UPLOADS folder (removes it from disk, not just the viewer).
async function deleteMedia(name) {
  if (!confirm(`Delete "${name}"? This permanently removes it from USER_UPLOADS.`)) return;
  try {
    await api.send('DELETE', `/api/media?project=${encodeURIComponent(mediaState.project)}&name=${encodeURIComponent(name)}`);
    mediaState.selected.delete(name);
    mediaState.items = mediaState.items.filter((it) => it.name !== name);
    renderMediaGrid();
    updateMediaFoot();
    toast(`Deleted ${name}`);
  } catch (e) {
    toast('Delete failed: ' + e.message, { err: true });
  }
}

function renderMediaGrid() {
  const grid = $('#mediaGrid');
  grid.replaceChildren();
  if (!mediaState.items.length) {
    grid.append(h('div', { class: 'media-empty' }, 'No files yet. Use Upload to add media to USER_UPLOADS.'));
    return;
  }
  for (const it of mediaState.items) {
    const sel = mediaState.addToContext && mediaState.selected.has(it.name);
    const thumb = h('div', { class: 'media-thumb' });
    thumb.append(h('span', { class: 'media-type-badge' }, (it.ext || '').replace('.', '') || 'file'));
    if (sel) thumb.append(h('span', { class: 'media-check' }, '✓'));
    const del = h('button', { class: 'media-del', title: 'Delete from USER_UPLOADS' }, '🗑');
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteMedia(it.name);
    });
    thumb.append(del);
    if (it.isImage) {
      thumb.append(h('img', { src: `/api/media/raw?project=${encodeURIComponent(mediaState.project)}&name=${encodeURIComponent(it.name)}`, alt: it.name, loading: 'lazy' }));
    } else {
      thumb.append(h('span', { class: 'glyph' }, '📄'));
    }
    const tile = h('div', { class: 'media-tile' + (sel ? ' selected' : '') + (!mediaState.addToContext ? ' browse-only' : ''), title: it.name },
      thumb,
      h('div', { class: 'media-name' }, it.name),
    );
    tile.addEventListener('click', () => {
      if (!mediaState.addToContext) return;
      if (mediaState.selected.has(it.name)) mediaState.selected.delete(it.name);
      else mediaState.selected.add(it.name);
      renderMediaGrid();
      updateMediaFoot();
    });
    grid.append(tile);
  }
}

function updateMediaFoot() {
  if (!mediaState.addToContext) {
    const n = mediaState.items.length;
    $('#mediaCount').textContent = n + ' file' + (n === 1 ? '' : 's');
    $('#mediaAdd').disabled = true;
    return;
  }
  const n = mediaState.selected.size;
  $('#mediaCount').textContent = n + ' selected';
  $('#mediaAdd').disabled = n === 0;
}

// Upload files into the project's USER_UPLOADS (via the button or drag & drop) and auto-select
// each newly-added file so it's ready to "Add to context" without an extra click.
async function uploadFilesToMedia(fileList) {
  const files = [...(fileList || [])].filter((f) => f && f.name);
  if (!files.length) return;
  $('#mediaCount').textContent = 'Uploading…';
  for (const f of files) {
    try {
      const item = await uploadFile(mediaState.project, f);
      if (mediaState.addToContext && item && item.name) mediaState.selected.add(item.name);
    } catch (e) {
      toast('Upload failed: ' + e.message, { err: true });
    }
  }
  await loadMedia();
  updateMediaFoot();
}

$('#mediaUploadBtn').addEventListener('click', (ev) => {
  if (mediaState.project) return;
  ev.preventDefault();
  toast('Open media from a project or task first.', { err: true });
});
$('#mediaUploadInput').addEventListener('change', async (ev) => {
  const input = ev.currentTarget;
  const files = [...(input.files || [])];
  if (!files.length) return;
  try {
    await uploadFilesToMedia(files);
  } finally {
    input.value = '';
  }
});

// drag & drop onto the media grid
const mediaGrid = $('#mediaGrid');
['dragenter', 'dragover'].forEach((evt) =>
  mediaGrid.addEventListener(evt, (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    mediaGrid.classList.add('drag-over');
  }),
);
['dragleave', 'dragend'].forEach((evt) =>
  mediaGrid.addEventListener(evt, (ev) => {
    if (evt === 'dragleave' && mediaGrid.contains(ev.relatedTarget)) return;
    mediaGrid.classList.remove('drag-over');
  }),
);
mediaGrid.addEventListener('drop', (ev) => {
  ev.preventDefault();
  mediaGrid.classList.remove('drag-over');
  if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
    uploadFilesToMedia(ev.dataTransfer.files);
  }
});

$('#mediaAdd').addEventListener('click', () => {
  if (!mediaState.addToContext) return;
  if (!mediaState.selected.size) return;
  // Build absolute paths and type an explicit context instruction into the live terminal prompt.
  const base = (mediaState.project || '').replace(/\/$/, '') + '/USER_UPLOADS/';
  const paths = [...mediaState.selected].map((name) => base + name);
  const text = 'Use these uploaded context files: ' + JSON.stringify(paths) + ' ';
  const tab = tabs.map.get(tabs.activeId);
  if (tab && tab.ws && tab.ws.readyState === WebSocket.OPEN) {
    tab.ws.send(JSON.stringify({ t: 'data', d: text }));
    toast(mediaState.selected.size + ' file(s) added to the prompt');
    hide('mediaModal');
    tab.term.focus();
  } else {
    toast('No live terminal to add to — open a session first.', { err: true });
  }
});

/* --------------------------------------------------------------- modals */

function show(id) { $('#' + id).hidden = false; }
function hide(id) { $('#' + id).hidden = true; }
for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => hide(btn.dataset.close));
}
for (const ov of document.querySelectorAll('.modal-overlay')) {
  ov.addEventListener('click', (ev) => {
    if (ev.target === ov) ov.hidden = true;
  });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') for (const ov of document.querySelectorAll('.modal-overlay')) ov.hidden = true;
});
$('#newTaskBtn').addEventListener('click', () => openTaskModal(null));
$('#newProjectTaskBtn').addEventListener('click', () => {
  const project = selectedProject();
  if (!project) return;
  openTaskModal(null, { projectPath: project.path });
});
$('#newProjectBtn').addEventListener('click', () => openProjectModal(null));
$('#projectMediaBtn').addEventListener('click', () => {
  const project = selectedProject();
  if (project) openMedia(project.path, { addToContext: false });
});
$('#editProjectBtn').addEventListener('click', () => {
  const project = selectedProject();
  if (project) openProjectModal(project);
});

function setPage(page) {
  currentPage = ['dashboard', 'projects', 'settings'].includes(page) ? page : 'dashboard';
  for (const btn of document.querySelectorAll('.page-tab')) {
    btn.classList.toggle('active', btn.dataset.page === currentPage);
  }
  for (const panel of document.querySelectorAll('[data-page-panel]')) {
    panel.hidden = panel.dataset.pagePanel !== currentPage;
  }
  if (currentPage === 'projects' && !selectedProject() && PROJECTS[0]) selectedProjectId = PROJECTS[0].id;
  if (currentPage === 'settings') loadCurrentSettingsSection();
  renderBoard();
  renderGeneralSettings();
  renderModelsSection();
  renderExtensionsSection();
}

$('#dashboardPageBtn').addEventListener('click', () => setPage('dashboard'));
$('#projectsPageBtn').addEventListener('click', () => setPage('projects'));
$('#settingsPageBtn').addEventListener('click', () => setPage('settings'));
$('#refreshModelsBtn').addEventListener('click', loadModelConnections);
$('#refreshExtensionsBtn').addEventListener('click', loadExtensions);
for (const btn of document.querySelectorAll('[data-settings-section]')) {
  btn.addEventListener('click', () => setSettingsSection(btn.dataset.settingsSection));
}
$('#caffeinateToggle').addEventListener('change', () => setCaffeinateEnabled($('#caffeinateToggle').checked));
$('#checkUpdatesBtn').addEventListener('click', checkForUpdates);
$('#dryRunUpdateBtn').addEventListener('click', () => runUpdateAction('dryRun'));
$('#applyUpdateBtn').addEventListener('click', () => runUpdateAction('apply'));
$('#rollbackUpdateBtn').addEventListener('click', () => runUpdateAction('rollback'));

/* -------------------------------------------------------- sub-panel controls */

function syncArchiveToggles() {
  const dashboardToggle = $('#showArchive');
  const projectToggle = $('#projectShowArchive');
  if (dashboardToggle) dashboardToggle.checked = showArchive;
  if (projectToggle) projectToggle.checked = showArchive;
}

async function setShowArchive(checked) {
  showArchive = checked;
  syncArchiveToggles();
  if (showArchive) await loadArchived();
  else { archivedCache = []; rebuildIndex(); }
  renderBoard();
  syncProjectFilter();
}

$('#showArchive').addEventListener('change', () => setShowArchive($('#showArchive').checked));
$('#projectShowArchive').addEventListener('change', () => setShowArchive($('#projectShowArchive').checked));

function syncProjectFilter() {
  const sel = $('#projectFilter');
  const paths = [...new Set(PROJECTS.map((p) => p.path))]
    .filter(Boolean)
    .sort((a, b) => displayProject(a).localeCompare(displayProject(b)));
  const want = [['', 'All projects'], ...paths.map((p) => [p, displayProject(p)])];
  const have = [...sel.options].map((o) => [o.value, o.textContent]);
  if (JSON.stringify(want) === JSON.stringify(have)) return;
  const current = sel.value;
  sel.replaceChildren(...want.map(([v, label]) => h('option', { value: v }, label)));
  sel.value = want.some(([v]) => v === current) ? current : '';
  projectFilter = sel.value;
}
$('#projectFilter').addEventListener('change', () => {
  projectFilter = $('#projectFilter').value;
  renderBoard();
});

/* -------------------------------------------------------- project page */

function projectTaskCount(projectPath) {
  return taskSource().filter((t) => t.project_path === projectPath).length;
}

function selectProjectPage(id) {
  selectedProjectId = id;
  renderBoard();
}

function renderProjectsPage() {
  const list = $('#projectList');
  if (!list) return;
  if (selectedProjectId && !projectById(selectedProjectId)) selectedProjectId = null;
  if (!selectedProjectId && PROJECTS[0]) selectedProjectId = PROJECTS[0].id;

  $('#projectListCount').textContent = PROJECTS.length;
  list.replaceChildren();
  if (!PROJECTS.length) {
    list.append(h('div', { class: 'project-empty' }, 'No projects'));
  } else {
    for (const p of PROJECTS) {
      const active = p.id === selectedProjectId;
      list.append(
        h('button', {
          type: 'button',
          class: 'project-row' + (active ? ' active' : ''),
          onclick: () => selectProjectPage(p.id),
        },
          h('span', { class: 'project-row-main' },
            h('span', { class: 'project-row-title' },
              h('span', {}, p.name || displayProject(p.path)),
            ),
            h('span', { class: 'project-row-path' }, p.path),
          ),
          h('span', { class: 'project-row-count' }, projectTaskCount(p.path)),
        ),
      );
    }
  }

  const project = selectedProject();
  const title = $('#selectedProjectTitle');
  title.replaceChildren();
  if (project) {
    title.append(
      h('span', { class: 'project-title-text' }, project.name || displayProject(project.path)),
      project.git_initialized ? h('span', { class: 'project-git-badge project-git-badge-lg', title: 'Git repository' }, 'Git') : null,
      renderGraphifyPill(project, { action: true }),
    );
  } else {
    title.textContent = 'No projects';
  }
  $('#selectedProjectPath').textContent = project ? project.path : '';
  $('#selectedProjectDescription').textContent = project ? project.description || '' : '';
  $('#projectMediaBtn').disabled = !project;
  $('#editProjectBtn').disabled = !project;
  $('#newProjectTaskBtn').disabled = !project;
}

function setSettingsSection(section, opts) {
  opts = opts || {};
  currentSettingsSection = ['general', 'models', 'extensions'].includes(section) ? section : 'general';
  for (const btn of document.querySelectorAll('[data-settings-section]')) {
    btn.classList.toggle('active', btn.dataset.settingsSection === currentSettingsSection);
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) {
    panel.hidden = panel.dataset.settingsPanel !== currentSettingsSection;
  }
  renderGeneralSettings();
  renderModelsSection();
  renderExtensionsSection();
  if (currentPage === 'settings' && opts.load !== false) loadCurrentSettingsSection();
}

function loadCurrentSettingsSection() {
  setSettingsSection(currentSettingsSection, { load: false });
  if (currentSettingsSection === 'models') loadModelConnections();
  else if (currentSettingsSection === 'extensions') loadExtensions();
  else loadGeneralSettings();
}

function caffeinateStatusText(status) {
  if (!status) return 'Status unavailable';
  if (!status.enabled) return 'Off';
  if (status.active) return `Active · pid ${status.pid}`;
  if (!status.supported) return status.error || 'Not available on this system';
  return status.error ? `Not active · ${status.error}` : 'Starting...';
}

function caffeinateStatusClass(status) {
  if (!status || !status.enabled) return 'settings-toggle-note';
  if (status.active) return 'settings-toggle-note active';
  return 'settings-toggle-note warning';
}

function renderVersionSettings() {
  const grid = $('#versionGrid');
  if (!grid) return;
  const version = GENERAL_SETTINGS.version || {};
  const rows = [
    ['Version', version.version || 'unknown'],
    ['Commit', version.commit || 'not available'],
    ['Install path', version.installPath || 'unknown'],
    ['Data path', version.dataPath || 'unknown'],
    ['App home', version.appHome || 'unknown'],
    ['Channel', version.updateChannel || 'stable'],
    ['Last check', version.lastUpdateCheckAt || 'never'],
    ['Latest release', version.latestReleaseVersion || 'unknown'],
    ['Update available', version.latestReleaseAvailable ? 'yes' : 'no'],
    ['Rollback ref', version.rollbackRef || 'none'],
  ];
  grid.replaceChildren(...rows.map(([label, value]) =>
    h('div', { class: 'settings-kv-row' },
      h('span', { class: 'settings-kv-label' }, label),
      h('span', { class: 'settings-kv-value', title: value }, value),
    ),
  ));
  const button = $('#checkUpdatesBtn');
  if (button) button.disabled = updateCheckSaving;
  const dryRunButton = $('#dryRunUpdateBtn');
  if (dryRunButton) dryRunButton.disabled = !!updateActionSaving;
  const applyButton = $('#applyUpdateBtn');
  if (applyButton) applyButton.disabled = !!updateActionSaving || !version.latestReleaseAvailable;
  const rollbackButton = $('#rollbackUpdateBtn');
  if (rollbackButton) rollbackButton.disabled = !!updateActionSaving || !version.rollbackRef;
  const status = $('#versionStatus');
  if (status) {
    let text = 'Up to date';
    let cls = 'settings-toggle-note active';
    if (updateActionSaving) {
      text = updateActionSaving;
      cls = 'settings-toggle-note';
    } else if (updateCheckSaving) {
      text = 'Checking...';
      cls = 'settings-toggle-note';
    } else if (version.latestReleaseError) {
      text = version.latestReleaseError;
      cls = 'settings-toggle-note warning';
    } else if (version.latestReleaseAvailable) {
      text = `Update available: ${version.latestReleaseVersion}`;
      cls = 'settings-toggle-note warning';
    } else if (!version.lastUpdateCheckAt) {
      text = 'Not checked yet';
      cls = 'settings-toggle-note';
    }
    status.textContent = text;
    status.className = cls;
    status.title = version.latestReleaseUrl || text;
  }
}

function renderGeneralSettings() {
  const toggle = $('#caffeinateToggle');
  if (toggle) {
    toggle.checked = !!GENERAL_SETTINGS.caffeinateEnabled;
    toggle.disabled = generalSettingsSaving;
  }
  const status = GENERAL_SETTINGS.caffeinate || null;
  const statusEl = $('#caffeinateStatus');
  if (statusEl) {
    statusEl.textContent = caffeinateStatusText(status);
    statusEl.className = caffeinateStatusClass(status);
    statusEl.title = status && status.command ? status.command : '';
  }
  renderVersionSettings();
}

async function loadGeneralSettings() {
  try {
    GENERAL_SETTINGS = await api.get('/api/settings/general');
    renderGeneralSettings();
  } catch (e) {
    const statusEl = $('#caffeinateStatus');
    if (statusEl) {
      statusEl.textContent = e.message;
      statusEl.className = 'settings-toggle-note warning';
    }
  }
}

async function setCaffeinateEnabled(checked) {
  generalSettingsSaving = true;
  GENERAL_SETTINGS = { ...GENERAL_SETTINGS, caffeinateEnabled: checked, caffeinate: { ...(GENERAL_SETTINGS.caffeinate || {}), enabled: checked } };
  renderGeneralSettings();
  try {
    GENERAL_SETTINGS = await api.send('PATCH', '/api/settings/general', { caffeinate_enabled: checked });
    toast(checked ? 'Caffeinate enabled' : 'Caffeinate disabled');
  } catch (e) {
    toast('Caffeinate update failed: ' + e.message, { err: true });
    await loadGeneralSettings();
  } finally {
    generalSettingsSaving = false;
    renderGeneralSettings();
  }
}

async function checkForUpdates() {
  updateCheckSaving = true;
  renderVersionSettings();
  try {
    const result = await api.send('POST', '/api/version/check', {});
    GENERAL_SETTINGS = { ...GENERAL_SETTINGS, version: result.version || GENERAL_SETTINGS.version };
    const check = result.updateCheck || {};
    if (check.ok && check.updateAvailable) toast('Update available: ' + (check.release && check.release.version || 'latest release'));
    else if (check.ok) toast('No update available');
    else toast('Update check failed: ' + (check.error || 'unknown error'), { err: true });
  } catch (e) {
    toast('Update check failed: ' + e.message, { err: true });
  } finally {
    updateCheckSaving = false;
    renderGeneralSettings();
  }
}

async function runUpdateAction(kind) {
  if (updateActionSaving || restartingServer || quittingServer) return;
  const endpoints = {
    dryRun: '/api/update/dry-run',
    apply: '/api/update/apply',
    rollback: '/api/update/rollback',
  };
  const labels = {
    dryRun: 'Update dry run',
    apply: 'Update',
    rollback: 'Rollback',
  };
  if (kind === 'apply' && !confirm('Update Control Center and restart the local server?')) return;
  if (kind === 'rollback' && !confirm('Rollback Control Center and restart the local server?')) return;
  updateActionSaving = labels[kind] + ' running...';
  renderVersionSettings();
  try {
    const res = await api.send('POST', endpoints[kind], {});
    GENERAL_SETTINGS = { ...GENERAL_SETTINGS, version: res.version || GENERAL_SETTINGS.version };
    if (res.restarting) {
      restartingServer = true;
      toast(labels[kind] + ' complete. Restarting...');
      await waitForRestart(res.bootId || currentBootId || null);
      window.location.reload();
      return;
    }
    toast(labels[kind] + ' passed');
  } catch (e) {
    toast(labels[kind] + ' failed: ' + e.message, { err: true });
  } finally {
    updateActionSaving = null;
    renderGeneralSettings();
  }
}

function extensionItemList(title, items) {
  if (!items || !items.length) return null;
  return h('div', { class: 'extension-items' },
    h('div', { class: 'extension-items-title' }, title),
    ...items.map((item) =>
      h('a', { href: item.url || '#', target: '_blank', rel: 'noreferrer' }, item.title || item.id),
    ),
  );
}

function renderExtensionsSection() {
  const summary = $('#extensionsSummary');
  const grid = $('#extensionGrid');
  const conflictList = $('#extensionConflictList');
  if (!summary || !grid || !conflictList) return;
  const extensions = EXTENSION_SETTINGS.extensions || [];
  const conflicts = EXTENSION_SETTINGS.conflicts || [];
  summary.textContent = `${extensions.length} installed · ${conflicts.length} conflicts · ${EXTENSION_SETTINGS.extensionsDir || 'extension directory unavailable'}`;
  grid.replaceChildren();
  if (!extensions.length) {
    grid.append(h('div', { class: 'empty-state' }, 'No extensions installed.'));
  } else {
    for (const ext of extensions) {
      const status = ext.enabled ? 'Enabled' : 'Disabled';
      grid.append(
        h('div', { class: 'extension-card' },
          h('div', { class: 'extension-card-head' },
            h('div', {},
              h('div', { class: 'extension-title' }, ext.name || ext.id),
              h('div', { class: 'extension-meta' }, `${ext.id}${ext.version ? ' · ' + ext.version : ''}`),
            ),
            h('span', { class: 'status-pill ' + (ext.enabled ? 'st-running' : 'st-needs_attention') }, status),
          ),
          ext.description ? h('div', { class: 'extension-description' }, ext.description) : null,
          ext.errors && ext.errors.length ? h('div', { class: 'extension-error' }, ext.errors.join(' · ')) : null,
          extensionItemList('Settings panels', ext.settingsPanels),
          extensionItemList('Task detail sections', ext.taskDetailSections),
          extensionItemList('Project actions', ext.projectActions),
          ext.routes && ext.routes.length ? h('div', { class: 'extension-items' },
            h('div', { class: 'extension-items-title' }, 'API routes'),
            ...ext.routes.map((route) => h('code', {}, route.mount || route.path)),
          ) : null,
        ),
      );
    }
  }

  conflictList.replaceChildren();
  if (!conflicts.length) {
    conflictList.append(h('div', { class: 'empty-state' }, 'No extension conflicts detected.'));
  } else {
    for (const conflict of conflicts) {
      const label = conflict.id || conflict.key || conflict.type;
      conflictList.append(h('div', { class: 'extension-conflict' },
        h('strong', {}, conflict.type),
        h('span', {}, label),
      ));
    }
  }
}

async function loadExtensions() {
  try {
    EXTENSION_SETTINGS = await api.get('/api/extensions');
    renderExtensionsSection();
  } catch (e) {
    const summary = $('#extensionsSummary');
    if (summary) summary.textContent = e.message;
  }
}

function modelStatusLabel(provider) {
  return MODEL_STATUS_LABELS[provider && provider.status] || 'Unknown';
}

function modelUsageNote(provider) {
  if (!provider) return '';
  if (provider.active) return 'Used for new dashboard task launches.';
  if (provider.disabledReason) return provider.disabledReason;
  return 'Connected but not selected for task launches.';
}

function modelNeedsSetup(provider) {
  return provider && (!provider.installed || !provider.connected);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', {}, text);
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function renderModelSetup(provider) {
  if (!modelNeedsSetup(provider) || !provider.setup) return null;
  return h('div', { class: 'model-setup' },
    h('div', { class: 'model-setup-title' }, provider.setup.title || 'Set up CLI'),
    h('pre', { class: 'model-setup-command' }, provider.setup.command || ''),
    h('div', { class: 'model-setup-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        onclick: async () => {
          const ok = await copyText(provider.setup.command || '');
          toast(ok ? 'Command copied' : 'Copy failed', { err: !ok });
        },
      }, provider.setup.actionLabel || 'Copy command'),
    ),
  );
}

function renderModelProvider(provider) {
  const status = provider.status || 'missing';
  const version = provider.version || 'Not found';
  const auth = provider.auth || {};
  const actionLabel = provider.active ? 'Active' : 'Use for tasks';
  return h('article', { class: 'model-card' + (provider.active ? ' active' : '') },
    h('div', { class: 'model-card-head' },
      h('div', { class: 'model-card-main' },
        h('div', { class: 'model-card-title-row' },
          h('h4', { class: 'model-card-title' }, provider.name || provider.id),
          h('span', { class: 'model-card-status model-status-' + status }, modelStatusLabel(provider)),
        ),
        h('div', { class: 'model-fields' },
          h('div', { class: 'model-field' },
            h('span', { class: 'model-field-label' }, 'Version'),
            h('span', { class: 'model-field-value', title: version }, version),
          ),
          h('div', { class: 'model-field' },
            h('span', { class: 'model-field-label' }, 'Auth'),
            h('span', { class: 'model-field-value' }, auth.configured ? (auth.method || 'configured') : 'not connected'),
          ),
          h('div', { class: 'model-field' },
            h('span', { class: 'model-field-label' }, 'Launch'),
            h('span', { class: 'model-field-value' }, provider.launchSupported ? 'supported' : 'not wired'),
          ),
        ),
      ),
    ),
    h('div', { class: 'model-card-actions' },
      h('span', { class: 'model-usage-note' }, modelUsageNote(provider)),
      h('button', {
        type: 'button',
        class: 'btn btn-sm' + (provider.active ? ' btn-primary' : ''),
        disabled: provider.active || !provider.canActivate,
        onclick: () => activateModelProvider(provider.id),
      }, actionLabel),
    ),
    renderModelSetup(provider),
  );
}

function renderModelsSection() {
  const grid = $('#modelProviderGrid');
  if (!grid) return;
  const providers = MODEL_CONNECTIONS.providers || [];
  const active = providers.find((p) => p.active);
  const connectedCount = providers.filter((p) => p.connected).length;
  const summary = $('#modelsSummary');
  if (summary) {
    summary.textContent = providers.length
      ? `${connectedCount}/${providers.length} connected · Active: ${active ? active.name : 'none'}`
      : 'No model CLIs discovered yet';
  }
  grid.replaceChildren();
  if (!providers.length) {
    grid.append(h('div', { class: 'project-empty' }, 'No model providers found'));
    return;
  }
  grid.append(...providers.map(renderModelProvider));
}

function updateSettingsAttention() {
  const btn = $('#settingsPageBtn');
  if (!btn) return;
  const providers = MODEL_CONNECTIONS.providers || [];
  const active = providers.find((p) => p.active);
  const needsSetup = !!(active && (!active.installed || !active.connected));
  btn.classList.toggle('needs-attention', needsSetup);
  btn.title = needsSetup ? `${active.name} needs setup before task launches` : '';
}

async function loadModelConnections() {
  try {
    MODEL_CONNECTIONS = await api.get('/api/connections/models');
    renderModelsSection();
    updateSettingsAttention();
  } catch (e) {
    const summary = $('#modelsSummary');
    if (summary) summary.textContent = 'Model check failed';
    const grid = $('#modelProviderGrid');
    if (grid) grid.replaceChildren(h('div', { class: 'project-empty' }, e.message));
  }
}

async function activateModelProvider(providerId) {
  try {
    MODEL_CONNECTIONS = await api.send('PATCH', '/api/connections/models', { active_provider: providerId });
    renderModelsSection();
    const active = (MODEL_CONNECTIONS.providers || []).find((p) => p.active);
    toast('Active model provider: ' + (active ? active.name : providerId));
  } catch (e) {
    toast('Model provider update failed: ' + e.message, { err: true });
  }
}

function openProjectModal(project) {
  $('#projectModalTitle').textContent = project ? 'Edit project' : 'New project';
  $('#projectId').value = project ? project.id : '';
  $('#p_name').value = project ? project.name : '';
  $('#p_path').value = project ? project.path : '';
  $('#p_description').value = project ? project.description || '' : '';
  $('#p_graphify').checked = project ? project.graphify_enabled !== 0 : true;
  $('#p_git').checked = project ? !!project.git_initialized : false;
  $('#p_git').disabled = project ? !!project.git_initialized : false;
  $('#p_git').closest('.checkbox').classList.toggle('disabled', $('#p_git').disabled);
  $('#projectDangerActions').hidden = !project;
  show('projectModal');
  setTimeout(() => (project ? $('#p_name') : $('#p_path')).focus(), 30);
}

$('#projectForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('#projectId').value;
  const body = {
    name: $('#p_name').value.trim(),
    path: $('#p_path').value.trim(),
    description: $('#p_description').value,
    graphify_enabled: $('#p_graphify').checked,
    git_enabled: $('#p_git').checked,
  };
  if (!body.path) return toast('Project path is required', { err: true });
  try {
    const saved = id
      ? await api.send('PATCH', `/api/projects/${id}`, body)
      : await api.send('POST', '/api/projects', body);
    selectedProjectId = saved.id;
    hide('projectModal');
    await loadProjects();
    await refresh(true);
  } catch (e) {
    toast('Project save failed: ' + e.message, { err: true });
  }
});

async function archiveProject(project, quiet) {
  if (!project) return;
  try {
    await api.send('POST', `/api/projects/${project.id}/archive`);
    selectedProjectId = null;
    hide('projectModal');
    await loadProjects();
    await refresh(true);
    if (!quiet) {
      toast('Archived "' + (project.name || displayProject(project.path)) + '"', {
        undo: () => unarchiveProject(project, true),
      });
    }
  } catch (e) {
    toast('Project archive failed: ' + e.message, { err: true });
  }
}

async function unarchiveProject(project, quiet) {
  if (!project) return;
  try {
    const restored = await api.send('POST', `/api/projects/${project.id}/unarchive`);
    selectedProjectId = restored.id;
    await loadProjects();
    await refresh(true);
    if (!quiet) toast('Project restored');
  } catch (e) {
    toast('Project restore failed: ' + e.message, { err: true });
  }
}

async function deleteProject(project) {
  if (!project) return;
  const name = project.name || displayProject(project.path);
  if (!confirm(`Delete "${name}" from the dashboard? Tasks and project files are not deleted.`)) return;
  try {
    await api.send('DELETE', `/api/projects/${project.id}`);
    selectedProjectId = null;
    hide('projectModal');
    await loadProjects();
    await refresh(true);
    toast('Deleted "' + name + '"');
  } catch (e) {
    toast('Project delete failed: ' + e.message, { err: true });
  }
}

$('#archiveProjectBtn').addEventListener('click', () => {
  const project = projectById($('#projectId').value);
  archiveProject(project);
});

$('#deleteProjectBtn').addEventListener('click', () => {
  const project = projectById($('#projectId').value);
  deleteProject(project);
});

/* ---- saved project picker (custom dropdown) ---- */

async function loadProjects() {
  try {
    const data = await api.get('/api/projects');
    workspaceRoot = data.root;
    PROJECTS = data.projects || [];
    if (selectedProjectId && !projectById(selectedProjectId)) selectedProjectId = null;
    if (!selectedProjectId && PROJECTS[0]) selectedProjectId = PROJECTS[0].id;

    const menu = $('#projectMenu');
    menu.replaceChildren();
    for (const p of PROJECTS) {
      menu.append(
        h('div', { class: 'project-item', onclick: () => selectProject(p.path, p.name || displayProject(p.path)) },
          h('span', {}, p.name || displayProject(p.path)),
          h('span', { class: 'arrow' }, String(projectTaskCount(p.path))),
        ),
      );
    }
    if (!PROJECTS.length) menu.append(h('div', { class: 'project-empty' }, 'Create a project first.'));
    const hint = $('#projectHint');
    if (hint) hint.textContent = PROJECTS.length ? '' : '— create one on Projects';
    syncProjectFilter();
    renderBoard();
  } catch (e) {
    /* picker is a convenience */
  }
}

/* ---------------------------------------------------------------- health */

// No health indicator in the top nav anymore — we still read /api/health to pick up the YOLO
// default for new tasks and the workspace root for path display.
async function loadHealth() {
  try {
    const hd = await api.get('/api/health');
    currentBootId = hd.bootId || currentBootId;
    healthYoloDefault = !!hd.skipPermissions;
    ultracodeEnabled = !!hd.ultracodeEnabled;
    if (hd.workspaceRoot) workspaceRoot = hd.workspaceRoot;
    if (hd.caffeinate) {
      GENERAL_SETTINGS = {
        ...GENERAL_SETTINGS,
        caffeinateEnabled: !!hd.caffeinate.enabled,
        caffeinate: hd.caffeinate,
      };
      renderGeneralSettings();
    }
  } catch {
    /* ignore */
  }
}

function setRestartUi(on) {
  const btn = $('#restartServerBtn');
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('restarting', on);
  btn.title = on ? 'Restarting server' : 'Restart server';
  btn.setAttribute('aria-label', on ? 'Restarting server' : 'Restart server');
}

function setQuitUi(on) {
  const btn = $('#quitServerBtn');
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('quitting', on);
}

async function waitForRestart(oldBootId) {
  const deadline = Date.now() + 20000;
  let sawOffline = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('/api/health?restartProbe=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const hd = await r.json().catch(() => ({}));
        if ((oldBootId && hd.bootId && hd.bootId !== oldBootId) || (!oldBootId && sawOffline && hd.ok)) return hd;
      }
    } catch {
      sawOffline = true;
    }
    await sleep(350);
  }
  throw new Error('server did not come back online');
}

async function restartServer() {
  if (restartingServer || quittingServer) return;
  restartingServer = true;
  setRestartUi(true);
  toast('Restarting server...');
  try {
    const res = await api.send('POST', '/api/restart');
    const oldBootId = currentBootId || res.bootId || null;
    await waitForRestart(oldBootId);
    window.location.reload();
  } catch (e) {
    restartingServer = false;
    setRestartUi(false);
    toast('Restart failed: ' + e.message, { err: true });
  }
}

$('#restartServerBtn').addEventListener('click', restartServer);

function renderQuitFallback() {
  document.body.replaceChildren(
    h('main', { class: 'quit-screen' },
      h('img', { class: 'quit-screen-icon', src: NOTIFY_ICON, alt: '' }),
      h('h1', {}, 'Control Center stopped'),
      h('p', {}, 'You can close this tab. Reopen Control Center.app to start it again.'),
    ),
  );
}

function closeDashboardTab() {
  try {
    window.close();
  } catch {
    /* browser blocked close */
  }
  setTimeout(renderQuitFallback, 250);
}

async function quitServer() {
  if (quittingServer || restartingServer) return;
  quittingServer = true;
  setQuitUi(true);
  toast('Quitting Control Center...');
  try {
    await api.send('POST', '/api/quit');
  } catch {
    quittingServer = false;
    setQuitUi(false);
    toast('Quit failed. Restart the server once to load the new quit endpoint.', { err: true });
    return;
  }
  closeDashboardTab();
}

$('#quitServerBtn').addEventListener('click', quitServer);

/* -------------------------------------------------- desktop notifications */

// Real OS-level notifications (Web Notifications API) so a task that needs the user's eyes is
// visible from any app — not just when the dashboard tab is in front. We fire on each transition
// INTO a notify-worthy state by diffing displayStatus against the previous 2.5s poll:
//   • needs_attention — Codex finished a turn / is idle and waiting for input
//   • done            — the task completed
// Dashboard is served from localhost / 127.0.0.1, which Chrome treats as a secure context, so the
// Notification API is available here without HTTPS.
const NOTIFY_KEY = 'dashboard.notify';
const OLD_NOTIFY_KEY = 'planora.notify';
migrateStorageKey(OLD_NOTIFY_KEY, NOTIFY_KEY);
const NOTIFY_STATES = {
  needs_attention: { verb: 'Needs attention', blurb: 'Codex is waiting for you', sticky: true },
  done: { verb: 'Done', blurb: 'task complete', sticky: false },
};
const NOTIFY_ICON = new URL('/notification-icon.png', window.location.href).href;

function notificationTaskTitle(t) {
  const text = String(t.title || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Untitled task';
  return text.length > 140 ? text.slice(0, 137).trimEnd() + '...' : text;
}

const notifier = {
  enabled: false,
  seeded: false, // first scan only records a baseline so we don't fire for pre-existing tasks
  prev: new Map(), // taskId -> last-seen displayStatus
  live: new Map(), // taskId -> open Notification, so we can retract it once the task moves on
  _lastPerm: null, // last-seen Notification.permission, to re-sync the toggle on external changes

  supported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  },

  init() {
    const btn = $('#notifyToggle');
    if (!this.supported()) {
      if (btn) btn.hidden = true; // browser can't notify — don't show a dead control
      return;
    }
    btn.hidden = false;
    btn.addEventListener('click', () => this.toggle());
    // Re-enable silently if the user turned it on before AND the grant is still in place. The read
    // is guarded: localStorage can throw (SecurityError) when site data is blocked, and init() runs
    // first at boot — an uncaught throw here would abort the whole dashboard, not just notifications.
    let saved = null;
    try {
      saved = localStorage.getItem(NOTIFY_KEY);
    } catch {
      /* storage blocked/partitioned — treat as "off" */
    }
    this._lastPerm = Notification.permission;
    this.enabled = saved === 'on' && Notification.permission === 'granted';
    this.render();
  },

  render() {
    const btn = $('#notifyToggle');
    if (!btn) return;
    const denied = this.supported() && Notification.permission === 'denied';
    const on = this.enabled && !denied;
    btn.classList.toggle('on', on);
    btn.classList.toggle('denied', denied);
    btn.replaceChildren(bellIcon(!on || denied));
    btn.title = denied
      ? 'Notifications are blocked for this site — re-enable them via the 🔒/ⓘ icon in Chrome’s address bar.'
      : on
        ? 'Desktop notifications are ON for tasks that need attention or finish. Click to turn off.'
        : 'Turn on desktop notifications for tasks that need attention or finish.';
    btn.setAttribute('aria-label', denied ? 'Notifications blocked' : on ? 'Turn off desktop notifications' : 'Turn on desktop notifications');
  },

  async toggle() {
    if (!this.supported()) return;
    if (this.enabled) {
      this.setEnabled(false);
      toast('Desktop notifications off');
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = Notification.permission;
      }
    }
    if (perm === 'granted') {
      this.setEnabled(true);
      toast('Desktop notifications on');
      this.show('🔔 Notifications enabled', 'You’ll be pinged when a task needs attention or finishes.', { tag: 'dashboard-test' });
    } else {
      this.setEnabled(false);
      toast(
        perm === 'denied'
          ? 'Notifications are blocked — re-enable them in Chrome’s site settings.'
          : 'Notification permission was not granted.',
        { err: true },
      );
    }
  },

  setEnabled(on) {
    this.enabled = on;
    try {
      localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off');
    } catch {
      /* storage unavailable — best-effort */
    }
    this.render();
  },

  // Diff the freshly-polled task list; fire once per transition into a notify-worthy state. The
  // first scan only seeds the baseline (no burst of notifications for tasks already done/waiting).
  scan(tasks) {
    if (!this.supported()) return;
    this.syncPermission(); // keep the toggle honest if permission was changed in Chrome's settings
    const present = new Set();
    for (const t of tasks) {
      present.add(t.id);
      const ds = t.displayStatus || 'waiting';
      const before = this.prev.get(t.id);
      this.prev.set(t.id, ds);
      // Retract a still-open banner once the task leaves the state it was raised for, so a sticky
      // "Codex is waiting for you" can't linger after Codex has resumed (or the task finished).
      if (before && before !== ds && NOTIFY_STATES[before]) this.dismiss(t.id);
      if (!this.seeded || before === undefined) continue; // baseline (or first sight of a task)
      if (ds === before || !NOTIFY_STATES[ds] || !this.enabled) continue;
      this.fireFor(t, ds);
    }
    // Forget tasks that left the board (archived/removed); retract any banner they still own.
    for (const id of [...this.prev.keys()]) {
      if (present.has(id)) continue;
      this.prev.delete(id);
      this.dismiss(id);
    }
    this.seeded = true;
  },

  // Re-render the toggle when permission is changed outside the page (the lock/ⓘ → site settings).
  // Cheap and idempotent, so it's safe to call from every poll.
  syncPermission() {
    const perm = Notification.permission;
    if (perm === this._lastPerm) return;
    this._lastPerm = perm;
    if (perm === 'denied' && this.enabled) this.setEnabled(false); // clears the stale "on" + persists + renders
    else this.render();
  },

  // Close a task's outstanding notification (if any) so banners track reality.
  dismiss(id) {
    const n = this.live.get(id);
    if (!n) return;
    try {
      n.close();
    } catch {
      /* ignore */
    }
    this.live.delete(id);
  },

  fireFor(t, ds) {
    const meta = NOTIFY_STATES[ds];
    const proj = displayProject(t.project_path);
    if (ds === 'needs_attention') {
      this.show(meta.blurb, proj ? `${proj} — ${notificationTaskTitle(t)}` : notificationTaskTitle(t), {
        tag: 'dashboard-task-' + t.id,
        sticky: meta.sticky,
        taskId: t.id,
      });
      return;
    }
    this.show(`${meta.verb} — ${t.title}`, proj ? `${proj} · ${meta.blurb}` : meta.blurb, {
      tag: 'dashboard-task-' + t.id,
      sticky: meta.sticky,
      taskId: t.id,
    });
  },

  show(title, body, opts) {
    opts = opts || {};
    if (!this.supported() || Notification.permission !== 'granted') return;
    let n;
    try {
      n = new Notification(title, {
        body,
        icon: NOTIFY_ICON,
        badge: NOTIFY_ICON,
        tag: opts.tag,
        renotify: !!opts.tag, // re-alert when a tagged notification is replaced
        // Best-effort "keep on screen until dismissed". On macOS this only holds if Chrome is set to
        // "Alerts" (not "Banners") in System Settings ▸ Notifications; otherwise the OS auto-dismisses
        // it. We also retract it ourselves once the task leaves the state (see scan/dismiss).
        requireInteraction: !!opts.sticky,
      });
    } catch {
      return; // some platforms forbid the bare constructor — fail quiet
    }
    if (opts.taskId) {
      this.live.set(opts.taskId, n);
      n.onclose = () => {
        if (this.live.get(opts.taskId) === n) this.live.delete(opts.taskId);
      };
    }
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      const t = opts.taskId && byId.get(opts.taskId);
      if (t) {
        if (t.session_id) openTab(t);
        else openDetails(t.id);
      }
      if (opts.taskId) this.live.delete(opts.taskId);
      n.close();
    };
  },
};

/* ----------------------------------------------------------------- boot */

notifier.init();
loadHealth();
loadModelConnections();
loadProjects();
refresh(true);
setInterval(() => {
  if ($('#taskModal').hidden && $('#detailsModal').hidden && $('#mediaModal').hidden) refresh();
  else tabs.sync();
  if (currentPage === 'projects' && !shouldDeferBoardRender()) loadProjects();
  if (!$('#drawer').hidden && tabs.activeId) tabs.refreshUsage();
}, 2500);
