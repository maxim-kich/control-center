'use strict';

/**
 * PTY lifecycle for interactive provider CLI sessions.
 *
 * A SessionRunner owns exactly one node-pty process and fans its output out to any number
 * of attached WebSocket clients. The PTY is NOT tied to a socket: closing the browser tab
 * detaches (the provider keeps running); reopening replays a bounded output buffer and reattaches
 * live (tmux-like). A PTY ends only when the provider exits, the user stops it, or the server shuts
 * down. See PLAN.md D7.
 */

const pty = require('node-pty');
const db = require('./db');
const { getProvider } = require('./providers');

const MAX_BUFFER_BYTES = 1.5 * 1024 * 1024; // replay buffer cap per session

class SessionRunner {
  constructor({ key, file, args, cwd, env, onExit }) {
    this.key = key;
    this.subscribers = new Set();
    this.buffer = [];
    this.bufferBytes = 0;
    this.exited = false;
    this.exitInfo = null;
    this.cancelled = false; // set on kill/dispose so background watchers can bail
    this.intentionalStop = false; // user clicked Stop (vs Codex ending naturally)
    this.cols = 80;
    this.rows = 24;
    this.startedAt = Date.now();
    this.lastDataAt = this.startedAt; // when the PTY last produced output (approx. "provider is working")
    this._onExitCb = onExit;

    this.pty = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
    });

    this._dataDisp = this.pty.onData((d) => {
      this.lastDataAt = Date.now();
      this._pushBuffer(d);
      this._broadcast({ t: 'data', d });
    });
    this._exitDisp = this.pty.onExit((e) => {
      this.exited = true;
      this.exitInfo = e;
      this._broadcast({ t: 'exit', code: e.exitCode, signal: e.signal });
      if (this._onExitCb) {
        try {
          this._onExitCb(e);
        } catch {
          /* ignore */
        }
      }
    });
  }

  _pushBuffer(d) {
    this.buffer.push(d);
    this.bufferBytes += Buffer.byteLength(d);
    while (this.bufferBytes > MAX_BUFFER_BYTES && this.buffer.length > 1) {
      this.bufferBytes -= Buffer.byteLength(this.buffer.shift());
    }
  }

  _broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(s);
    }
  }

  /** Send a one-off message to a single client (used for replay / status). */
  static _sendTo(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  attach(ws) {
    this.subscribers.add(ws);
    if (this.buffer.length) SessionRunner._sendTo(ws, { t: 'data', d: this.buffer.join('') });
    if (this.exited) SessionRunner._sendTo(ws, { t: 'exit', code: this.exitInfo && this.exitInfo.exitCode, signal: this.exitInfo && this.exitInfo.signal });
  }

  detach(ws) {
    this.subscribers.delete(ws);
  }

  write(d) {
    if (!this.exited) {
      try {
        this.pty.write(d);
      } catch {
        /* ignore writes to a dead pty */
      }
    }
  }

  resize(cols, rows) {
    if (this.exited) return;
    if (!cols || !rows || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  /** Broadcast a custom status message (e.g. a newly-captured fork session id). */
  notify(msg) {
    this._broadcast(msg);
  }

  kill(signal) {
    this.cancelled = true;
    try {
      this.pty.kill(signal);
    } catch {
      /* ignore */
    }
  }

  dispose() {
    this.cancelled = true;
    try {
      this._dataDisp.dispose();
    } catch {
      /* ignore */
    }
    try {
      this._exitDisp.dispose();
    } catch {
      /* ignore */
    }
  }
}

class SessionManager {
  constructor() {
    this.runners = new Map(); // taskId -> SessionRunner
    this.hookArgs = [];
    this.dbPath = null;
  }

  configure({ hookArgs, dbPath, yolo }) {
    this.hookArgs = hookArgs || [];
    this.dbPath = dbPath;
    this.yolo = !!yolo;
  }

  get(taskId) {
    return this.runners.get(taskId);
  }

  isLive(taskId) {
    const r = this.runners.get(taskId);
    return !!(r && !r.exited);
  }

  liveTaskIds() {
    return Array.from(this.runners.entries())
      .filter(([, runner]) => runner && !runner.exited)
      .map(([taskId]) => taskId);
  }

  /**
   * Spawn (or, if already live, return) the runner for a task.
   * opts: { task, kind: 'start'|'resume'|'fork', sessionId?, parentSessionId?, prompt? }
   */
  launch(opts) {
    const { task, kind, sessionId, parentSessionId, prompt } = opts;

    const existing = this.runners.get(task.id);
    if (existing && !existing.exited) return existing;
    if (existing) {
      existing.dispose();
      this.runners.delete(task.id);
    }

    const provider = getProvider(task.provider || 'codex');
    const launch = provider.buildLaunch({
      task,
      kind,
      sessionId,
      parentSessionId,
      prompt,
      context: {
        db,
        dbPath: this.dbPath,
        hookArgs: this.hookArgs,
        yolo: this.yolo,
      },
    });

    const runner = new SessionRunner({
      key: task.id,
      file: launch.file,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      onExit: () => this._onRunnerExit(task.id),
    });
    this.runners.set(task.id, runner);

    provider.onLaunch({
      task,
      kind,
      sessionId: launch.sessionId || sessionId,
      parentSessionId,
      prompt,
      launch,
      runner,
      db,
    });

    return runner;
  }

  _onRunnerExit(taskId) {
    const r = this.runners.get(taskId);
    const task = db.getTask(taskId);
    if (task) {
      // A session ending is NOT the same as the task being done — closing the tab, /exit, or a
      // server restart all land here. Per product decision only the explicit Done button
      // completes a task, so we never change task.status; the card simply falls back to
      // "needs attention" (in_progress, not live) and stays resumable. Clear activity/wake state
      // and stamp the session end for bookkeeping.
      if (task.status === 'in_progress') db.updateTask(taskId, { activity: null, wake_at: null });
      if (task.session_id) db.endSession(task.session_id);
    }
    // Drop the runner once nobody is watching it.
    if (r && r.subscribers.size === 0) {
      r.dispose();
      this.runners.delete(taskId);
    }
  }

  attach(taskId, ws) {
    const r = this.runners.get(taskId);
    if (r) r.attach(ws);
    return r;
  }

  detach(taskId, ws) {
    const r = this.runners.get(taskId);
    if (!r) return;
    r.detach(ws);
    // Clean up an exited runner that no one is watching anymore.
    if (r.exited && r.subscribers.size === 0) {
      r.dispose();
      this.runners.delete(taskId);
    }
  }

  stop(taskId) {
    const r = this.runners.get(taskId);
    if (r) {
      r.intentionalStop = true;
      r.kill();
    }
  }

  shutdown() {
    for (const r of this.runners.values()) {
      r.kill();
      r.dispose();
    }
    this.runners.clear();
  }
}

module.exports = { SessionRunner, SessionManager };
