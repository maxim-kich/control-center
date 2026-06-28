'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_AUTHOR_NAME = 'Codex Dashboard';
const DEFAULT_AUTHOR_EMAIL = 'codex-dashboard@localhost';

function runGit(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: opts.timeout || 30000,
      env: opts.env || process.env,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const result = {
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      };
      if (err) {
        const e = new Error(String(stderr || stdout || err.message || 'git command failed').trim());
        e.result = result;
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}

async function gitOk(cwd, args) {
  try {
    const result = await runGit(cwd, args);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function sanitizeCommitSubject(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Task completed';
  return text.length > 72 ? text.slice(0, 69).trimEnd() + '...' : text;
}

function pathspecForProject(repoRoot, projectPath) {
  const realRepoRoot = fs.realpathSync.native(repoRoot);
  const realProjectPath = fs.realpathSync.native(projectPath);
  const rel = path.relative(realRepoRoot, realProjectPath);
  if (!rel || rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function pathspecForFile(repoRoot, projectPath, filePath, cwd) {
  const base = cwd || projectPath;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
  let realFilePath;
  try {
    realFilePath = fs.existsSync(absolute)
      ? fs.realpathSync.native(absolute)
      : path.normalize(absolute);
  } catch {
    realFilePath = path.normalize(absolute);
  }
  const realRepoRoot = fs.realpathSync.native(repoRoot);
  const realProjectPath = fs.realpathSync.native(projectPath);
  const relToRepo = path.relative(realRepoRoot, realFilePath);
  const relToProject = path.relative(realProjectPath, realFilePath);
  if (!relToRepo || relToRepo.startsWith('..') || path.isAbsolute(relToRepo)) return null;
  if (!relToProject || relToProject.startsWith('..') || path.isAbsolute(relToProject)) return null;
  return relToRepo;
}

function scopedPathspecs(repoRoot, projectPath, files, cwd) {
  if (!Array.isArray(files)) return null;
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const raw = typeof file === 'string' ? file : file && file.path;
    if (!raw || !String(raw).trim()) continue;
    const pathspec = pathspecForFile(repoRoot, projectPath, String(raw), cwd);
    if (!pathspec || seen.has(pathspec)) continue;
    seen.add(pathspec);
    out.push(pathspec);
  }
  return out;
}

async function commitEnv(repoRoot) {
  const [name, email] = await Promise.all([
    gitOk(repoRoot, ['config', 'user.name']),
    gitOk(repoRoot, ['config', 'user.email']),
  ]);
  const env = { ...process.env };
  if (!name) {
    env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME || DEFAULT_AUTHOR_NAME;
    env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME || DEFAULT_AUTHOR_NAME;
  }
  if (!email) {
    env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL || DEFAULT_AUTHOR_EMAIL;
    env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL || DEFAULT_AUTHOR_EMAIL;
  }
  return env;
}

async function autoCommitTaskProject(task, opts = {}) {
  const projectPath = task && task.project_path ? path.resolve(String(task.project_path)) : null;
  if (!projectPath) return { ok: false, skipped: 'missing_project_path' };

  const repoRoot = await gitOk(projectPath, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) return { ok: false, skipped: 'not_git_repo' };

  const pathspec = pathspecForProject(repoRoot, projectPath);
  if (!pathspec) return { ok: false, skipped: 'project_outside_repo', repoRoot };
  const scoped = scopedPathspecs(repoRoot, projectPath, opts.files, opts.cwd);
  if (scoped && scoped.length === 0) return { ok: false, skipped: 'no_task_files', repoRoot };
  const pathspecs = scoped || [pathspec];

  const statusBefore = await gitOk(repoRoot, ['status', '--porcelain', '--', ...pathspecs]);
  if (!statusBefore) return { ok: false, skipped: 'no_changes', repoRoot };

  await runGit(repoRoot, ['add', '-A', '--', ...pathspecs], { timeout: opts.timeout });

  try {
    await runGit(repoRoot, ['diff', '--cached', '--quiet', '--', ...pathspecs], { timeout: opts.timeout });
    return { ok: false, skipped: 'no_changes', repoRoot };
  } catch (e) {
    if (!e.result || e.result.code !== 1) throw e;
  }

  const subject = sanitizeCommitSubject(task.title);
  const message = `Task done: ${subject}`;
  const body = `Dashboard task: ${task.id || 'unknown'}`;
  await runGit(repoRoot, ['commit', '-m', message, '-m', body], {
    env: await commitEnv(repoRoot),
    timeout: opts.timeout,
  });
  const hash = await gitOk(repoRoot, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash, repoRoot, pathspecs, message };
}

module.exports = {
  autoCommitTaskProject,
  sanitizeCommitSubject,
};
