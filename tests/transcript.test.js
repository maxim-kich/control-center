'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseTranscript, streamCounts } = require('../lib/transcript');

function writeFixture(lines) {
  const file = path.join(os.tmpdir(), `codex-transcript-test-${crypto.randomBytes(6).toString('hex')}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('parseTranscript: extracts Codex meta, messages, tool calls, commands, files, and tokens', () => {
  const file = writeFixture([
    {
      timestamp: '2026-06-27T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-1',
        timestamp: '2026-06-27T10:00:00.000Z',
        cwd: '/repo',
        cli_version: '0.141.0',
        git: { branch: 'main' },
      },
    },
    {
      timestamp: '2026-06-27T10:00:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/repo', model: 'gpt-5.5', reasoning_effort: 'xhigh' },
    },
    {
      timestamp: '2026-06-27T10:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Please run tests and patch foo.js.' },
    },
    {
      timestamp: '2026-06-27T10:00:03.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'I will inspect the file first.', phase: 'commentary' },
    },
    {
      timestamp: '2026-06-27T10:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_1',
        arguments: JSON.stringify({ cmd: 'npm test', workdir: '/repo' }),
      },
    },
    {
      timestamp: '2026-06-27T10:00:05.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'pass' },
    },
    {
      timestamp: '2026-06-27T10:00:06.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_patch',
        input: '*** Begin Patch\n*** Update File: foo.js\n@@\n-console.log("old")\n+console.log("new")\n*** End Patch\n',
      },
    },
    {
      timestamp: '2026-06-27T10:00:07.000Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call_patch',
        success: true,
        stdout: 'Success',
        changes: { 'foo.js': { type: 'update' } },
      },
    },
    {
      timestamp: '2026-06-27T10:00:08.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'call_plan',
        arguments: JSON.stringify({
          explanation: 'Working plan',
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Patch', status: 'in_progress' },
          ],
        }),
      },
    },
    {
      timestamp: '2026-06-27T10:00:09.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 25,
            reasoning_output_tokens: 5,
            total_tokens: 125,
          },
          model_context_window: 258400,
        },
      },
    },
    'not json',
  ]);

  try {
    const result = parseTranscript(file);
    assert.equal(result.meta.sessionId, 'sess-1');
    assert.equal(result.meta.cwd, '/repo');
    assert.equal(result.meta.gitBranch, 'main');
    assert.equal(result.meta.version, '0.141.0');
    assert.equal(result.meta.model, 'gpt-5.5');
    assert.equal(result.meta.effort, 'xhigh');

    assert.equal(result.counts.userMessages, 1);
    assert.equal(result.counts.assistantMessages, 1);
    assert.equal(result.counts.toolCalls, 3);
    assert.equal(result.counts.tokensInput, 100);
    assert.equal(result.counts.tokensOutput, 25);
    assert.equal(result.counts.totalTokens, 125);
    assert.equal(result.counts.reasoningTokens, 5);
    assert.equal(result.counts.modelContextWindow, 258400);

    assert.deepEqual(result.commands, [{ command: 'npm test', description: '' }]);
    assert.deepEqual(result.filesTouched, [{ path: 'foo.js', ops: ['write'] }]);
    assert.deepEqual(result.subtasks.map((s) => [s.subject, s.status]), [
      ['Inspect', 'completed'],
      ['Patch', 'in_progress'],
    ]);

    const execBlock = result.events.flatMap((e) => e.blocks).find((b) => b.kind === 'tool_use' && b.id === 'call_1');
    assert.ok(execBlock.result);
    assert.equal(execBlock.result.text, 'pass');
  } finally {
    fs.unlinkSync(file);
  }
});

test('streamCounts: reads latest Codex token_count cheaply', () => {
  const file = writeFixture([
    {
      type: 'event_msg',
      payload: { type: 'task_started', model_context_window: 1000 },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 10, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
          model_context_window: 1000,
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 20, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 27 },
          last_token_usage: { input_tokens: 12, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 16 },
          model_context_window: 2000,
        },
      },
    },
  ]);
  try {
    assert.deepEqual(streamCounts(file), {
      tokensInput: 20,
      tokensOutput: 7,
      totalTokens: 27,
      reasoningTokens: 2,
      contextTokens: 16,
      modelContextWindow: 2000,
    });
  } finally {
    fs.unlinkSync(file);
  }
});
