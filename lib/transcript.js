'use strict';

/**
 * Parse a Codex rollout JSONL file into the render-ready model used by the
 * dashboard details panel. Purely local file reading; no Codex process or
 * network access is involved.
 */

const fs = require('fs');
const codex = require('./codex');

const MAX_BYTES = Number(process.env.CC_TRANSCRIPT_MAX_BYTES) || 64 * 1024 * 1024;

function safeJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(stringifyContent).join('');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.output_text === 'string') return content.output_text;
    if (content.type === 'image') return '[image]';
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return String(content);
}

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyContent(content);
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return stringifyContent(b);
      if (typeof b.text === 'string') return b.text;
      if (typeof b.output_text === 'string') return b.output_text;
      if (typeof b.input_text === 'string') return b.input_text;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function summarizeTool(name, input) {
  input = input || {};
  const args = input.arguments && typeof input.arguments === 'object' ? input.arguments : input;
  if (name === 'exec_command' || name === 'shell' || name === 'bash' || name === 'Bash') return args.cmd || args.command || '';
  if (name === 'apply_patch') return 'apply_patch';
  if (name === 'view_image') return args.path || '';
  if (name === 'read_mcp_resource') return args.uri || '';
  return args.description || args.query || args.path || args.file_path || '';
}

function addFile(filesTouched, filePath, op) {
  if (!filePath) return;
  let rec = filesTouched.get(filePath);
  if (!rec) {
    rec = { path: filePath, ops: new Set() };
    filesTouched.set(filePath, rec);
  }
  rec.ops.add(op);
}

function extractPatchFiles(text, filesTouched) {
  if (!text) return;
  for (const line of String(text).split('\n')) {
    let m = /^\*\*\* (?:Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      addFile(filesTouched, m[1].trim(), 'write');
      continue;
    }
    m = /^\*\*\* Add File: (.+)$/.exec(line);
    if (m) addFile(filesTouched, m[1].trim(), 'write');
  }
}

function extractCommandAndFiles(name, input, filesTouched, commands) {
  input = input || {};
  const args = input.arguments && typeof input.arguments === 'object' ? input.arguments : input;
  if (typeof input.arguments === 'string') Object.assign(args, safeJson(input.arguments) || {});

  if (name === 'exec_command' || name === 'shell' || name === 'bash' || name === 'Bash') {
    const command = args.cmd || args.command;
    if (typeof command === 'string') commands.push({ command, description: args.justification || args.description || '' });
  }
  if (name === 'apply_patch') extractPatchFiles(args.input || args.patch || input.input || input.arguments || '', filesTouched);
  if (name === 'view_image' && args.path) addFile(filesTouched, args.path, 'read');
}

function mapPlanStatus(status) {
  if (status === 'completed' || status === 'complete') return 'completed';
  if (status === 'in_progress' || status === 'working') return 'in_progress';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'pending';
}

function makeEvent({ role, type, timestamp, blocks, phase }) {
  return {
    role,
    type,
    uuid: null,
    parentUuid: null,
    timestamp,
    isSidechain: false,
    phase: phase || null,
    toolResultOnly: false,
    blocks,
  };
}

function parseTokenInfo(payload) {
  const info = payload && payload.info;
  if (!info) return null;
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  return {
    tokensInput: Number(total.input_tokens || 0),
    tokensOutput: Number(total.output_tokens || 0),
    totalTokens: Number(total.total_tokens || 0),
    reasoningTokens: Number(total.reasoning_output_tokens || 0),
    contextTokens: Number(last.total_tokens || total.total_tokens || 0),
    modelContextWindow: Number(info.model_context_window || 0),
  };
}

function parseTranscript(filePath) {
  const meta = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    version: null,
    title: null,
    summary: null,
    startedAt: null,
    endedAt: null,
    model: null,
    effort: null,
  };
  const events = [];
  const filesTouched = new Map();
  const commands = [];
  const toolUseIndex = new Map();
  const planItems = new Map();
  const seenMessages = new Set();

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let contextTokens = 0;
  let modelContextWindow = 0;

  const { size } = fs.statSync(filePath);
  if (size > MAX_BYTES) {
    const e = new Error(`transcript too large (${size} bytes > ${MAX_BYTES})`);
    e.code = 'TRANSCRIPT_TOO_LARGE';
    throw e;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = o.timestamp || null;
    if (ts) {
      if (!meta.startedAt) meta.startedAt = ts;
      meta.endedAt = ts;
    }
    const p = o.payload || {};

    if (o.type === 'session_meta') {
      meta.sessionId = p.id || meta.sessionId;
      meta.cwd = p.cwd || meta.cwd;
      meta.version = p.cli_version || meta.version;
      meta.gitBranch = p.git && p.git.branch ? p.git.branch : meta.gitBranch;
      meta.startedAt = p.timestamp || meta.startedAt;
      continue;
    }

    if (o.type === 'turn_context') {
      meta.cwd = p.cwd || meta.cwd;
      meta.model = p.model || meta.model;
      meta.effort = p.reasoning_effort || (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort) || meta.effort;
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'task_started') {
      if (p.model_context_window) modelContextWindow = Number(p.model_context_window);
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'token_count') {
      const counts = parseTokenInfo(p);
      if (counts) {
        tokensInput = counts.tokensInput;
        tokensOutput = counts.tokensOutput;
        totalTokens = counts.totalTokens;
        reasoningTokens = counts.reasoningTokens;
        contextTokens = counts.contextTokens;
        modelContextWindow = counts.modelContextWindow;
      }
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'user_message') {
      const text = p.message || '';
      if (!text) continue;
      const key = `user:${ts}:${text}`;
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      userMessages += 1;
      events.push(makeEvent({ role: 'user', type: 'user_message', timestamp: ts, blocks: [{ kind: 'text', text }] }));
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'agent_message') {
      const text = p.message || '';
      if (!text) continue;
      const key = `assistant:${ts}:${text}`;
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      assistantMessages += 1;
      events.push(makeEvent({ role: 'assistant', type: 'agent_message', timestamp: ts, phase: p.phase, blocks: [{ kind: 'text', text }] }));
      continue;
    }

    if (o.type === 'response_item' && p.type === 'message') {
      const role = p.role || 'assistant';
      if (role !== 'user' && role !== 'assistant') continue;
      const text = textFromMessageContent(p.content);
      if (!text) continue;
      const key = `${role}:${ts}:${text}`;
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      if (role === 'user') userMessages += 1;
      else assistantMessages += 1;
      events.push(makeEvent({ role, type: 'message', timestamp: ts, phase: p.phase, blocks: [{ kind: 'text', text }] }));
      continue;
    }

    if (o.type === 'response_item' && p.type === 'reasoning') {
      const text = Array.isArray(p.summary) ? p.summary.map((s) => s.text || s.summary || '').filter(Boolean).join('\n') : '';
      if (text) events.push(makeEvent({ role: 'assistant', type: 'reasoning', timestamp: ts, blocks: [{ kind: 'thinking', text }] }));
      continue;
    }

    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const name = p.name || 'tool';
      let input = {};
      if (p.type === 'function_call') input = safeJson(p.arguments) || { arguments: p.arguments };
      else input = { input: p.input };
      toolCalls += 1;
      extractCommandAndFiles(name, input, filesTouched, commands);
      if (name === 'update_plan') {
        const args = safeJson(p.arguments) || input;
        const items = Array.isArray(args.plan) ? args.plan : [];
        items.forEach((item, idx) => {
          planItems.set(String(idx + 1), {
            id: String(idx + 1),
            subject: item.step || '(untitled)',
            description: args.explanation || '',
            activeForm: '',
            status: mapPlanStatus(item.status),
          });
        });
      }
      const block = {
        kind: 'tool_use',
        id: p.call_id,
        name,
        input,
        summary: summarizeTool(name, input),
        result: null,
      };
      if (p.call_id) toolUseIndex.set(p.call_id, block);
      events.push(makeEvent({ role: 'assistant', type: p.type, timestamp: ts, blocks: [block] }));
      continue;
    }

    if (o.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const block = {
        kind: 'tool_result',
        id: p.call_id,
        isError: /error/i.test(String(p.status || '')),
        text: stringifyContent(p.output),
      };
      events.push(makeEvent({ role: 'tool', type: p.type, timestamp: ts, blocks: [block], phase: null }));
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'patch_apply_end') {
      if (p.changes && typeof p.changes === 'object') {
        for (const [file, change] of Object.entries(p.changes)) addFile(filesTouched, (change && change.move_path) || file, 'write');
      }
      const block = {
        kind: 'tool_result',
        id: p.call_id,
        isError: p.success === false,
        text: [p.stdout, p.stderr].filter(Boolean).join('\n'),
      };
      events.push(makeEvent({ role: 'tool', type: 'patch_apply_end', timestamp: ts, blocks: [block] }));
    }
  }

  for (const ev of events) {
    ev.blocks = ev.blocks.filter((blk) => {
      if (blk.kind !== 'tool_result') return true;
      const owner = toolUseIndex.get(blk.id);
      if (owner) {
        owner.result = { isError: blk.isError, text: blk.text };
        return false;
      }
      return true;
    });
  }

  const agents = codex.getSpawnedAgents(meta.sessionId).map((a, i) => ({
    index: i + 1,
    id: a.id,
    type: 'codex',
    model: a.model || null,
    task: a.title || a.id,
    prompt: '',
    status: a.status || 'unknown',
    rolloutPath: a.rollout_path || null,
  }));

  return {
    meta,
    events: events.filter((ev) => ev.blocks.length > 0),
    subtasks: [...planItems.values()],
    agents,
    filesTouched: [...filesTouched.values()].map((r) => ({ path: r.path, ops: [...r.ops] })),
    commands,
    counts: {
      userMessages,
      assistantMessages,
      toolCalls,
      tokensInput,
      tokensOutput,
      totalTokens,
      reasoningTokens,
      contextTokens,
      modelContextWindow,
    },
  };
}

function streamCounts(filePath) {
  let tokensInput = 0;
  let tokensOutput = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let contextTokens = 0;
  let modelContextWindow = 0;
  const { size } = fs.statSync(filePath);
  if (size > MAX_BYTES) return { tokensInput, tokensOutput, totalTokens, reasoningTokens, contextTokens, modelContextWindow, tooLarge: true };
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line || (line.indexOf('"token_count"') === -1 && line.indexOf('"task_started"') === -1)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'event_msg' || !o.payload) continue;
    if (o.payload.type === 'task_started' && o.payload.model_context_window) {
      modelContextWindow = Number(o.payload.model_context_window);
      continue;
    }
    if (o.payload.type !== 'token_count') continue;
    const c = parseTokenInfo(o.payload);
    if (!c) continue;
    tokensInput = c.tokensInput;
    tokensOutput = c.tokensOutput;
    totalTokens = c.totalTokens;
    reasoningTokens = c.reasoningTokens;
    contextTokens = c.contextTokens;
    modelContextWindow = c.modelContextWindow;
  }
  return { tokensInput, tokensOutput, totalTokens, reasoningTokens, contextTokens, modelContextWindow };
}

module.exports = { parseTranscript, streamCounts };
