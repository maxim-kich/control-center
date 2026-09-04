'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Catalog requests only: never create a thread or submit an inference prompt.
function discoverCodex(bin, { timeoutMs = 20000, cwd, env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Model discovery cancelled'));
    const child = spawn(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let done = false;
    let requestId = 1;
    let pages = 0;
    const models = [];
    const cursors = new Set();
    const timer = setTimeout(() => finish(new Error('Model discovery timed out')), timeoutMs);
    const abort = () => finish(new Error('Model discovery cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      child.kill('SIGKILL');
      if (error) reject(error); else resolve(value);
    }
    function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
    child.on('error', () => finish(new Error('Codex CLI could not be started')));
    child.stdin.on('error', () => finish(new Error('Codex discovery connection closed')));
    child.on('exit', () => finish(new Error('Codex exited before returning models')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Model response too large'));
      let end;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== requestId) continue;
        if (message.error) return finish(new Error('Codex rejected model discovery'));
        if (requestId === 1) {
          send({ method: 'initialized' });
          send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false } });
          continue;
        }
        const result = message.result;
        if (!result || !Array.isArray(result.data)) return finish(new Error('Invalid Codex model response'));
        models.push(...result.data);
        if (!result.nextCursor) return finish(null, models);
        if (++pages >= 100 || cursors.has(result.nextCursor)) return finish(new Error('Invalid model pagination'));
        cursors.add(result.nextCursor);
        send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, cursor: result.nextCursor } });
      }
    });
    send({ id: requestId, method: 'initialize', params: { clientInfo: { name: 'control_center', title: 'Control Center', version: require('../package.json').version } } });
  });
}

function discoverClaude(bin, { timeoutMs = 20000, cwd, env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Model discovery cancelled'));
    // Isolate the SDK so a stalled initialization can be terminated, including
    // its CLI subprocess. No SDK logs or account details enter the catalog.
    const child = spawn(process.execPath, [path.join(__dirname, 'claudeModelDiscovery.mjs'), bin], {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let done = false;
    const timer = setTimeout(() => finish(new Error('Model discovery timed out')), timeoutMs);
    const abort = () => finish(new Error('Model discovery cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
      if (error) reject(error); else resolve(value);
    }
    child.on('error', () => finish(new Error('Claude discovery could not be started')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) finish(new Error('Model response too large'));
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('Claude SDK could not discover models; check CLI installation and sign-in'));
      try { finish(null, JSON.parse(output)); } catch { finish(new Error('Invalid Claude model response')); }
    });
  });
}

module.exports = { discoverCodex, discoverClaude };
