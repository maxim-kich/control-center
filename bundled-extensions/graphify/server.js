'use strict';

const { spawnSync } = require('child_process');

let runtime = null;

const GRAPHIFY_KEYS = [
  'graphify_enabled',
  'graphify_status',
  'graphify_last_started_at',
  'graphify_last_finished_at',
  'graphify_last_success_at',
  'graphify_last_error',
  'graphify_hook_status',
  'graphify_dirty_at',
];

function active(api) {
  return !!(api && api.ownership && api.ownership.isActive('graphify'));
}

function projectSnapshot(project) {
  const out = {};
  for (const key of GRAPHIFY_KEYS) out[key] = project ? project[key] : null;
  return out;
}

function importProjectState(projects) {
  if (!runtime || !runtime.db || typeof runtime.db.setExtensionState !== 'function') return;
  const now = runtime.db.now ? runtime.db.now() : new Date().toISOString();
  for (const project of projects || []) {
    runtime.db.setExtensionState(runtime.extensionId, 'project', project.id, {
      importedFrom: 'legacy-project-columns',
      importedAt: now,
      compatibility: projectSnapshot(project),
      artifacts: runtime.graphifyProjectInfo(project.path),
    });
  }
}

function runProcess(api) {
  return (command, args, opts = {}) => api.processes.run(
    opts.name || 'graphify',
    command,
    args,
    {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      ownership: 'graphify',
    },
  );
}

function setupProvider(api) {
  return (providerId, project, opts = {}) => api.providers.setup(providerId, project, {
    ...opts,
    integration: 'graphify',
    ownership: 'graphify',
  });
}

function cleanupProvider(api) {
  return (providerId, project, opts = {}) => api.providers.setup(providerId, project, {
    ...opts,
    action: 'cleanup',
    integration: 'graphify',
    ownership: 'graphify',
  });
}

function ensureManager(api) {
  if (!runtime) throw new Error('Graphify extension runtime is not registered');
  api.ownership.assert('graphify');
  if (!runtime.manager || runtime.manager.shuttingDown) {
    runtime.manager = new runtime.GraphifyManager(runtime.db, {
      runProcess: runProcess(api),
      providerSetup: setupProvider(api),
      providerCleanup: cleanupProvider(api),
    });
  }
  return runtime.manager;
}

function syncProjects(api, opts = {}) {
  if (!active(api)) return { skipped: 'inactive_owner', activeOwner: api.ownership && api.ownership.activeOwner('graphify') };
  const projects = runtime.db.listProjects();
  importProjectState(projects);
  ensureManager(api).syncProjects(projects, opts);
  return { ok: true, projects: projects.length };
}

function publicProject(project) {
  if (!project) return null;
  return {
    ...project,
    ...runtime.graphifyProjectInfo(project.path),
  };
}

function projectFromContext(context) {
  if (context && context.project && context.project.id) return context.project;
  if (context && context.task && context.task.project_id) return runtime.db.getProject(context.task.project_id);
  if (context && context.task && context.task.project_path) return runtime.db.getProjectByPath(context.task.project_path, true);
  return null;
}

async function handleProjectChanged(context, api) {
  if (!active(api)) return { skipped: 'inactive_owner' };
  const project = projectFromContext(context);
  if (!project) return { skipped: 'project_missing' };
  const previous = context && context.previous;
  const reason = context && context.reason;
  const manager = ensureManager(api);
  syncProjects(api, { bootstrap: false });
  importProjectState([project]);

  if (reason === 'graphify-manual') {
    manager.enqueue(project.id, 'manual', { immediate: true });
  } else if (reason === 'graphify-disabled') {
    manager.disableProject(project.id, { uninstall: true });
  } else if (previous) {
    const wasEnabled = previous.graphify_enabled !== 0 && previous.archived !== 1;
    const isEnabled = project.graphify_enabled !== 0 && project.archived !== 1;
    const pathChanged = previous.path !== project.path;
    if (!wasEnabled && isEnabled) manager.enqueue(project.id, 'project-enabled', { immediate: true });
    else if (wasEnabled && !isEnabled) manager.disableProject(project.id, { uninstall: true });
    else if (isEnabled && pathChanged) manager.enqueue(project.id, 'project-updated', { immediate: true });
  }
  return { ok: true };
}

exports.register = ({ express, db, paths, extension, capabilities }) => {
  const appRoot = paths && paths.APP_ROOT ? paths.APP_ROOT : process.cwd();
  const graphify = require(require('path').join(appRoot, 'lib', 'graphify'));
  runtime = {
    db,
    extensionId: extension.id,
    GraphifyManager: graphify.GraphifyManager,
    graphifyProjectInfo: graphify.graphifyProjectInfo,
    manager: null,
  };

  capabilities.health.register('readiness', () => {
    if (!capabilities.processes || !capabilities.providers || !capabilities.ownership) {
      return { ok: false, detail: 'required Graphify capabilities are not wired' };
    }
    const manager = new runtime.GraphifyManager(runtime.db, {
      runProcess: runProcess(capabilities),
      providerSetup: setupProvider(capabilities),
      providerCleanup: cleanupProvider(capabilities),
      watch: false,
      bootstrap: false,
    });
    const probe = spawnSync(manager.bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    manager.shutdown();
    if (probe.error || probe.status !== 0) {
      return { ok: false, detail: `Graphify CLI is unavailable: ${(probe.error && probe.error.message) || probe.stderr || `exit ${probe.status}`}` };
    }
    return { ok: true, detail: 'capabilities, manager, providers, and CLI are ready' };
  });

  const router = express.Router();

  router.get('/projects/:id/status', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    res.json({ project: publicProject(project), owner: capabilities.ownership.activeOwner('graphify') });
  });

  router.post('/projects/:id/queue', (req, res) => {
    if (!active(capabilities)) return res.status(409).json({ error: 'Graphify extension is not the active owner' });
    const existing = db.getProject(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const project = existing.graphify_enabled !== 0 ? existing : db.updateProject(existing.id, { graphify_enabled: 1 });
    syncProjects(capabilities, { bootstrap: false });
    ensureManager(capabilities).enqueue(project.id, 'manual', { immediate: true });
    importProjectState([db.getProject(project.id)]);
    res.json({ project: publicProject(db.getProject(project.id)) });
  });

  router.delete('/projects/:id', (req, res) => {
    if (!active(capabilities)) return res.status(409).json({ error: 'Graphify extension is not the active owner' });
    const existing = db.getProject(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const project = existing.graphify_enabled === 0 ? existing : db.updateProject(existing.id, { graphify_enabled: 0 });
    ensureManager(capabilities).disableProject(project.id, { uninstall: true });
    syncProjects(capabilities, { bootstrap: false });
    importProjectState([db.getProject(project.id)]);
    res.json({ project: publicProject(db.getProject(project.id)) });
  });

  return router;
};

exports.hooks = {
  'app.started'(_context, api) {
    return syncProjects(api);
  },

  'app.stopping'() {
    if (runtime && runtime.manager) runtime.manager.shutdown();
    return { ok: true };
  },

  'project.created'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    const project = projectFromContext(context);
    syncProjects(api, { bootstrap: false });
    if (project && project.graphify_enabled !== 0) ensureManager(api).enqueue(project.id, 'project-created', { immediate: true });
    if (project) importProjectState([project]);
    return { ok: true };
  },

  'project.updated': handleProjectChanged,

  'project.archived'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    const project = projectFromContext(context);
    if (project) ensureManager(api).disableProject(project.id, { uninstall: true });
    syncProjects(api, { bootstrap: false });
    return { ok: true };
  },

  'project.unarchived'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    const project = projectFromContext(context);
    syncProjects(api, { bootstrap: false });
    if (project && project.graphify_enabled !== 0) ensureManager(api).enqueue(project.id, 'project-updated', { immediate: true });
    return { ok: true };
  },

  'project.deleted'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    const project = projectFromContext(context);
    if (project) ensureManager(api).disableProject(project.id, { uninstall: true });
    syncProjects(api, { bootstrap: false });
    return { ok: true };
  },

  'project.metadata'(context, api) {
    if (!active(api)) return { owner: api.ownership && api.ownership.activeOwner('graphify') };
    const project = projectFromContext(context);
    return project ? runtime.graphifyProjectInfo(project.path) : {};
  },

  'task.completed'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    const projectPath = context && context.task && context.task.project_path;
    if (projectPath) ensureManager(api).enqueueByPath(projectPath, 'task-completed', { immediate: true });
    return { ok: true };
  },
};
