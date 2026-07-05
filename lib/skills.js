'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('./core/paths');

const PROVIDERS = new Set(['codex', 'claude']);

const RECOMMENDED_SKILLS = [
  {
    id: 'markitdown',
    name: 'MarkItDown',
    description: 'Convert Office files, PDFs, images, audio, and web content into Markdown for agent context.',
    sourceUrl: 'https://github.com/microsoft/markitdown',
    installMode: 'template',
  },
  {
    id: 'html-renderer',
    name: 'html-renderer',
    description: 'Create rendered screenshots and reliable walkthrough videos from local HTML or browser apps.',
    sourceUrl: 'https://github.com/maxim-kich/html-renderer',
    installMode: 'clone',
  },
];

function normalizeSkillProvider(providerId) {
  return PROVIDERS.has(providerId) ? providerId : 'codex';
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function providerRoots(providerId, opts = {}) {
  const provider = normalizeSkillProvider(providerId);
  if (provider === 'claude') {
    const home = paths.resolvePath(opts.claudeHome || process.env.CC_CLAUDE_HOME || process.env.CLAUDE_HOME || homePath('.claude'));
    return {
      provider,
      home,
      userDir: path.join(home, 'skills'),
      systemDir: path.join(home, 'skills', '.system'),
      pluginCacheDir: path.join(home, 'plugins', 'cache'),
    };
  }
  const home = paths.resolvePath(opts.codexHome || process.env.CODEX_HOME || homePath('.codex'));
  return {
    provider,
    home,
    userDir: path.join(home, 'skills'),
    systemDir: path.join(home, 'skills', '.system'),
    pluginCacheDir: path.join(home, 'plugins', 'cache'),
  };
}

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseFrontMatter(text) {
  const raw = String(text || '');
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end).split(/\r?\n/);
  const out = {};
  for (const line of block) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = unquote(match[2]);
  }
  return out;
}

function fallbackDescription(text) {
  const body = String(text || '').replace(/^---[\s\S]*?\n---\s*/, '').trim();
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return paragraph ? paragraph.slice(0, 240) : '';
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function skillIdFromDir(dir) {
  return path.basename(dir).trim();
}

function readSkill(skillDir, origin, opts = {}) {
  const skillPath = path.join(skillDir, 'SKILL.md');
  const text = safeRead(skillPath);
  if (text == null) return null;
  const meta = parseFrontMatter(text);
  const id = opts.id || skillIdFromDir(skillDir);
  const name = meta.name || id;
  return {
    id,
    name,
    description: meta.description || fallbackDescription(text),
    path: skillDir,
    skillPath,
    sourceUrl: meta.source || meta.sourceUrl || meta.repository || null,
    origin,
    editable: origin === 'user',
  };
}

function safeDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function directSkillDirs(root, { includeHidden = false } = {}) {
  return safeDirEntries(root)
    .filter((entry) => entry.isDirectory())
    .filter((entry) => includeHidden || !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')));
}

function walkSkillDirs(root, maxDepth = 7) {
  const out = [];
  function walk(dir, depth) {
    if (depth < 0) return;
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
      out.push(dir);
      return;
    }
    for (const entry of safeDirEntries(dir)) {
      if (!entry.isDirectory()) continue;
      walk(path.join(dir, entry.name), depth - 1);
    }
  }
  walk(root, maxDepth);
  return out;
}

function dedupeSkills(skills) {
  const seen = new Set();
  const out = [];
  for (const skill of skills) {
    if (!skill) continue;
    const key = String(skill.name || skill.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function normalizedSourceUrl(url) {
  return String(url || '').replace(/\.git$/, '').toLowerCase();
}

function skillKeys(skill) {
  const keys = new Set();
  const id = String((skill && skill.id) || '').toLowerCase();
  const name = String((skill && skill.name) || '').toLowerCase();
  const source = normalizedSourceUrl(skill && skill.sourceUrl);
  if (id) keys.add(`id:${id}`);
  if (name) keys.add(`name:${name}`);
  if (source) keys.add(`source:${source}`);
  return keys;
}

function sharesSkillKey(a, b) {
  const aKeys = skillKeys(a);
  for (const key of skillKeys(b)) {
    if (aKeys.has(key)) return true;
  }
  return false;
}

function installedRecommended(skill, installedSkills) {
  return installedSkills.find((installed) => sharesSkillKey(skill, installed)) || null;
}

function publicInstalledSkill(skill) {
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.name,
    path: skill.path,
    origin: skill.origin,
    editable: !!skill.editable,
  };
}

function listSkills(providerId, opts = {}) {
  const roots = providerRoots(providerId, opts);
  const allUserSkills = dedupeSkills(directSkillDirs(roots.userDir).map((dir) => readSkill(dir, 'user')));
  const systemSkills = directSkillDirs(roots.systemDir, { includeHidden: true }).map((dir) => readSkill(dir, 'system'));
  const pluginSkills = walkSkillDirs(roots.pluginCacheDir).map((dir) => readSkill(dir, 'provider'));
  const allProviderSkills = dedupeSkills([...systemSkills, ...pluginSkills]);
  const installed = [...allUserSkills, ...allProviderSkills];
  const recommended = RECOMMENDED_SKILLS.map((skill) => {
    const installedSkill = installedRecommended(skill, installed);
    return {
      ...skill,
      installed: !!installedSkill,
      installedPath: installedSkill ? installedSkill.path : null,
      installedSkill: publicInstalledSkill(installedSkill),
    };
  });
  const installedRecommendedSkills = recommended.filter((skill) => skill.installed);
  const userSkills = allUserSkills.filter((skill) => !installedRecommendedSkills.some((rec) => sharesSkillKey(rec, skill)));
  const providerSkills = allProviderSkills.filter((skill) => !installedRecommendedSkills.some((rec) => sharesSkillKey(rec, skill)));
  return {
    provider: roots.provider,
    roots: {
      home: roots.home,
      userDir: roots.userDir,
      systemDir: roots.systemDir,
      pluginCacheDir: roots.pluginCacheDir,
    },
    recommended,
    providerSkills,
    userSkills,
  };
}

function sanitizeSkillDirName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'skill';
}

function repoNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return sanitizeSkillDirName(parts[parts.length - 1] || 'skill');
  } catch {
    return sanitizeSkillDirName(path.basename(String(url || '')));
  }
}

function isGitHubUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

function ensureInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('target path escapes the skills directory');
  }
}

function copySkillDir(sourceDir, destinationDir) {
  if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
    throw new Error('source does not contain SKILL.md');
  }
  const tempDir = `${destinationDir}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, tempDir, {
    recursive: true,
    filter(src) {
      return !src.split(path.sep).includes('.git');
    },
  });
  fs.renameSync(tempDir, destinationDir);
}

function markitdownSkillMarkdown(sourceUrl) {
  return `---
name: markitdown
description: Convert Office files, PDFs, images, audio, and web pages into Markdown with Microsoft's MarkItDown so agents can inspect them as text.
source: ${sourceUrl}
---

# MarkItDown

Use this skill when a user needs file or web content converted into Markdown before analysis.

## Workflow

1. Check whether the \`markitdown\` command is available.
2. If it is missing and package installation is allowed, install it with \`python -m pip install 'markitdown[all]'\`.
3. Convert the requested file or URL to Markdown with \`markitdown <input>\`.
4. Save generated Markdown next to the source file or in a temporary working directory when the user only needs the extracted text.
5. Summarize the conversion result and call out files that could not be converted.

## Notes

- Prefer converting to text before asking the model to reason over binary documents.
- Do not overwrite original files.
- Keep large generated Markdown files out of source control unless the user explicitly asks to commit them.
`;
}

function installTemplateSkill(root, recommended) {
  const dir = path.join(root.userDir, sanitizeSkillDirName(recommended.id));
  ensureInside(root.userDir, dir);
  if (fs.existsSync(dir)) throw new Error(`${recommended.name} is already installed`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markitdownSkillMarkdown(recommended.sourceUrl), 'utf8');
  return readSkill(dir, 'user');
}

function cloneGitHubSkill(url) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skill-clone-'));
  const target = path.join(tmpRoot, 'repo');
  try {
    execFileSync('git', ['clone', '--depth', '1', url, target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return { tmpRoot, target };
  } catch (e) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const msg = e && e.stderr ? String(e.stderr).trim() : e.message;
    throw new Error(msg || 'git clone failed');
  }
}

function installSkill({ providerId, source, recommendedId } = {}, opts = {}) {
  const root = providerRoots(providerId, opts);
  fs.mkdirSync(root.userDir, { recursive: true });
  const trimmedSource = String(source || '').trim();
  const recommended = RECOMMENDED_SKILLS.find((skill) =>
    skill.id === recommendedId || (trimmedSource && skill.sourceUrl.toLowerCase() === trimmedSource.replace(/\.git$/, '').toLowerCase())
  );
  if (recommended && recommended.installMode === 'template') {
    return installTemplateSkill(root, recommended);
  }
  if (!trimmedSource) throw new Error('source is required');

  let sourceDir = null;
  let cleanupDir = null;
  let installName = null;
  if (isGitHubUrl(trimmedSource)) {
    const cloned = cloneGitHubSkill(trimmedSource);
    cleanupDir = cloned.tmpRoot;
    sourceDir = cloned.target;
    installName = repoNameFromUrl(trimmedSource);
  } else {
    sourceDir = paths.resolvePath(trimmedSource);
    installName = sanitizeSkillDirName(path.basename(sourceDir));
  }

  try {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error('source path does not exist or is not a directory');
    }
    const meta = readSkill(sourceDir, 'user');
    if (!meta) throw new Error('source does not contain SKILL.md');
    const dirName = sanitizeSkillDirName(meta.name || installName);
    const destination = path.join(root.userDir, dirName);
    ensureInside(root.userDir, destination);
    if (fs.existsSync(destination)) throw new Error(`${dirName} is already installed`);
    copySkillDir(sourceDir, destination);
    return readSkill(destination, 'user');
  } finally {
    if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
  }
}

function userSkillById(providerId, skillId, opts = {}) {
  const roots = providerRoots(providerId, opts);
  const userSkills = dedupeSkills(directSkillDirs(roots.userDir).map((dir) => readSkill(dir, 'user')));
  const target = String(skillId || '').trim();
  return userSkills.find((skill) => skill.id === target || skill.name === target) || null;
}

function uninstallUserSkill(providerId, skillId, opts = {}) {
  const roots = providerRoots(providerId, opts);
  const skill = userSkillById(providerId, skillId, opts);
  if (!skill) throw new Error('user skill not found');
  ensureInside(roots.userDir, skill.path);
  fs.rmSync(skill.path, { recursive: true, force: true });
  return skill;
}

module.exports = {
  RECOMMENDED_SKILLS,
  installSkill,
  listSkills,
  normalizeSkillProvider,
  parseFrontMatter,
  providerRoots,
  readSkill,
  sanitizeSkillDirName,
  uninstallUserSkill,
  userSkillById,
};
