'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function realpathOrResolve(value) {
  const resolved = path.resolve(String(value || ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function gitTopLevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const rel = path.relative(realpathOrResolve(parent), realpathOrResolve(child));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function projectOwnGitPath(projectPath) {
  return path.join(path.resolve(String(projectPath || '')), '.git');
}

function hasProjectGit(projectPath) {
  return fs.existsSync(projectOwnGitPath(projectPath));
}

function parentWarning(projectPath, parentRepoRoot) {
  return `Project is inside a parent Git repository (${parentRepoRoot}) but has no .git at ${projectPath}. ` +
    'Control Center will not run project Git operations against the parent repository.';
}

function resolveProjectGit(projectPath) {
  const resolvedProjectPath = path.resolve(String(projectPath || ''));
  const ownGit = hasProjectGit(resolvedProjectPath);
  const discovered = gitTopLevel(resolvedProjectPath);
  const discoveredRoot = discovered ? path.resolve(discovered) : null;

  if (ownGit) {
    return {
      projectPath: resolvedProjectPath,
      hasOwnGit: true,
      kind: 'own',
      repoRoot: discoveredRoot || resolvedProjectPath,
      parentRepoRoot: null,
      warning: null,
    };
  }

  if (discoveredRoot && isInside(discoveredRoot, resolvedProjectPath)) {
    return {
      projectPath: resolvedProjectPath,
      hasOwnGit: false,
      kind: 'parent',
      repoRoot: null,
      parentRepoRoot: discoveredRoot,
      warning: parentWarning(resolvedProjectPath, discoveredRoot),
    };
  }

  return {
    projectPath: resolvedProjectPath,
    hasOwnGit: false,
    kind: 'none',
    repoRoot: null,
    parentRepoRoot: null,
    warning: null,
  };
}

function projectGitApiFields(projectPath) {
  const info = resolveProjectGit(projectPath);
  return {
    git_initialized: info.hasOwnGit ? 1 : 0,
    git_repo_kind: info.kind,
    git_repo_root: info.repoRoot,
    git_parent_repo_root: info.parentRepoRoot,
    git_warning: info.warning,
  };
}

module.exports = {
  gitTopLevel,
  hasProjectGit,
  projectGitApiFields,
  resolveProjectGit,
};
