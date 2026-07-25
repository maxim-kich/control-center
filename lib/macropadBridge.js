'use strict';

const DEFAULT_FOCUS_TTL_MS = 5000;
const DEFAULT_OUTPUT_CHARS = 32768;
const MAX_INPUT_BYTES = 1024;

function processSummary(task) {
  const provider = task.provider === 'claude' ? 'claude' : 'codex';
  if (provider === 'claude') {
    const permissionMode = task.yolo ? 'bypassPermissions' : task.mode === 'plan' ? 'plan' : 'default';
    return `claude --permission-mode ${permissionMode} --effort ${task.effort || 'medium'}`;
  }
  const yolo = task.yolo ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  return `codex${yolo} -c model_reasoning_effort="${task.effort || 'medium'}"`;
}

class MacroPadBridge {
  constructor({ manager, getTask, now = () => Date.now(), focusTtlMs = DEFAULT_FOCUS_TTL_MS }) {
    this.manager = manager;
    this.getTask = getTask;
    this.now = now;
    this.focusTtlMs = focusTtlMs;
    this.focusedTaskId = null;
    this.focusedAt = 0;
  }

  setFocus(taskId, active) {
    if (!active) {
      if (!taskId || taskId === this.focusedTaskId) {
        this.focusedTaskId = null;
        this.focusedAt = 0;
      }
      return null;
    }
    if (typeof taskId !== 'string' || !taskId || !this.manager.isLive(taskId) || !this.getTask(taskId)) {
      return null;
    }
    this.focusedTaskId = taskId;
    this.focusedAt = this.now();
    return this.currentSession();
  }

  _focused() {
    if (!this.focusedTaskId || this.now() - this.focusedAt > this.focusTtlMs) return null;
    const task = this.getTask(this.focusedTaskId);
    const runner = this.manager.get(this.focusedTaskId);
    if (!task || !runner || runner.exited) return null;
    return { task, runner };
  }

  currentSession() {
    const focused = this._focused();
    if (!focused) return null;
    const { task, runner } = focused;
    return {
      id: `control-center:${task.id}`,
      source: 'control-center',
      taskId: task.id,
      provider: task.provider === 'claude' ? 'claude-code' : 'codex',
      tty: `control-center:${task.id}`,
      processes: processSummary(task),
      contents: typeof runner.outputSnapshot === 'function' ? runner.outputSnapshot(DEFAULT_OUTPUT_CHARS) : '',
      effort: task.effort || null,
      yolo: !!task.yolo,
    };
  }

  write(taskId, data) {
    if (typeof taskId !== 'string' || taskId !== this.focusedTaskId) return false;
    if (typeof data !== 'string' || !data || Buffer.byteLength(data) > MAX_INPUT_BYTES) return false;
    const focused = this._focused();
    if (!focused) return false;
    focused.runner.write(data);
    return true;
  }
}

module.exports = {
  DEFAULT_FOCUS_TTL_MS,
  MAX_INPUT_BYTES,
  MacroPadBridge,
  processSummary,
};
