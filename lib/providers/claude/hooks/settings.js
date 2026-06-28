'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('../../../core/paths');

const SOURCE_HOOKS_DIR = __dirname;
const GENERATED_DIR = path.join(paths.APP_HOME, 'generated', 'claude');
const SETTINGS_PATH = path.join(GENERATED_DIR, 'settings.json');

function shq(p) {
  return `"${String(p).replace(/(["\\$`])/g, '\\$1')}"`;
}

function buildSettings(pythonBin) {
  const hook = (name) => path.join(SOURCE_HOOKS_DIR, name);
  const cmd = (script) => `${shq(pythonBin)} ${shq(script)}`;
  const one = (script) => [{ hooks: [{ type: 'command', command: cmd(script), timeout: 10 }] }];
  return {
    hooks: {
      SessionStart: one(hook('session_start.py')),
      SessionEnd: one(hook('on_stop.py')),
      UserPromptSubmit: one(hook('activity.py')),
      Stop: one(hook('activity.py')),
      Notification: one(hook('activity.py')),
    },
  };
}

function ensureSettingsFile(pythonBin) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const desired = JSON.stringify(buildSettings(pythonBin), null, 2) + '\n';
  let current = null;
  try {
    current = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch {
    /* not present */
  }
  if (current !== desired) fs.writeFileSync(SETTINGS_PATH, desired);
  pruneGraphSettings();
  return SETTINGS_PATH;
}

function ensureGraphMcpConfig(mcpCommand, graphPath) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const hash = crypto.createHash('sha1').update(graphPath).digest('hex').slice(0, 12);
  const file = path.join(GENERATED_DIR, `mcp.graph.${hash}.json`);
  const cfg = {
    mcpServers: {
      graphify: { type: 'stdio', command: mcpCommand, args: [graphPath, '--transport', 'stdio'] },
    },
  };
  const desired = JSON.stringify(cfg, null, 2) + '\n';
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* not present */
  }
  if (current !== desired) fs.writeFileSync(file, desired);
  return file;
}

function pruneGraphSettings() {
  let names = [];
  try {
    names = fs.readdirSync(GENERATED_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^mcp\.graph\.[0-9a-f]+\.json$/.test(name)) continue;
    const full = path.join(GENERATED_DIR, name);
    try {
      const json = JSON.parse(fs.readFileSync(full, 'utf8'));
      const graphPath = json && json.mcpServers && json.mcpServers.graphify && json.mcpServers.graphify.args && json.mcpServers.graphify.args[0];
      if (!graphPath || !fs.existsSync(graphPath)) fs.unlinkSync(full);
    } catch {
      try {
        fs.unlinkSync(full);
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = {
  GENERATED_DIR,
  SETTINGS_PATH,
  SOURCE_HOOKS_DIR,
  ensureSettingsFile,
  ensureGraphMcpConfig,
};
