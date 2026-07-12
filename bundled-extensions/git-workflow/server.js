'use strict';

const { spawnSync } = require('child_process');

let runtime = null;

function active(api) {
  return !!(api && api.ownership && api.ownership.isActive('git'));
}

function projectFromContext(context) {
  if (context && context.project && context.project.id) return context.project;
  if (context && context.task && context.task.project_id) return runtime.db.getProject(context.task.project_id);
  if (context && context.task && context.task.project_path) return runtime.db.getProjectByPath(context.task.project_path, true);
  return null;
}

function importState(project, values) {
  if (!runtime || !runtime.db || typeof runtime.db.setExtensionState !== 'function' || !project) return;
  runtime.db.setExtensionState(runtime.extensionId, 'project', project.id, {
    git: runtime.projectGitApiFields(project.path),
    ...(values || {}),
  });
}

async function initProject(project, api) {
  if (!active(api)) return { skipped: 'inactive_owner', activeOwner: api.ownership && api.ownership.activeOwner('git') };
  if (!project) return { ok: false, error: 'project not found' };
  const result = await api.git.init(project.path, { ownership: 'git' });
  importState(project, {
    lastInit: {
      ...result,
      at: runtime.db.now ? runtime.db.now() : new Date().toISOString(),
    },
  });
  return { ok: true, init: result, git: runtime.projectGitApiFields(project.path) };
}

exports.register = ({ express, db, paths, extension, capabilities }) => {
  const appRoot = paths && paths.APP_ROOT ? paths.APP_ROOT : process.cwd();
  const gitRoots = require(require('path').join(appRoot, 'lib', 'gitRoots'));
  runtime = {
    db,
    extensionId: extension.id,
    projectGitApiFields: gitRoots.projectGitApiFields,
  };

  capabilities.health.register('readiness', () => {
    if (!capabilities.git || !capabilities.ownership) return { ok: false, detail: 'required Git capabilities are not wired' };
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) {
      return { ok: false, detail: `Git CLI is unavailable: ${(probe.error && probe.error.message) || probe.stderr || `exit ${probe.status}`}` };
    }
    return { ok: true, detail: 'read-only Git inspection and ownership enforcement are ready' };
  });

  const router = express.Router();
  router.get('/projects/:id/status', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    res.json({ git: runtime.projectGitApiFields(project.path), owner: capabilities.ownership.activeOwner('git') });
  });
  router.post('/projects/:id/init', async (req, res) => {
    if (!active(capabilities)) return res.status(409).json({ error: 'Git Workflow extension is not the active owner' });
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    try {
      res.json(await initProject(project, capabilities));
    } catch (error) {
      res.status(400).json({ error: error && error.message ? error.message : String(error) });
    }
  });
  return router;
};

exports.hooks = {
  async 'project.updated'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    if (context && context.reason === 'git-init-requested') return initProject(projectFromContext(context), api);
    const project = projectFromContext(context);
    if (project) importState(project);
    return { ok: true };
  },

  'project.metadata'(context, api) {
    const project = projectFromContext(context);
    if (!project) return {};
    const git = runtime.projectGitApiFields(project.path);
    if (active(api)) importState(project, { lastSeenAt: runtime.db.now ? runtime.db.now() : new Date().toISOString() });
    return git;
  },

  async 'task.completed'(context, api) {
    if (!active(api)) return { skipped: 'inactive_owner' };
    const policy = context && context.gitAutoCommitPolicy;
    if (policy && policy.decision === 'deny') {
      return {
        git_commit: {
          ok: true,
          skipped: true,
          reason: policy.reason || 'disabled by extension policy',
        },
      };
    }
    if (!context || !context.task) return { git_commit: { ok: false, skipped: 'missing_task' } };
    try {
      const opts = {
        ...(context.gitCommitScope || {}),
        ownership: 'git',
      };
      const gitCommit = await api.git.commitTask(context.task, opts);
      const project = projectFromContext(context);
      if (project) {
        importState(project, {
          lastCommit: {
            taskId: context.task.id,
            result: gitCommit,
            at: runtime.db.now ? runtime.db.now() : new Date().toISOString(),
          },
        });
      }
      return { git_commit: gitCommit };
    } catch (error) {
      return { git_commit: { ok: false, error: error && error.message ? error.message : String(error) } };
    }
  },
};
