'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skills = require('../lib/skills');

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(dir, { name, description, source } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name || path.basename(dir)}
description: ${description || 'Test skill description.'}
${source ? `source: ${source}\n` : ''}---

# ${name || path.basename(dir)}
`, 'utf8');
}

test('listSkills separates user and provider skills and marks recommended installs', () => {
  const home = tmpHome('cc-skills-list-');
  writeSkill(path.join(home, 'skills', 'html-renderer'), {
    name: 'html-renderer',
    description: 'Render HTML.',
    source: 'https://github.com/maxim-kich/html-renderer',
  });
  writeSkill(path.join(home, 'skills', 'custom-user'), {
    name: 'custom-user',
    description: 'Custom user skill.',
  });
  writeSkill(path.join(home, 'skills', '.system', 'skill-creator'), {
    name: 'skill-creator',
    description: 'Create skills.',
  });

  const payload = skills.listSkills('codex', { codexHome: home });
  assert.equal(payload.provider, 'codex');
  assert.deepEqual(payload.userSkills.map((skill) => skill.id), ['custom-user']);
  assert.deepEqual(payload.providerSkills.map((skill) => skill.id), ['skill-creator']);
  const htmlRenderer = payload.recommended.find((skill) => skill.id === 'html-renderer');
  assert.equal(htmlRenderer.installed, true);
  assert.equal(htmlRenderer.installedSkill.id, 'html-renderer');
  assert.equal(htmlRenderer.installedSkill.origin, 'user');
  assert.equal(htmlRenderer.installedSkill.editable, true);
  assert.equal(payload.recommended.find((skill) => skill.id === 'markitdown').installed, false);

  fs.rmSync(home, { recursive: true, force: true });
});

test('installSkill copies a local skill folder into the provider user skills root', () => {
  const home = tmpHome('cc-skills-install-home-');
  const sourceRoot = tmpHome('cc-skills-install-source-');
  writeSkill(sourceRoot, { name: 'local-copy', description: 'Copied skill.' });

  const installed = skills.installSkill({ providerId: 'codex', source: sourceRoot }, { codexHome: home });
  assert.equal(installed.id, 'local-copy');
  assert.equal(installed.name, 'local-copy');
  assert.ok(fs.existsSync(path.join(home, 'skills', 'local-copy', 'SKILL.md')));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

test('installSkill creates the MarkItDown recommended skill template', () => {
  const home = tmpHome('cc-skills-markitdown-');

  const installed = skills.installSkill({ providerId: 'codex', recommendedId: 'markitdown' }, { codexHome: home });
  const skillPath = path.join(home, 'skills', 'markitdown', 'SKILL.md');
  assert.equal(installed.id, 'markitdown');
  assert.ok(fs.existsSync(skillPath));
  assert.match(fs.readFileSync(skillPath, 'utf8'), /python -m pip install 'markitdown\[all\]'/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('uninstallUserSkill removes only user-owned skill folders', () => {
  const home = tmpHome('cc-skills-uninstall-');
  writeSkill(path.join(home, 'skills', 'remove-me'), {
    name: 'remove-me',
    description: 'Temporary skill.',
  });
  writeSkill(path.join(home, 'skills', '.system', 'keep-me'), {
    name: 'keep-me',
    description: 'System skill.',
  });

  const removed = skills.uninstallUserSkill('codex', 'remove-me', { codexHome: home });
  assert.equal(removed.id, 'remove-me');
  assert.equal(fs.existsSync(path.join(home, 'skills', 'remove-me')), false);
  assert.ok(fs.existsSync(path.join(home, 'skills', '.system', 'keep-me', 'SKILL.md')));
  assert.throws(() => skills.uninstallUserSkill('codex', 'keep-me', { codexHome: home }), /user skill not found/);

  fs.rmSync(home, { recursive: true, force: true });
});
