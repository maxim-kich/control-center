'use strict';

const { spawn } = require('child_process');
const codex = require('./codex');

// Use the same inline definitions and CODEX_HOME as the task TUI. No thread is
// started by this request, and Codex remains the owner of persisted hook trust.
function listHooks({ cwd, hookArgs, env = codex.buildEnv(), bin = codex.CODEX_BIN, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', ...hookArgs], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex hook trust check timed out.')), timeoutMs);
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.on('exit', () => finish(new Error('Codex exited before reporting hook trust.')));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Codex hook response is too large.'));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) return finish(new Error(message.error.message || 'Codex cannot inspect hook trust.'));
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
        } else finish(null, message.result);
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'control_center_hook_review', version: '1' },
      capabilities: { experimentalApi: true },
    } });
  });
}

function inspectHooks(result, hookArgs) {
  const entries = result && result.data;
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0].hooks)) {
    throw new Error('Codex returned an invalid hook trust response.');
  }
  if (entries[0].errors?.length) throw new Error('Codex could not load hooks: ' + entries[0].errors.map((e) => e.message).join('; '));
  // Match the exact command, not a path prefix or an unrelated project hook.
  const commands = hookArgs.filter((arg) => arg.startsWith('hooks.')).map((arg) => {
    const match = arg.match(/command=("(?:\\.|[^"\\])*")/);
    if (!match) throw new Error('Invalid Control Center hook definition.');
    return JSON.parse(match[1]);
  });
  const hooks = commands.map((command) => entries[0].hooks.find((hook) => hook.source === 'sessionFlags' && hook.command === command));
  if (hooks.some((hook) => !hook)) throw new Error('Codex did not load all Control Center tracking hooks.');
  const pending = hooks.filter((hook) => !hook.enabled || !['trusted', 'managed'].includes(hook.trustStatus));
  return { ready: pending.length === 0, hooks: hooks.map(({ eventName, enabled, trustStatus }) => ({ eventName, enabled, trustStatus })) };
}

async function checkHookTrust(options) {
  return inspectHooks(await listHooks(options), options.hookArgs);
}

function reviewEnv() {
  const env = codex.buildEnv();
  for (const key of Object.keys(env)) if (key.startsWith('CC_')) delete env[key];
  // SessionStart normally records even an unlinked session. Review is not a task.
  env.CC_HOOK_REVIEW = '1';
  return env;
}

module.exports = { listHooks, inspectHooks, checkHookTrust, reviewEnv };
