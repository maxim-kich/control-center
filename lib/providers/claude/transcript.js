'use strict';

const fs = require('fs');

const MAX_BYTES = Number(process.env.CC_TRANSCRIPT_MAX_BYTES) || 64 * 1024 * 1024;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

function stringifyResultContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        if (typeof b.text === 'string') return b.text;
        if (b.type === 'image') return '[image]';
        try {
          return JSON.stringify(b);
        } catch {
          return '';
        }
      }
      return '';
    }).join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function summarizeTool(name, input) {
  input = input || {};
  switch (name) {
    case 'Bash':
      return input.command || '';
    case 'Read':
    case 'NotebookRead':
      return input.file_path || input.notebook_path || '';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Update':
      return input.file_path || input.notebook_path || '';
    case 'Glob':
    case 'Grep':
      return input.pattern || '';
    case 'Task':
    case 'Agent':
      return input.description || input.subagent_type || '';
    case 'WebFetch':
      return input.url || '';
    case 'WebSearch':
      return input.query || '';
    default:
      return '';
  }
}

function recordTool(name, input, filesTouched, commands) {
  input = input || {};
  if (name === 'Bash' && typeof input.command === 'string') {
    commands.push({ command: input.command, description: input.description || '' });
    return;
  }
  const op = WRITE_TOOLS.has(name) ? 'write' : READ_TOOLS.has(name) ? 'read' : null;
  if (!op) return;
  const filePath = input.file_path || input.notebook_path;
  if (!filePath) return;
  let rec = filesTouched.get(filePath);
  if (!rec) {
    rec = { path: filePath, ops: new Set() };
    filesTouched.set(filePath, rec);
  }
  rec.ops.add(op);
}

function parseAgentUsage(text) {
  if (!text) return {};
  const m = /<usage>([\s\S]*?)<\/usage>/.exec(text);
  const body = m ? m[1] : text;
  const num = (re) => {
    const r = re.exec(body);
    return r ? Number(r[1]) : null;
  };
  return {
    totalTokens: num(/total_tokens:\s*(\d+)/),
    toolUses: num(/tool_uses:\s*(\d+)/),
    durationMs: num(/duration_ms:\s*(\d+)/),
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
  const taskCreates = [];
  const taskUpdates = [];
  const agentCalls = [];
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let contextTokens = 0;

  const { size } = fs.statSync(filePath);
  if (size > MAX_BYTES) {
    const e = new Error(`transcript too large (${size} bytes > ${MAX_BYTES})`);
    e.code = 'TRANSCRIPT_TOO_LARGE';
    throw e;
  }

  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.sessionId && !meta.sessionId) meta.sessionId = o.sessionId;
    if (o.cwd) meta.cwd = o.cwd;
    if (o.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.version) meta.version = o.version;
    if (o.timestamp) {
      if (!meta.startedAt) meta.startedAt = o.timestamp;
      meta.endedAt = o.timestamp;
    }
    if (o.type === 'summary' && o.summary) meta.summary = o.summary;
    if (o.type === 'ai-title' && o.aiTitle) meta.title = o.aiTitle;
    if (o.type !== 'user' && o.type !== 'assistant') continue;

    const msg = o.message;
    if (!msg) continue;
    const role = msg.role || o.type;
    const content = msg.content;
    const blocks = [];
    let hasNonToolResult = false;

    if (typeof content === 'string') {
      blocks.push({ kind: 'text', text: content });
      hasNonToolResult = true;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          blocks.push({ kind: 'text', text: b.text || '' });
          hasNonToolResult = true;
        } else if (b.type === 'thinking') {
          blocks.push({ kind: 'thinking', text: b.thinking || b.text || '' });
          hasNonToolResult = true;
        } else if (b.type === 'tool_use') {
          toolCalls += 1;
          recordTool(b.name, b.input, filesTouched, commands);
          const block = {
            kind: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input,
            summary: summarizeTool(b.name, b.input),
            result: null,
          };
          blocks.push(block);
          if (b.id) toolUseIndex.set(b.id, block);
          if (b.name === 'TaskCreate') taskCreates.push(block);
          else if (b.name === 'TaskUpdate') taskUpdates.push(b.input || {});
          else if (b.name === 'Agent' || b.name === 'Task') agentCalls.push(block);
          hasNonToolResult = true;
        } else if (b.type === 'tool_result') {
          blocks.push({
            kind: 'tool_result',
            id: b.tool_use_id,
            isError: !!b.is_error,
            text: stringifyResultContent(b.content),
          });
        } else if (b.type === 'image') {
          blocks.push({ kind: 'image' });
          hasNonToolResult = true;
        }
      }
    }
    if (!blocks.length) continue;

    if (role === 'user' && hasNonToolResult) userMessages += 1;
    else if (role === 'assistant') {
      assistantMessages += 1;
      const u = msg.usage;
      if (u) {
        const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        tokensInput += input;
        tokensOutput += u.output_tokens || 0;
        if (input) contextTokens = input;
      }
    }

    events.push({
      role,
      type: o.type,
      uuid: o.uuid,
      parentUuid: o.parentUuid,
      timestamp: o.timestamp,
      isSidechain: !!o.isSidechain,
      toolResultOnly: role === 'user' && !hasNonToolResult,
      blocks,
    });
  }

  for (const ev of events) {
    ev.blocks = ev.blocks.filter((block) => {
      if (block.kind !== 'tool_result') return true;
      const owner = toolUseIndex.get(block.id);
      if (!owner) return true;
      owner.result = { isError: block.isError, text: block.text };
      return false;
    });
  }

  const subtaskById = new Map();
  taskCreates.forEach((block, idx) => {
    const input = block.input || {};
    const m = block.result && /#(\d+)/.exec(block.result.text || '');
    const id = String(m ? m[1] : idx + 1);
    subtaskById.set(id, {
      id,
      subject: input.subject || input.content || '(untitled)',
      description: input.description || '',
      activeForm: input.activeForm || '',
      status: 'pending',
    });
  });
  for (const update of taskUpdates) {
    const item = subtaskById.get(String(update.taskId));
    if (item && update.status) item.status = update.status;
  }

  const agents = agentCalls.map((block, idx) => {
    const input = block.input || {};
    const usage = parseAgentUsage(block.result && block.result.text);
    return {
      index: idx + 1,
      type: input.subagent_type || 'agent',
      model: input.model || null,
      task: input.description || '',
      prompt: input.prompt || '',
      status: !block.result ? 'running' : block.result.isError ? 'error' : 'completed',
      ...usage,
    };
  });

  return {
    meta,
    events,
    subtasks: [...subtaskById.values()],
    agents,
    filesTouched: [...filesTouched.values()].map((rec) => ({ path: rec.path, ops: [...rec.ops] })),
    commands,
    counts: { userMessages, assistantMessages, toolCalls, tokensInput, tokensOutput, contextTokens },
  };
}

function streamCounts(filePath) {
  try {
    const parsed = parseTranscript(filePath);
    return {
      tokensInput: parsed.counts.tokensInput || 0,
      tokensOutput: parsed.counts.tokensOutput || 0,
      contextTokens: parsed.counts.contextTokens || 0,
      modelContextWindow: 0,
    };
  } catch (e) {
    return { tokensInput: 0, tokensOutput: 0, contextTokens: 0, modelContextWindow: 0, error: String(e && e.message) };
  }
}

module.exports = { parseTranscript, streamCounts };
