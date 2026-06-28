'use strict';

/**
 * Build Codex hook overrides for a single launch.
 *
 * Hooks live under `.codex-dashboard/`, which Codex does not auto-discover.
 * The server passes them inline with `-c hooks...`; lib/codex adds
 * `--dangerously-bypass-hook-trust` only when the selected CLI supports it.
 * No user or project Codex config is modified.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, '.codex-dashboard', 'hooks');
const TASK_EVENT_HOOK = path.join(HOOKS_DIR, 'task_event.js');

function shq(p) {
  return `"${String(p).replace(/(["\\$`])/g, '\\$1')}"`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function hookValue(command) {
  return `[{hooks=[{type="command",command=${tomlString(command)},timeout=10}]}]`;
}

function buildHookArgs(nodeBin = process.execPath) {
  const commandFor = (event) => `${shq(nodeBin)} ${shq(TASK_EVENT_HOOK)} ${event}`;
  const entries = [
    ['SessionStart', commandFor('SessionStart')],
    ['UserPromptSubmit', commandFor('UserPromptSubmit')],
    ['Stop', commandFor('Stop')],
    ['PermissionRequest', commandFor('PermissionRequest')],
  ];
  return entries.flatMap(([event, command]) => ['-c', `hooks.${event}=${hookValue(command)}`]);
}

module.exports = { buildHookArgs, HOOKS_DIR, TASK_EVENT_HOOK };
