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

function trashIcon() {
  return svgIcon([
    'M3 6h18',
    'M8 6V4h8v2',
    'M6 6l1 15h10l1-15',
    'M10 11v6',
    'M14 11v6',
  ]);
}

const $ = (sel) => document.querySelector(sel);

function reloadForChangedServerBoot(response) {
  const responseBootId = response && response.headers.get('x-control-center-boot-id');
  if (!responseBootId || !currentBootId || responseBootId === currentBootId) return false;
  restartingServer = true;
  window.location.reload();
  return true;
}

const api = {
  async get(url) {
    const r = await fetch(url);
    if (reloadForChangedServerBoot(r)) return new Promise(() => {});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (reloadForChangedServerBoot(r)) return new Promise(() => {});
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
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
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
let SKILL_SETTINGS = { provider: null, activeProvider: null, providers: [], roots: {}, recommended: [], providerSkills: [], userSkills: [] };
let skillCategoryCollapsed = { recommended: false, provider: false, user: false };
let byId = new Map();
let lastSig = null;
let workspaceRoot = null;
let projectFilter = '';
let selectedProjectId = null;
const SETTINGS_SECTIONS = ['general', 'models', 'skills', 'extensions'];
let currentPage = 'dashboard';
let currentSettingsSection = 'general';
let dashboardShowArchive = false;
let projectArchiveVisibility = {};
let healthYoloDefault = true;
let ultracodeEnabled = false;
let currentBootId = null;
let restartingServer = false;
let quittingServer = false;
let generalSettingsSaving = false;
let updateCheckSaving = false;
let updateActionSaving = null;
let extensionInstallSaving = false;
let extensionInstallMessage = '';
let extensionInstallFiles = [];
let skillActionSaving = null;
let archivedCache = [];
let tabsRestored = false; // one-shot guard: re-open live terminals on the first page load
let uiStateRestoring = false;
const UI_STATE_KEY = 'dashboard.uiState'; // sessionStorage { bootId, state }
const OPEN_TABS_KEY = 'dashboard.openTabs'; // localStorage { bootId, ids, activeId } for live terminal tabs
const BOARD_RENDER_SETTLE_MS = 180;
const TERMINAL_WRITE_CHUNK = 64 * 1024;
let pendingBoardRender = false;
let pendingProjectFilterSync = false;
let boardRenderTimer = null;
let deferBoardRenderUntil = 0;
let mouseButtonDown = false;
const activePointers = new Set();
const cardCaches = new Map();

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storageBootMatches(payload) {
  return !!(payload && currentBootId && payload.bootId === currentBootId);
}

function clearStaleBootStorage() {
  try {
    const ui = safeJsonParse(sessionStorage.getItem(UI_STATE_KEY));
    if (ui && currentBootId && ui.bootId !== currentBootId) sessionStorage.removeItem(UI_STATE_KEY);
  } catch {
    /* storage unavailable — best-effort */
  }
  try {
    const openTabs = safeJsonParse(localStorage.getItem(OPEN_TABS_KEY));
    if (openTabs && currentBootId && openTabs.bootId !== currentBootId) localStorage.removeItem(OPEN_TABS_KEY);
  } catch {
    /* storage unavailable — best-effort */
  }
}

function projectSectionKey(el) {
  return el.dataset.projectSection || el.id || el.getAttribute('aria-controls') || '';
}

function collapsedProjectSections() {
  const ids = [];
  for (const el of document.querySelectorAll('[data-project-section]')) {
    const id = projectSectionKey(el);
    if (!id) continue;
    const collapsed = el.tagName === 'DETAILS'
      ? !el.open
      : el.classList.contains('collapsed') || el.getAttribute('aria-expanded') === 'false';
    if (collapsed) ids.push(id);
  }
  return ids;
}

function applyCollapsedProjectSections(ids) {
  const collapsed = new Set(Array.isArray(ids) ? ids : []);
  for (const el of document.querySelectorAll('[data-project-section]')) {
    const id = projectSectionKey(el);
    if (!id) continue;
    const isCollapsed = collapsed.has(id);
    if (el.tagName === 'DETAILS') el.open = !isCollapsed;
    else {
      el.classList.toggle('collapsed', isCollapsed);
      if (el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    }
  }
}

function persistedUiState() {
  return {
    page: currentPage,
    selectedProjectId,
    settingsSection: currentSettingsSection,
    projectFilter,
    dashboardShowArchive,
    projectArchiveVisibility,
    collapsedProjectSections: collapsedProjectSections(),
  };
}

function persistUiState() {
  if (uiStateRestoring || !currentBootId) return;
  try {
    sessionStorage.setItem(UI_STATE_KEY, JSON.stringify({ bootId: currentBootId, state: persistedUiState() }));
  } catch {
    /* storage unavailable — best-effort */
  }
}

function restoreUiStateForBoot() {
  if (!currentBootId) return false;
  clearStaleBootStorage();
  let saved = null;
  try {
    saved = safeJsonParse(sessionStorage.getItem(UI_STATE_KEY));
  } catch {
    return false;
  }
  if (!storageBootMatches(saved) || !saved.state) return false;
  const state = saved.state;
  uiStateRestoring = true;
  currentPage = ['dashboard', 'projects', 'settings'].includes(state.page) ? state.page : currentPage;
  currentSettingsSection = SETTINGS_SECTIONS.includes(state.settingsSection) ? state.settingsSection : currentSettingsSection;
  selectedProjectId = state.selectedProjectId || selectedProjectId;
  projectFilter = typeof state.projectFilter === 'string' ? state.projectFilter : projectFilter;
  // `showArchive` is the legacy shared setting. Preserve it only as the
  // dashboard preference while project boards get independent preferences.
  dashboardShowArchive = state.dashboardShowArchive == null ? !!state.showArchive : !!state.dashboardShowArchive;
  projectArchiveVisibility = state.projectArchiveVisibility && typeof state.projectArchiveVisibility === 'object'
    ? { ...state.projectArchiveVisibility }
    : {};
  requestAnimationFrame(() => applyCollapsedProjectSections(state.collapsedProjectSections));
  uiStateRestoring = false;
  return true;
}

function showRestoreLoading(step) {
  const overlay = $('#restoreLoading');
  if (!overlay) return;
  document.body.classList.add('restore-loading-active');
  overlay.hidden = false;
  restoreLoadingStep(step || 'Restoring workspace...');
}

function restoreLoadingStep(step) {
  const text = $('#restoreLoadingStep');
  if (text) text.textContent = step || 'Restoring workspace...';
}

function hideRestoreLoading() {
  const overlay = $('#restoreLoading');
  document.body.classList.remove('restore-loading-active');
  if (!overlay) return;
  overlay.hidden = true;
}

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

function compatibilityOwner(domain) {
  const ownership = EXTENSION_SETTINGS && EXTENSION_SETTINGS.platform && EXTENSION_SETTINGS.platform.ownership;
  const state = ownership && ownership[domain];
  return state && state.activeOwner ? state.activeOwner : 'legacy';
}

function legacyOwnsUi(domain) {
  return compatibilityOwner(domain) === 'legacy';
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

function renderProjectHeaderBadges(project) {
  const gitBadge = legacyOwnsUi('git')
    ? project && project.git_initialized
      ? h('span', {
          class: 'project-git-badge project-git-badge-lg',
          title: 'Project Git repository\n' + (project.git_repo_root || project.path || ''),
        }, 'Git')
      : project && project.git_repo_kind === 'parent'
        ? h('span', {
            class: 'project-git-badge project-git-badge-lg project-git-badge-warn',
            title: project.git_warning || ('Parent Git repository: ' + project.git_parent_repo_root),
          }, 'Parent Git')
        : null
    : null;
  return [
    gitBadge,
    legacyOwnsUi('graphify') ? renderGraphifyPill(project, { action: true }) : null,
    ...renderExtensionNodes('projectBadges', { project }, 'project-header'),
  ].filter(Boolean);
}

function extensionRuntime() {
  return window.ControlCenterExtensions || null;
}

function extensionRenderVersion() {
  const runtime = extensionRuntime();
  return runtime ? runtime.renderVersion || 0 : 0;
}

function appExtensionContext(extra) {
  return {
    h,
    api,
    toast,
    tasks: TASKS,
    projects: PROJECTS,
    selectedProject: selectedProject(),
    workspaceRoot,
    ...(extra || {}),
  };
}

function renderExtensionNodes(kind, context, slot) {
  const runtime = extensionRuntime();
  if (!runtime) return [];
  try {
    return runtime.render(kind, appExtensionContext(context), slot);
  } catch (e) {
    toast('Extension render failed: ' + e.message, { err: true });
    return [];
  }
}

async function invokeExtensionContributions(kind, method, context, slot) {
  const runtime = extensionRuntime();
  if (!runtime) return [];
  return runtime.invoke(kind, method, appExtensionContext(context), slot);
}

function extensionModalNodes(content) {
  if (content == null || content === false) return [];
  if (Array.isArray(content)) return content.flatMap(extensionModalNodes);
  if (content.nodeType) return [content];
  return [document.createTextNode(String(content))];
}

function openExtensionModal(opts) {
  opts = opts || {};
  $('#extensionModalTitle').textContent = opts.title || 'Extension';
  $('#extensionModalSub').textContent = opts.subtitle || '';
  $('#extensionModalSub').hidden = !opts.subtitle;
  $('#extensionModalBody').replaceChildren(...extensionModalNodes(opts.body || opts.content));
  $('#extensionModalActions').replaceChildren(...extensionModalNodes(opts.actions));
  show('extensionModal');
}

function migrationOwnerLabel(target) {
  if (!target) return 'Legacy';
  if (target.activeOwner === 'legacy') return target.fallbackReason ? 'Legacy fallback' : 'Legacy';
  return target.activeOwner || target.targetOwner || 'Legacy';
}

function migrationWelcomeBody(state) {
  const rows = (state.targets || []).map((target) =>
    h('div', { class: 'settings-kv-row' },
      h('span', { class: 'settings-kv-label' }, target.domain === 'git' ? 'Git Workflow' : 'Graphify'),
      h('span', {
        class: 'settings-kv-value',
        title: target.fallbackReason || '',
      }, `${migrationOwnerLabel(target)} · ${target.affectedProjects || 0} projects`),
    ),
  );
  const details = state.details || {};
  return [
    h('p', {}, state.body || ''),
    h('div', { class: 'settings-kv-grid' }, rows),
    h('details', { class: 'migration-details' },
      h('summary', {}, 'Details'),
      h('pre', {}, JSON.stringify({
        variant: state.variant,
        ledgerStatus: details.ledgerStatus,
        ledgerError: details.ledgerError,
        planCreatedAt: details.planCreatedAt,
        targets: state.targets,
      }, null, 2)),
    ),
  ];
}

async function completeMigrationWelcome(state) {
  await api.send('POST', '/api/migration/welcome/complete', { version: state.version });
  hide('extensionModal');
}

async function retryMigrationWelcome(state) {
  try {
    const result = await api.send('POST', '/api/migration/retry', {});
    await loadExtensions({ quiet: true });
    openMigrationWelcome(result.welcome || { ...state, variant: 'migrated', canRetry: false });
  } catch (e) {
    toast('Migration retry failed: ' + e.message, { err: true });
  }
}

function openMigrationWelcome(state) {
  const actions = [];
  if (state.canRetry) {
    actions.push(h('button', {
      type: 'button',
      class: 'btn',
      onclick: () => retryMigrationWelcome(state),
    }, state.secondaryAction || 'Retry migration'));
  }
  actions.push(h('button', {
    type: 'button',
    class: 'btn btn-primary',
    onclick: () => completeMigrationWelcome(state).catch((e) => toast('Could not save: ' + e.message, { err: true })),
  }, state.primaryAction || 'Continue'));
  openExtensionModal({
    title: state.title || 'Bundled integrations',
    subtitle: state.variant || '',
    body: migrationWelcomeBody(state),
    actions,
  });
}

async function loadMigrationWelcome(force) {
  try {
    const state = await api.get('/api/migration/welcome' + (force ? '?force=1' : ''));
    if (force || state.show) openMigrationWelcome(state);
  } catch {
    /* welcome must never block startup */
  }
}

function configureExtensionRuntimeHost() {
  const runtime = extensionRuntime();
  if (!runtime) return;
  runtime.setHostApi({
    h,
    toast,
    refresh,
    loadProjects,
    renderBoard,
    openModal: openExtensionModal,
    closeModal: () => hide('extensionModal'),
  });
}

async function refresh(force, initialTasks) {
  try {
    const data = initialTasks || await api.get('/api/tasks');
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

function taskSource(includeArchived = dashboardShowArchive) {
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
  const project = selectedProject();
  const projectShowArchive = projectArchiveIsVisible(project);
  const sigTasks = dashboardShowArchive || projectShowArchive ? [...TASKS, ...archivedCache] : TASKS;
  return JSON.stringify({
    dashboardShowArchive,
    projectShowArchive,
    projectFilter,
    selectedProjectId,
    extensionRenderVersion: extensionRenderVersion(),
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
  const order = Number(t.col_order);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function cardRenderSignature(t) {
  const childSig = (t.children || []).map((cid) => {
    const child = byId.get(cid);
    return cid + ':' + (child ? child.title : '');
  }).join(',');
  return [taskBoardSignature(t), childSig, extensionRenderVersion()].join('\u001e');
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
  if (!commit) return '';
  if (commit.ok && commit.hash) return 'Committed ' + commit.hash;
  if (commit.skipped === 'parent_repo') {
    return 'Git auto-commit skipped: project is inside a parent repository';
  }
  if (commit.warning) return 'Git auto-commit skipped: ' + commit.warning;
  return '';
}

async function completeTaskAndClose(id, { message, beforeId = null } = {}) {
  const updated = await api.send('POST', `/api/tasks/${id}/done`, { before_id: beforeId });
  const task = byId.get(id);
  if (task) {
    Object.assign(task, updated, { live: false, activity: null, displayStatus: 'done' });
    rebuildIndex();
    renderBoard();
    tabs.sync();
    notifier.scan(TASKS);
  }
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
  return taskSource(projectArchiveIsVisible(project)).filter((t) => t.project_path === project.path);
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
      .sort((a, b) => columnSortValue(a) - columnSortValue(b) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
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
      if (ev.target.closest('button, a, input, label, .extension-ui')) return;
      openDetails(t.id);
    },
  });

  card.addEventListener('dragstart', (ev) => {
    if (ev.target.closest('button, .fork-chip, .extension-ui')) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.setData('text/plain', t.id);
    ev.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearBoardDropIndicators();
  });

  // status line on top: a prominent status pill leads the card
  const tags = h('div', { class: 'card-tags' });
  tags.append(h('span', { class: 'status-pill st-' + ds }, STATUS_LABELS[ds] || ds));
  if (isFork) tags.append(h('span', { class: 'tag fork' }, '⑂ fork'));
  if (t.children && t.children.length) tags.append(h('span', { class: 'tag parent' }, '⑂ ' + t.children.length));
  tags.append(...renderExtensionNodes('taskBadges', { task: t }, 'task-card'));
  card.append(tags);

  card.append(h('div', { class: 'card-title' }, t.title));
  card.append(h('div', { class: 'card-path' }, displayProject(t.project_path)));
  if (t.description) card.append(h('div', { class: 'card-desc' }, t.description));

  const actions = h('div', { class: 'card-actions' });
  if (t.archived) {
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => openDetails(t.id) }, 'Details'));
    actions.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => unarchiveTask(t) }, 'Unarchive'));
  } else if (t.status === 'backlog') {
    // Backlog = not started yet → editable, and Start launches it.
    actions.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => startTask(t) }, 'Start'));
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => openTaskModal(t) }, 'Edit'));
    if (isEditable(t)) actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => deleteTask(t) }, 'Delete'));
    actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => archiveTask(t) }, 'Archive'));
  } else {
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => (t.live ? openTab(t) : resumeTask(t)) }, t.live ? 'Open' : 'Resume'));
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => openDetails(t.id) }, 'Details'));
    if (t.session_id) actions.append(h('button', { class: 'btn btn-sm', onclick: () => forkTask(t) }, 'Fork'));
    actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => archiveTask(t) }, 'Archive'));
  }
  actions.append(...renderExtensionNodes('taskActions', { task: t }, 'task-card'));
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

function clearBoardDropIndicators() {
  for (const body of document.querySelectorAll('.col-body')) {
    body.classList.remove('drag-over', 'drop-at-end');
    for (const card of body.querySelectorAll('.card.drop-before')) card.classList.remove('drop-before');
  }
}

function dropBeforeCard(body, clientY, draggingId) {
  const cards = [...body.querySelectorAll('.card')]
    .filter((card) => card.dataset.id !== draggingId && !card.classList.contains('dragging'));
  return cards.reduce((closest, card) => {
    const box = card.getBoundingClientRect();
    const offset = clientY - box.top - box.height / 2;
    return offset < 0 && offset > closest.offset ? { offset, card } : closest;
  }, { offset: Number.NEGATIVE_INFINITY, card: null }).card;
}

/* drag & drop within and between columns — the release position is persisted */
for (const body of document.querySelectorAll('.col-body')) {
  body.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    clearBoardDropIndicators();
    body.classList.add('drag-over');
    const before = dropBeforeCard(body, ev.clientY, id);
    if (before) before.classList.add('drop-before');
    else body.classList.add('drop-at-end');
  });
  body.addEventListener('dragleave', (ev) => {
    if (ev.relatedTarget && body.contains(ev.relatedTarget)) return;
    clearBoardDropIndicators();
  });
  body.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    const status = body.dataset.drop;
    const task = byId.get(id);
    const before = dropBeforeCard(body, ev.clientY, id);
    const beforeId = before ? before.dataset.id : null;
    clearBoardDropIndicators();
    if (!task) return;
    try {
      if (status === 'in_progress' && task.status !== status && !task.archived) {
        // Auto-launch: resume if it already has a session, otherwise start fresh.
        if (task.session_id) await api.send('POST', `/api/tasks/${id}/resume`, { before_id: beforeId });
        else await api.send('POST', `/api/tasks/${id}/start`, { before_id: beforeId });
        await refresh(true);
        openTab(byId.get(id) || task);
      } else if (status === 'done' && task.status !== status) {
        await completeTaskAndClose(id, { beforeId });
      } else {
        await api.send('POST', `/api/tasks/${id}/move`, { status, before_id: beforeId });
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

async function deleteTask(t) {
  if (!isEditable(t)) {
    toast('Only unstarted backlog tasks can be deleted.', { err: true });
    return;
  }
  if (!confirm('Permanently delete this unstarted backlog task?')) return;
  try {
    tabs.remove(t.id, { stop: true });
    await api.send('DELETE', `/api/tasks/${t.id}`);
    TASKS = TASKS.filter((x) => x.id !== t.id);
    archivedCache = archivedCache.filter((x) => x.id !== t.id);
    rebuildIndex();
    renderBoard();
    tabs.sync();
    await refresh(true);
    toast('Deleted “' + t.title + '”');
  } catch (e) {
    toast('Delete failed: ' + e.message, { err: true });
    refresh(true);
  }
}

// Archive with no confirmation modal — reversible via the toast's Undo or the Show-archive view.
async function archiveTask(t) {
  try {
    tabs.remove(t.id, { stop: true });
    await api.send('POST', `/api/tasks/${t.id}/archive`);
    if (archivesAreVisible()) await loadArchived();
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
    defaultModel: 'gpt-5.6-sol',
    models: Object.entries(MODEL_LABELS).filter(([id]) => id.startsWith('gpt-')).map(([id, label]) => ({ id, label })),
    modes: ['build', 'plan'],
    supports: { ultracode: false },
  };
}

function syncTaskProviderControls(task) {
  const provider = task && task.provider
    ? (MODEL_CONNECTIONS.providers || []).find((p) => p.id === task.provider) || activeProviderInfo()
    : activeProviderInfo();
  const models = provider.models && provider.models.length ? provider.models : [{ id: provider.defaultModel || 'gpt-5.6-sol', label: modelLabel(provider.defaultModel || 'gpt-5.6-sol') }];
  const select = $('#f_model');
  select.replaceChildren(...models.map((m) => h('option', { value: m.id }, m.label || modelLabel(m.id))));
  select.value = task ? task.model : provider.defaultModel || models[0].id;
  if (!select.value && models[0]) select.value = models[0].id;
  syncCustomSelect(select);

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

/* Native selects retain their form value/event contract, but their browser-owned
   option popovers are replaced with the same in-app menu pattern as Project. */
const customSelectControls = new Map();

function closeCustomSelects(except) {
  for (const [select, control] of customSelectControls) {
    if (select === except) continue;
    control.menu.hidden = true;
    control.trigger.setAttribute('aria-expanded', 'false');
  }
}

function syncCustomSelect(select) {
  const control = customSelectControls.get(select);
  if (control) control.render();
}

function enhanceCustomSelect(select) {
  if (!select || customSelectControls.has(select)) return;
  const wrapper = h('div', { class: 'custom-select' });
  const label = h('span', { class: 'custom-select-label' });
  const trigger = h('button', {
    type: 'button',
    class: 'project-trigger custom-select-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  }, label, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  const menu = h('div', { class: 'project-menu custom-select-menu', role: 'listbox', hidden: true });

  select.before(wrapper);
  wrapper.append(select, trigger, menu);
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const render = () => {
    const selected = select.options[select.selectedIndex] || select.options[0];
    label.textContent = selected ? selected.textContent : 'Select…';
    trigger.disabled = select.disabled;
    trigger.title = select.title || '';
    menu.replaceChildren(...[...select.options].map((option) => h('button', {
      type: 'button',
      class: 'project-item custom-select-option' + (option.selected ? ' selected' : ''),
      role: 'option',
      'aria-selected': option.selected ? 'true' : 'false',
      disabled: option.disabled,
      onclick: (ev) => {
        ev.stopPropagation();
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
      },
    }, h('span', {}, option.textContent), option.selected ? h('span', { class: 'custom-select-check', 'aria-hidden': 'true' }, '✓') : null)));
  };

  trigger.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const opening = menu.hidden;
    closeCustomSelects(select);
    menu.hidden = !opening;
    trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });
  trigger.addEventListener('keydown', (ev) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Escape'].includes(ev.key)) return;
    ev.preventDefault();
    if (ev.key === 'Escape') {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      return;
    }
    if (menu.hidden) {
      closeCustomSelects(select);
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }
    const options = [...menu.querySelectorAll('.custom-select-option:not(:disabled)')];
    const selectedIndex = options.findIndex((item) => item.getAttribute('aria-selected') === 'true');
    const target = ev.key === 'ArrowUp' ? options[Math.max(0, selectedIndex - 1)] : options[Math.max(0, selectedIndex)];
    if (target) target.focus();
  });
  menu.addEventListener('keydown', (ev) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(ev.key)) return;
    ev.preventDefault();
    if (ev.key === 'Escape') {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
      return;
    }
    const options = [...menu.querySelectorAll('.custom-select-option:not(:disabled)')];
    const current = options.indexOf(document.activeElement);
    let next = current;
    if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = options.length - 1;
    else if (ev.key === 'ArrowDown') next = Math.min(options.length - 1, current + 1);
    else if (ev.key === 'ArrowUp') next = Math.max(0, current - 1);
    if (options[next]) options[next].focus();
  });
  select.addEventListener('change', render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
  customSelectControls.set(select, { wrapper, trigger, menu, render });
  render();
}

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.custom-select')) closeCustomSelects();
});

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
  body.replaceChildren(
    renderDetailInfo(t),
    renderPromptSection(t),
    ...renderExtensionNodes('taskDetailSections', { task: t }, 'task-detail'),
    h('div', { class: 'empty-state' }, t.session_id ? 'Loading session details…' : 'Not started yet — click Start to launch a session.'),
  );
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
      ...renderExtensionNodes('taskDetailSections', { task: t, conversation: conv }, 'task-detail'),
      renderActivity(conv),
    );
  } catch (e) {
    body.replaceChildren(
      renderDetailInfo(t),
      renderPromptSection(t),
      ...renderExtensionNodes('taskDetailSections', { task: t }, 'task-detail'),
      h('div', { class: 'empty-state' }, 'Session details not available yet: ' + e.message),
    );
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
    bar.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => { unarchiveTask(t); hide('detailsModal'); } }, 'Unarchive'));
    return;
  }
  if (isEditable(t)) {
    bar.append(h('button', { class: 'btn btn-sm', onclick: () => { hide('detailsModal'); openTaskModal(t); } }, 'Edit'));
    bar.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => { hide('detailsModal'); startTask(t); } }, 'Start'));
  } else {
    bar.append(h('button', { class: 'btn btn-primary btn-sm', onclick: () => { hide('detailsModal'); t.live ? openTab(t) : resumeTask(t); } }, t.live ? 'Open' : 'Resume'));
    if (t.session_id) bar.append(h('button', { class: 'btn btn-sm', onclick: () => { hide('detailsModal'); forkTask(t); } }, 'Fork'));
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
    if (!currentBootId) return;
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ bootId: currentBootId, ids: [...this.map.keys()], activeId: this.activeId }));
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
    $('#tdProject').textContent = displayProject(t.project_path);
    $('#tdPath').textContent = t.project_path || '';
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
  restoreLoadingStep('Reconnecting live terminal tabs...');
  const liveById = new Map(TASKS.filter((t) => t.live).map((t) => [t.id, t]));
  if (!liveById.size) return;
  let saved = { ids: [], activeId: null };
  try {
    const v = safeJsonParse(localStorage.getItem(OPEN_TABS_KEY));
    if (!storageBootMatches(v)) {
      if (v) localStorage.removeItem(OPEN_TABS_KEY);
      return;
    }
    saved = { ids: Array.isArray(v.ids) ? v.ids : [], activeId: v.activeId || null };
  } catch {
    /* ignore malformed state */
  }
  // Honour the saved order for tabs still live. Do not open non-live tasks: reconnecting must
  // attach to existing PTYs only, never resume a previous session after a server restart.
  const ordered = [];
  const seen = new Set();
  for (const id of saved.ids) {
    if (liveById.has(id) && !seen.has(id)) { ordered.push(liveById.get(id)); seen.add(id); }
  }
  if (!ordered.length) return;
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
  renderSkillsSection();
  renderExtensionsSection();
  persistUiState();
}

$('#dashboardPageBtn').addEventListener('click', () => setPage('dashboard'));
$('#projectsPageBtn').addEventListener('click', () => setPage('projects'));
$('#settingsPageBtn').addEventListener('click', () => setPage('settings'));
$('#appHomeLink').addEventListener('click', (ev) => {
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  setPage('dashboard');
});
$('#refreshModelsBtn').addEventListener('click', loadModelConnections);
$('#createSkillBtn').addEventListener('click', startSkillCreate);
$('#installSkillBtn').addEventListener('click', openSkillInstallModal);
$('#skillInstallForm').addEventListener('submit', submitSkillInstall);
for (const btn of document.querySelectorAll('[data-skill-category]')) {
  btn.addEventListener('click', () => setSkillCategoryCollapsed(btn.dataset.skillCategory, !skillCategoryCollapsed[btn.dataset.skillCategory]));
}
$('#installExtensionBtn').addEventListener('click', openExtensionInstallModal);
$('#extensionInstallForm').addEventListener('submit', submitExtensionInstall);
$('#extensionFolderInput').addEventListener('change', (ev) => {
  extensionInstallFiles = [...(ev.currentTarget.files || [])];
  renderExtensionInstallState();
});
$('#refreshExtensionsBtn').addEventListener('click', loadExtensions);
for (const btn of document.querySelectorAll('[data-settings-section]')) {
  btn.addEventListener('click', () => setSettingsSection(btn.dataset.settingsSection));
}
$('#caffeinateToggle').addEventListener('change', () => setCaffeinateEnabled($('#caffeinateToggle').checked));
$('#checkUpdatesBtn').addEventListener('click', checkForUpdates);
$('#dryRunUpdateBtn').addEventListener('click', () => runUpdateAction('dryRun'));
$('#applyUpdateBtn').addEventListener('click', () => runUpdateAction('apply'));
$('#rollbackUpdateBtn').addEventListener('click', () => runUpdateAction('rollback'));
$('#confirmUpdateBtn').addEventListener('click', confirmUpdateAction);
$('#migrationWelcomeBtn').addEventListener('click', () => loadMigrationWelcome(true));

/* -------------------------------------------------------- sub-panel controls */

function syncArchiveToggles() {
  const dashboardToggle = $('#showArchive');
  const projectToggle = $('#projectShowArchive');
  const project = selectedProject();
  if (dashboardToggle) dashboardToggle.checked = dashboardShowArchive;
  if (projectToggle) {
    projectToggle.checked = projectArchiveIsVisible(project);
    projectToggle.disabled = !project;
  }
}

function projectArchiveIsVisible(project = selectedProject()) {
  return !!(project && projectArchiveVisibility[project.id]);
}

function archivesAreVisible() {
  return dashboardShowArchive || Object.values(projectArchiveVisibility).some(Boolean);
}

async function refreshArchiveSource() {
  if (archivesAreVisible()) await loadArchived();
  else {
    archivedCache = [];
    rebuildIndex();
  }
}

async function setDashboardShowArchive(checked) {
  dashboardShowArchive = checked;
  syncArchiveToggles();
  await refreshArchiveSource();
  renderBoard();
  syncProjectFilter();
  persistUiState();
}

async function setProjectShowArchive(checked) {
  const project = selectedProject();
  if (!project) return;
  projectArchiveVisibility = { ...projectArchiveVisibility, [project.id]: checked };
  syncArchiveToggles();
  await refreshArchiveSource();
  renderBoard();
  persistUiState();
}

$('#showArchive').addEventListener('change', () => setDashboardShowArchive($('#showArchive').checked));
$('#projectShowArchive').addEventListener('change', () => setProjectShowArchive($('#projectShowArchive').checked));

function syncProjectFilter() {
  const sel = $('#projectFilter');
  const paths = [...new Set(PROJECTS.map((p) => p.path))]
    .filter(Boolean)
    .sort((a, b) => displayProject(a).localeCompare(displayProject(b)));
  const want = [['', 'All projects'], ...paths.map((p) => [p, displayProject(p)])];
  const have = [...sel.options].map((o) => [o.value, o.textContent]);
  if (JSON.stringify(want) === JSON.stringify(have)) {
    if (sel.value !== projectFilter && want.some(([v]) => v === projectFilter)) sel.value = projectFilter;
    return;
  }
  const current = projectFilter || sel.value;
  sel.replaceChildren(...want.map(([v, label]) => h('option', { value: v }, label)));
  sel.value = want.some(([v]) => v === current) ? current : '';
  projectFilter = sel.value;
  syncCustomSelect(sel);
}
$('#projectFilter').addEventListener('change', () => {
  projectFilter = $('#projectFilter').value;
  renderBoard();
  persistUiState();
});

/* -------------------------------------------------------- project page */

function projectTaskCount(projectPath) {
  const project = projectByPath(projectPath);
  return taskSource(projectArchiveIsVisible(project)).filter((t) => t.project_path === projectPath).length;
}

function projectNeedsAttention(projectPath) {
  return taskSource().some((t) => (
    t.project_path === projectPath &&
    !t.archived &&
    t.displayStatus === 'needs_attention'
  ));
}

function selectProjectPage(id) {
  selectedProjectId = id;
  syncArchiveToggles();
  renderBoard();
  persistUiState();
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
              projectNeedsAttention(p.path)
                ? h('span', { class: 'project-attention-dot', title: 'A task needs attention' })
                : null,
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
      ...renderProjectHeaderBadges(project),
    );
  } else {
    title.textContent = 'No projects';
  }
  $('#selectedProjectPath').textContent = project ? project.path : '';
  $('#selectedProjectDescription').textContent = project ? project.description || '' : '';
  $('#projectMediaBtn').disabled = !project;
  $('#editProjectBtn').disabled = !project;
  $('#newProjectTaskBtn').disabled = !project;
  syncArchiveToggles();
  renderProjectExtensionActions(project);
}

function renderProjectExtensionActions(project) {
  const host = $('#projectExtensionActions');
  if (!host) return;
  host.replaceChildren();
  if (!project) return;
  host.append(...renderExtensionNodes('projectActions', { project }, 'project-header'));
}

function setSettingsSection(section, opts) {
  opts = opts || {};
  const next = SETTINGS_SECTIONS.includes(section) ? section : 'general';
  const changed = currentSettingsSection !== next;
  currentSettingsSection = next;
  for (const btn of document.querySelectorAll('[data-settings-section]')) {
    btn.classList.toggle('active', btn.dataset.settingsSection === currentSettingsSection);
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) {
    panel.hidden = panel.dataset.settingsPanel !== currentSettingsSection;
  }
  renderGeneralSettings();
  renderModelsSection();
  renderSkillsSection();
  renderExtensionsSection();
  if (currentPage === 'settings' && opts.load !== false) loadCurrentSettingsSection();
  if (changed) persistUiState();
}

function loadCurrentSettingsSection() {
  setSettingsSection(currentSettingsSection, { load: false });
  if (currentSettingsSection === 'models') loadModelConnections();
  else if (currentSettingsSection === 'skills') loadSkills();
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
  if (kind === 'apply' || kind === 'rollback') {
    openUpdateConfirmModal(kind);
    return;
  }
  await executeUpdateAction(kind);
}

let pendingUpdateAction = null;

function openUpdateConfirmModal(kind) {
  const version = GENERAL_SETTINGS.version || {};
  const rollback = kind === 'rollback';
  pendingUpdateAction = kind;
  $('#updateConfirmEyebrow').textContent = rollback ? 'Restore previous version' : 'New version available';
  $('#updateConfirmTitle').textContent = rollback ? 'Rollback Control Center?' : 'Update Control Center?';
  $('#updateConfirmDescription').textContent = rollback
    ? 'Control Center will restore the previous version and restart the local server. Your projects and runtime data will stay in place.'
    : 'Control Center will install the latest version and restart the local server. Your projects and runtime data will stay in place.';
  $('#updateCurrentVersion').textContent = version.version || 'Current';
  $('#updateLatestVersion').textContent = rollback ? (version.rollbackRef || 'Previous') : (version.latestReleaseVersion || 'Latest');
  $('#confirmUpdateBtn').textContent = rollback ? 'Rollback and restart' : 'Update and restart';
  show('updateConfirmModal');
  $('#confirmUpdateBtn').focus();
}

async function confirmUpdateAction() {
  const kind = pendingUpdateAction;
  if (!kind) return;
  pendingUpdateAction = null;
  hide('updateConfirmModal');
  await executeUpdateAction(kind);
}

async function executeUpdateAction(kind) {
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

function skillProviderName(providerId) {
  const provider = (SKILL_SETTINGS.providers || MODEL_CONNECTIONS.providers || []).find((p) => p.id === providerId);
  if (provider && provider.name) return provider.name;
  return providerId === 'claude' ? 'Claude' : 'Codex';
}

function selectedSkillProvider() {
  return SKILL_SETTINGS.provider || SKILL_SETTINGS.activeProvider || MODEL_CONNECTIONS.activeProvider || 'codex';
}

function setSkillCategoryCollapsed(category, collapsed) {
  if (!Object.prototype.hasOwnProperty.call(skillCategoryCollapsed, category)) return;
  skillCategoryCollapsed = { ...skillCategoryCollapsed, [category]: !!collapsed };
  renderSkillsSection();
}

function syncSkillCategoryToggle(category, count) {
  const btn = document.querySelector(`[data-skill-category="${category}"]`);
  if (!btn) return;
  const collapsed = !!skillCategoryCollapsed[category];
  btn.classList.toggle('collapsed', collapsed);
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const countEl = category === 'recommended' ? $('#recommendedSkillCount')
    : category === 'provider' ? $('#providerSkillCount')
      : $('#userSkillCount');
  if (countEl) countEl.textContent = `(${count})`;
}

function skillListEmpty(text) {
  return h('div', { class: 'empty-state skill-empty' }, text);
}

function renderSkillProviderSwitch(selectedProvider) {
  const host = $('#skillProviderSwitch');
  if (!host) return;
  const providers = (SKILL_SETTINGS.providers && SKILL_SETTINGS.providers.length)
    ? SKILL_SETTINGS.providers
    : (MODEL_CONNECTIONS.providers || []);
  const entries = providers.length ? providers : [
    { id: 'codex', name: 'Codex', active: selectedProvider === 'codex' },
    { id: 'claude', name: 'Claude', active: selectedProvider === 'claude' },
  ];
  host.replaceChildren(...entries.map((provider) => {
    const selected = provider.id === selectedProvider;
    return h('button', {
      type: 'button',
      class: 'btn btn-sm' + (selected ? ' btn-primary' : ''),
      disabled: !!skillActionSaving || selected,
      title: provider.active ? 'Active model provider' : (provider.disabledReason || `Show ${provider.name || provider.id} skills`),
      onclick: () => loadSkills(provider.id),
    }, provider.name || provider.id);
  }));
}

function renderSkillInfo(skill) {
  return h('div', { class: 'skill-row-main' },
    h('div', { class: 'skill-row-title' }, skill.name || skill.id),
    h('div', { class: 'skill-row-description' }, skill.description || 'No description'),
  );
}

function skillUninstallButton(skill) {
  if (!skill || !skill.editable) return null;
  return h('button', {
    type: 'button',
    class: 'icon-btn skill-trash-btn',
    disabled: !!skillActionSaving,
    title: 'Uninstall skill',
    'aria-label': 'Uninstall ' + (skill.name || skill.id),
    onclick: () => uninstallSkill(skill),
  }, trashIcon());
}

function renderRecommendedSkill(skill) {
  const editableInstalledSkill = skill.installedSkill && skill.installedSkill.editable ? skill.installedSkill : null;
  return h('article', { class: 'skill-row' },
    renderSkillInfo(skill),
    h('div', { class: 'skill-row-actions' },
      skill.installed
        ? h('span', { class: 'skill-installed-badge' }, 'Installed')
        : h('button', {
          type: 'button',
          class: 'btn btn-sm',
          disabled: !!skillActionSaving,
          onclick: () => installRecommendedSkill(skill),
        }, skillActionSaving === skill.id ? 'Installing...' : 'Install'),
      editableInstalledSkill ? h('button', {
        type: 'button',
        class: 'btn btn-sm',
        disabled: !!skillActionSaving,
        onclick: () => startSkillEdit(editableInstalledSkill),
      }, skillActionSaving === editableInstalledSkill.id ? 'Opening...' : 'Edit skill') : null,
      skillUninstallButton(editableInstalledSkill),
      h('a', {
        class: 'icon-btn skill-source-link',
        href: skill.sourceUrl,
        target: '_blank',
        rel: 'noreferrer',
        title: 'Open source',
      }, '↗'),
    ),
  );
}

function renderProviderSkill(skill) {
  return h('article', { class: 'skill-row' },
    renderSkillInfo(skill),
  );
}

function renderUserSkill(skill) {
  return h('article', { class: 'skill-row' },
    renderSkillInfo(skill),
    h('div', { class: 'skill-row-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        disabled: !!skillActionSaving,
        onclick: () => startSkillEdit(skill),
      }, skillActionSaving === skill.id ? 'Opening...' : 'Edit skill'),
      skillUninstallButton(skill),
    ),
  );
}

function renderSkillsSection() {
  const summary = $('#skillsSummary');
  const recommended = $('#recommendedSkillList');
  const providerList = $('#providerSkillList');
  const userList = $('#userSkillList');
  if (!summary || !recommended || !providerList || !userList) return;
  const createButton = $('#createSkillBtn');
  const installButton = $('#installSkillBtn');
  const skillsReady = !!SKILL_SETTINGS.provider;
  if (createButton) createButton.disabled = !!skillActionSaving || !skillsReady;
  if (installButton) installButton.disabled = !!skillActionSaving || !skillsReady;
  const providerName = skillProviderName(selectedSkillProvider());
  const root = SKILL_SETTINGS.roots && SKILL_SETTINGS.roots.userDir;
  const recommendedSkills = SKILL_SETTINGS.recommended || [];
  const providerSkills = SKILL_SETTINGS.providerSkills || [];
  const userSkills = SKILL_SETTINGS.userSkills || [];
  summary.textContent = `${providerName} · ${userSkills.length} user skills · ${providerSkills.length} provider skills${root ? ' · ' + root : ''}`;
  renderSkillProviderSwitch(selectedSkillProvider());
  const sectionTitle = $('#providerSkillSectionTitle');
  if (sectionTitle) sectionTitle.textContent = providerName;
  syncSkillCategoryToggle('recommended', recommendedSkills.length);
  syncSkillCategoryToggle('provider', providerSkills.length);
  syncSkillCategoryToggle('user', userSkills.length);

  recommended.replaceChildren();
  recommended.hidden = !!skillCategoryCollapsed.recommended;
  for (const skill of recommendedSkills) recommended.append(renderRecommendedSkill(skill));
  if (!recommended.childElementCount) recommended.append(skillListEmpty('No recommended skills.'));

  providerList.replaceChildren();
  providerList.hidden = !!skillCategoryCollapsed.provider;
  for (const skill of providerSkills) providerList.append(renderProviderSkill(skill));
  if (!providerList.childElementCount) providerList.append(skillListEmpty(`No ${providerName} provider skills found.`));

  userList.replaceChildren();
  userList.hidden = !!skillCategoryCollapsed.user;
  for (const skill of userSkills) userList.append(renderUserSkill(skill));
  if (!userList.childElementCount) userList.append(skillListEmpty('No user skills installed.'));
}

async function loadSkills(providerId) {
  const provider = providerId || selectedSkillProvider();
  const suffix = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  try {
    SKILL_SETTINGS = await api.get('/api/skills' + suffix);
    renderSkillsSection();
  } catch (e) {
    const summary = $('#skillsSummary');
    if (summary) summary.textContent = 'Skill check failed';
    const list = $('#userSkillList');
    if (list) list.replaceChildren(h('div', { class: 'project-empty' }, e.message));
  }
}

async function openSkillTaskResult(result, message) {
  await refresh(true);
  const task = result && result.task && (byId.get(result.task.id) || result.task);
  if (task) tabs.open(task, { focusTerminal: true });
  if (message) toast(message);
}

async function startSkillCreate() {
  const provider = selectedSkillProvider();
  skillActionSaving = 'create';
  renderSkillsSection();
  try {
    const result = await api.send('POST', '/api/skills/create-session', { provider });
    await openSkillTaskResult(result, 'Skill creator opened');
  } catch (e) {
    toast('Skill creator failed: ' + e.message, { err: true });
  } finally {
    skillActionSaving = null;
    renderSkillsSection();
  }
}

async function startSkillEdit(skill) {
  if (!skill) return;
  const provider = selectedSkillProvider();
  skillActionSaving = skill.id;
  renderSkillsSection();
  try {
    const result = await api.send('POST', '/api/skills/edit-session', { provider, skill_id: skill.id });
    await openSkillTaskResult(result, 'Skill editor opened');
  } catch (e) {
    toast('Skill editor failed: ' + e.message, { err: true });
  } finally {
    skillActionSaving = null;
    renderSkillsSection();
  }
}

async function installRecommendedSkill(skill) {
  if (!skill || skill.installed) return;
  const provider = selectedSkillProvider();
  skillActionSaving = skill.id;
  renderSkillsSection();
  try {
    const result = await api.send('POST', '/api/skills/install', {
      provider,
      source: skill.sourceUrl,
      recommended_id: skill.id,
    });
    SKILL_SETTINGS = result.skills || SKILL_SETTINGS;
    renderSkillsSection();
    toast('Installed ' + (skill.name || skill.id));
  } catch (e) {
    toast('Skill install failed: ' + e.message, { err: true });
  } finally {
    skillActionSaving = null;
    renderSkillsSection();
  }
}

async function uninstallSkill(skill) {
  if (!skill || !skill.editable) return;
  const name = skill.name || skill.id;
  if (!confirm(`Uninstall "${name}"? This removes the user skill folder.`)) return;
  const provider = selectedSkillProvider();
  skillActionSaving = skill.id;
  renderSkillsSection();
  try {
    const result = await api.send('DELETE', `/api/skills/${encodeURIComponent(provider)}/${encodeURIComponent(skill.id)}`);
    SKILL_SETTINGS = result.skills || SKILL_SETTINGS;
    renderSkillsSection();
    toast('Uninstalled ' + name);
  } catch (e) {
    toast('Skill uninstall failed: ' + e.message, { err: true });
  } finally {
    skillActionSaving = null;
    renderSkillsSection();
  }
}

function openSkillInstallModal() {
  $('#skillInstallSource').value = '';
  $('#skillInstallSubmit').disabled = false;
  show('skillInstallModal');
  setTimeout(() => $('#skillInstallSource').focus(), 30);
}

async function submitSkillInstall(ev) {
  ev.preventDefault();
  const provider = selectedSkillProvider();
  const source = $('#skillInstallSource').value.trim();
  if (!source) return toast('Skill source is required', { err: true });
  $('#skillInstallSubmit').disabled = true;
  skillActionSaving = 'install';
  renderSkillsSection();
  try {
    const result = await api.send('POST', '/api/skills/install', { provider, source });
    SKILL_SETTINGS = result.skills || SKILL_SETTINGS;
    hide('skillInstallModal');
    renderSkillsSection();
    toast('Installed ' + ((result.installed && (result.installed.name || result.installed.id)) || 'skill'));
  } catch (e) {
    toast('Skill install failed: ' + e.message, { err: true });
  } finally {
    $('#skillInstallSubmit').disabled = false;
    skillActionSaving = null;
    renderSkillsSection();
  }
}

function openExtensionInstallModal() {
  extensionInstallFiles = [];
  $('#extensionInstallSource').value = '';
  $('#extensionInstallSubdir').value = '';
  $('#extensionInstallOverwrite').checked = false;
  $('#extensionFolderInput').value = '';
  $('#extensionInstallStatus').hidden = true;
  $('#extensionInstallSubmit').disabled = false;
  renderExtensionInstallState();
  show('extensionInstallModal');
  setTimeout(() => $('#extensionInstallSource').focus(), 30);
}

function renderExtensionInstallState() {
  const note = $('#extensionFolderNote');
  if (note) {
    if (extensionInstallFiles.length) {
      const size = extensionInstallFiles.reduce((sum, file) => sum + file.size, 0);
      const label = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`;
      note.textContent = `${extensionInstallFiles.length} files · ${label}`;
    } else {
      note.textContent = 'No folder selected';
    }
  }
  const submit = $('#extensionInstallSubmit');
  if (submit) submit.disabled = !!extensionInstallSaving;
  const status = $('#extensionInstallStatus');
  if (status && extensionInstallSaving) {
    status.hidden = false;
    status.textContent = extensionInstallMessage || 'Installing extension...';
  }
  renderExtensionsSection();
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || '');
      resolve(raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw);
    };
    reader.onerror = () => reject(reader.error || new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function extensionUploadFilesPayload(files) {
  const maxBytes = 18 * 1024 * 1024;
  const maxFiles = 800;
  if (files.length > maxFiles) throw new Error(`Folder has too many files; maximum is ${maxFiles}`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > maxBytes) throw new Error('Folder is too large for browser upload; use Git install instead.');
  const out = [];
  for (const file of files) {
    out.push({
      relativePath: file.webkitRelativePath || file.name,
      contentBase64: await readFileBase64(file),
    });
  }
  return out;
}

function extensionInstallSuccessMessage(result) {
  const installed = result && result.installed;
  const name = installed && (installed.name || installed.id) || 'extension';
  const restart = installed && installed.restartRequired ? ' Restart to activate extension server routes.' : '';
  return `Installed ${name}.${restart}`;
}

async function submitExtensionInstall(ev) {
  ev.preventDefault();
  if (extensionInstallSaving) return;
  const source = $('#extensionInstallSource').value.trim();
  const subdir = $('#extensionInstallSubdir').value.trim();
  const overwrite = $('#extensionInstallOverwrite').checked;
  if (source && extensionInstallFiles.length) return toast('Use either a Git URL or a folder upload, not both.', { err: true });
  if (!source && !extensionInstallFiles.length) return toast('Choose a folder or enter a Git URL.', { err: true });
  extensionInstallSaving = true;
  extensionInstallMessage = source ? 'Cloning extension repository...' : 'Reading extension folder...';
  renderExtensionInstallState();
  try {
    let result;
    if (source) {
      extensionInstallMessage = 'Installing extension from Git...';
      renderExtensionInstallState();
      result = await api.send('POST', '/api/extensions/install-git', { source, subdir, overwrite });
    } else {
      const files = await extensionUploadFilesPayload(extensionInstallFiles);
      extensionInstallMessage = 'Uploading and installing extension...';
      renderExtensionInstallState();
      result = await api.send('POST', '/api/extensions/install-folder', { files, overwrite });
    }
    extensionInstallMessage = 'Refreshing installed extensions...';
    renderExtensionInstallState();
    hide('extensionInstallModal');
    await loadExtensions();
    toast(extensionInstallSuccessMessage(result));
  } catch (e) {
    const status = $('#extensionInstallStatus');
    if (status) {
      status.hidden = false;
      status.textContent = e.message;
    }
    toast('Extension install failed: ' + e.message, { err: true });
  } finally {
    extensionInstallSaving = false;
    extensionInstallMessage = '';
    renderExtensionInstallState();
  }
}

function renderExtensionInstallingCard() {
  return h('div', { class: 'extension-card extension-installing-card', 'aria-busy': 'true' },
    h('div', { class: 'extension-card-head' },
      h('div', { class: 'extension-installing-main' },
        h('div', { class: 'extension-installing-title-row' },
          h('span', { class: 'extension-install-spinner', 'aria-hidden': 'true' }),
          h('div', { class: 'extension-title' }, 'Installing extension'),
        ),
        h('div', { class: 'extension-meta' }, extensionInstallMessage || 'Preparing install...'),
      ),
      h('span', { class: 'status-pill st-running' }, 'Installing'),
    ),
    h('div', { class: 'extension-skeleton-line extension-skeleton-line-lg' }),
    h('div', { class: 'extension-skeleton-line' }),
    h('div', { class: 'extension-skeleton-row' },
      h('span', { class: 'extension-skeleton-chip' }),
      h('span', { class: 'extension-skeleton-chip' }),
      h('span', { class: 'extension-skeleton-chip extension-skeleton-chip-sm' }),
    ),
  );
}

function extensionItemList(title, items) {
  if (!items || !items.length) return null;
  return h('div', { class: 'extension-items' },
    h('div', { class: 'extension-items-title' }, title),
    ...items.map((item) => {
      const label = item.title || item.label || item.name || item.path || item.id;
      return item.url
        ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, label)
        : h('code', {}, label);
    }),
  );
}

function extensionCapabilities(ext) {
  const contributes = ext.contributes || {};
  const hooks = new Set((ext.hooks || []).map((hook) => hook.name));
  const capabilities = [];
  const add = (label) => {
    if (!capabilities.includes(label)) capabilities.push(label);
  };
  if (hooks.has('task.completed') || hooks.has('task.statusChanged')) add('Tracks task activity');
  if (hooks.has('project.metadata')) add('Adds project insights');
  if (hooks.has('git.autoCommitPolicy')) add('Can manage automatic commits');
  if ((contributes.projectFields || []).length) add('Adds project settings');
  if ((contributes.projectBadges || []).length && (contributes.taskBadges || []).length) add('Shows project and task badges');
  else if ((contributes.projectBadges || []).length) add('Shows project badges');
  else if ((contributes.taskBadges || []).length) add('Shows task badges');
  if ((contributes.projectActions || []).length) add('Adds project actions');
  if ((contributes.taskActions || []).length) add('Adds task actions');
  if ((contributes.taskDetailSections || []).length) add('Adds task details');
  if ((contributes.settingsPanels || []).length) add('Adds extension settings');
  if ((ext.routes || []).length) add('Provides local integrations');
  return capabilities;
}

function extensionContributionCount(ext) {
  return Object.values(ext.contributes || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
}

function extensionDeveloperDetails(ext) {
  const scripts = (ext.frontend && ext.frontend.scripts) || [];
  const styles = (ext.frontend && ext.frontend.styles) || [];
  const facts = [
    `ID ${ext.id}`,
    `API v${ext.apiVersion || 1}`,
    `${(ext.hooks || []).length} hooks`,
    `${extensionContributionCount(ext)} UI contributions`,
    `${scripts.length + styles.length} assets`,
    `${(ext.routes || []).length} routes`,
  ];
  return h('details', { class: 'extension-developer-details' },
    h('summary', {}, 'Developer details'),
    h('div', { class: 'extension-developer-facts' }, ...facts.map((fact) => h('span', {}, fact))),
    extensionItemList('Permissions', (ext.permissions || []).map((name) => ({ name }))),
    extensionItemList('Lifecycle hooks', ext.hooks),
    extensionItemList('Frontend assets', [...scripts, ...styles]),
    extensionItemList('Settings panels', ext.settingsPanels),
    extensionItemList('Task detail sections', ext.taskDetailSections),
    extensionItemList('Project actions', ext.projectActions),
    extensionItemList('Project fields', ext.contributes && ext.contributes.projectFields),
    extensionItemList('Project badges', ext.contributes && ext.contributes.projectBadges),
    extensionItemList('Task actions', ext.contributes && ext.contributes.taskActions),
    extensionItemList('Task badges', ext.contributes && ext.contributes.taskBadges),
    extensionItemList('Modals', ext.contributes && ext.contributes.modals),
    ext.routes && ext.routes.length ? extensionItemList('API routes', ext.routes.map((route) => ({ name: route.mount || route.path }))) : null,
  );
}

function configureExtension(ext) {
  const settingsPanel = (ext.settingsPanels || []).find((item) => item.url);
  if (settingsPanel) window.open(settingsPanel.url, '_blank', 'noopener,noreferrer');
}

function extensionCanConfigure(ext) {
  return !!(ext.settingsPanels || []).some((item) => item.url);
}

function extensionUsesProjectSettings(ext) {
  return !!(ext.contributes && ext.contributes.projectFields && ext.contributes.projectFields.length);
}

function renderExtensionsSection() {
  const summary = $('#extensionsSummary');
  const grid = $('#extensionGrid');
  const conflictList = $('#extensionConflictList');
  if (!summary || !grid || !conflictList) return;
  const extensions = EXTENSION_SETTINGS.extensions || [];
  const conflicts = EXTENSION_SETTINGS.conflicts || [];
  const lifecycleFailures = (EXTENSION_SETTINGS.lifecycleDiagnostics || []).filter((item) => item.ok === false || item.type === 'policy-conflict');
  const issueCount = conflicts.length + lifecycleFailures.length;
  summary.textContent = `${extensions.length} installed · ${issueCount ? `${issueCount} need attention` : 'All healthy'}${extensionInstallSaving ? ' · Installing...' : ''}`;
  grid.replaceChildren();
  if (extensionInstallSaving) grid.append(renderExtensionInstallingCard());
  if (!extensions.length && !extensionInstallSaving) {
    grid.append(h('div', { class: 'empty-state' }, 'No extensions installed.'));
  }
  if (extensions.length) {
    for (const ext of extensions) {
      const status = ext.enabled ? 'Enabled' : 'Needs attention';
      const capabilities = extensionCapabilities(ext);
      const extensionIssues = lifecycleFailures.filter((issue) => issue.extensionId === ext.id);
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
          extensionIssues.length ? h('div', { class: 'extension-error' }, `${extensionIssues.length} lifecycle issue${extensionIssues.length === 1 ? '' : 's'}`) : null,
          capabilities.length
            ? h('div', { class: 'extension-capabilities' },
                h('div', { class: 'extension-capabilities-title' }, 'What it does'),
                h('div', { class: 'extension-capability-list' }, ...capabilities.map((label) => h('span', {}, label))),
              )
            : h('div', { class: 'extension-capabilities-empty' }, 'No user-facing features declared.'),
          h('div', { class: 'extension-card-actions' },
            extensionCanConfigure(ext)
              ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => configureExtension(ext) }, 'Configure')
              : null,
            extensionUsesProjectSettings(ext)
              ? h('span', { class: 'extension-scope-note' }, 'Configured per project')
              : null,
          ),
          extensionDeveloperDetails(ext),
        ),
      );
    }
  }

  conflictList.replaceChildren();
  if (!conflicts.length && !lifecycleFailures.length) {
    conflictList.append(h('div', { class: 'empty-state' }, 'No extension conflicts detected.'));
  } else {
    for (const conflict of conflicts) {
      const label = conflict.id || conflict.key || conflict.type;
      conflictList.append(h('div', { class: 'extension-conflict' },
        h('strong', {}, conflict.type),
        h('span', {}, label),
      ));
    }
    for (const issue of lifecycleFailures) {
      conflictList.append(h('div', { class: 'extension-conflict' },
        h('strong', {}, issue.type === 'policy-conflict' ? 'policy-conflict' : (issue.timedOut ? 'hook-timeout' : 'hook-error')),
        h('span', {}, issue.hook || issue.extensionId || issue.error || 'lifecycle hook'),
      ));
    }
  }
}

async function loadExtensions(opts) {
  opts = opts || {};
  try {
    EXTENSION_SETTINGS = await api.get('/api/extensions');
    configureExtensionRuntimeHost();
    const runtime = extensionRuntime();
    if (runtime) await runtime.configure(EXTENSION_SETTINGS);
    cardCaches.clear();
    renderExtensionsSection();
    renderBoard();
  } catch (e) {
    const summary = $('#extensionsSummary');
    if (summary && !opts.quiet) summary.textContent = e.message;
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
  btn.classList.remove('needs-attention');
  btn.title = needsSetup ? `${active.name} needs setup before task launches` : '';
}

async function loadModelConnections() {
  try {
    MODEL_CONNECTIONS = await api.get('/api/connections/models');
    renderModelsSection();
    renderSkillsSection();
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
    if (currentSettingsSection === 'skills') loadSkills();
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
  const graphifyLegacyField = $('#projectGraphifyLegacyField');
  const graphifyLegacy = legacyOwnsUi('graphify');
  if (graphifyLegacyField) graphifyLegacyField.hidden = !graphifyLegacy;
  $('#p_graphify').checked = project ? project.graphify_enabled !== 0 : true;
  const gitLegacyField = $('#projectGitLegacyField');
  const gitLegacy = legacyOwnsUi('git');
  if (gitLegacyField) gitLegacyField.hidden = !gitLegacy;
  $('#p_git').checked = project ? !!project.git_initialized : false;
  $('#p_git').disabled = project ? !!project.git_initialized : false;
  $('#p_git').closest('.checkbox').classList.toggle('disabled', $('#p_git').disabled);
  const gitInfo = $('#projectGitInfo');
  if (gitInfo) {
    if (project && project.git_initialized) {
      gitInfo.textContent = 'Repository root: ' + (project.git_repo_root || project.path);
      gitInfo.hidden = false;
    } else if (project && project.git_repo_kind === 'parent') {
      gitInfo.textContent = project.git_warning || ('Parent repository: ' + project.git_parent_repo_root);
      gitInfo.hidden = false;
    } else {
      gitInfo.textContent = '';
      gitInfo.hidden = true;
    }
  }
  $('#projectDangerActions').hidden = !project;
  renderProjectExtensionFields(project);
  show('projectModal');
  setTimeout(() => (project ? $('#p_name') : $('#p_path')).focus(), 30);
}

function renderProjectExtensionFields(project) {
  const host = $('#projectExtensionFields');
  if (!host) return;
  host.replaceChildren();
  host.append(...renderExtensionNodes('projectFields', { project, form: $('#projectForm') }, 'project-form'));
}

$('#projectForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('#projectId').value;
  const body = {
    name: $('#p_name').value.trim(),
    path: $('#p_path').value.trim(),
    description: $('#p_description').value,
  };
  if (legacyOwnsUi('graphify')) body.graphify_enabled = $('#p_graphify').checked;
  if (legacyOwnsUi('git')) body.git_enabled = $('#p_git').checked;
  if (!body.path) return toast('Project path is required', { err: true });
  try {
    const saved = id
      ? await api.send('PATCH', `/api/projects/${id}`, body)
      : await api.send('POST', '/api/projects', body);
    try {
      await invokeExtensionContributions('projectFields', 'save', { project: saved, form: $('#projectForm'), values: body }, 'project-form');
    } catch (e) {
      toast('Project saved; extension settings failed: ' + e.message, { err: true });
    }
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

// Restore configuration without running CLI authentication/version diagnostics.
async function loadHealth() {
  try {
    const hd = await api.get('/api/bootstrap');
    currentBootId = hd.bootId || currentBootId;
    if (hd.modelConfiguration) MODEL_CONNECTIONS = hd.modelConfiguration;
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
//   • needs_attention — provider finished a turn / is idle and waiting for input
//   • done            — the task completed
// Dashboard is served from localhost / 127.0.0.1, which Chrome treats as a secure context, so the
// Notification API is available here without HTTPS.
const NOTIFY_KEY = 'dashboard.notify';
const NOTIFY_STATES = {
  needs_attention: { verb: 'Needs attention', sticky: true },
  done: { verb: 'Done', blurb: 'task complete', sticky: false },
};
const NOTIFY_ICON = new URL('/notification-icon.png', window.location.href).href;

function notificationProviderName(t) {
  const providers = MODEL_CONNECTIONS.providers || [];
  const taskProvider = t && t.provider
    ? providers.find((p) => p.id === t.provider)
    : null;
  const provider = taskProvider || providers.find((p) => p.active);
  const name = provider && String(provider.name || provider.id || '').trim();
  return name || 'The task';
}

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
      // "is waiting for you" notification can't linger after the provider resumes (or the task finished).
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
      this.show(`${notificationProviderName(t)} is waiting for you`, proj ? `${proj} — ${notificationTaskTitle(t)}` : notificationTaskTitle(t), {
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

document.addEventListener('toggle', (ev) => {
  if (ev.target && ev.target.matches && ev.target.matches('[data-project-section]')) persistUiState();
}, true);
window.addEventListener('control-center-extension-registered', () => {
  cardCaches.clear();
  renderBoard();
});
window.addEventListener('control-center-extensions-ready', () => {
  cardCaches.clear();
  renderBoard();
});
window.addEventListener('beforeunload', persistUiState);

/* ----------------------------------------------------------------- boot */

async function init() {
  showRestoreLoading('Checking server boot...');
  enhanceCustomSelect($('#projectFilter'));
  enhanceCustomSelect($('#f_model'));
  notifier.init();
  await loadHealth();
  restoreUiStateForBoot();
  restoreLoadingStep('Loading workspace...');
  const [, , initialTasks] = await Promise.all([
    loadExtensions({ quiet: true }),
    loadProjects(),
    api.get('/api/tasks'),
    archivesAreVisible() ? loadArchived() : Promise.resolve(),
  ]);
  syncArchiveToggles();
  try {
    const saved = safeJsonParse(sessionStorage.getItem(UI_STATE_KEY));
    applyCollapsedProjectSections(saved && saved.state && saved.state.collapsedProjectSections);
  } catch {
    /* storage unavailable — best-effort */
  }
  restoreLoadingStep('Loading tasks...');
  await refresh(true, initialTasks);
  setPage(currentPage);
  restoreLoadingStep('Workspace restored');
  persistUiState();
  hideRestoreLoading();
  setTimeout(() => loadMigrationWelcome(false), 420);
}

let startupComplete = false;
init().catch((e) => {
  hideRestoreLoading();
  toast('Startup failed: ' + e.message, { err: true });
  loadProjects();
  refresh(true);
}).finally(() => {
  startupComplete = true;
});
setInterval(() => {
  if (!startupComplete) return;
  if ($('#taskModal').hidden && $('#detailsModal').hidden && $('#mediaModal').hidden && $('#skillInstallModal').hidden && $('#extensionInstallModal').hidden && $('#extensionModal').hidden) refresh();
  else tabs.sync();
  if (currentPage === 'projects' && !shouldDeferBoardRender()) loadProjects();
}, 2500);
