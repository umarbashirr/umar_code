#!/usr/bin/env node
'use strict';
// Stand-in ACP agent for tests. Speaks newline-delimited JSON-RPC on stdio.
const readline = require('readline');

if (process.argv.includes('--version')) {
  process.stdout.write('mock-acp 0.0.1\n');
  process.exit(0);
}

const AUTH = process.env.MOCK_ACP_AUTH === '1';
const ASK = process.env.MOCK_ACP_ASK === '1';
let seq = 0;
let promptId = null;
let cancelled = false;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value ?? null });
}

function fail(id, message, code = -32000) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function chunk(sessionId, text) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });
}

function tool(sessionId, id, title, kind, input) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title,
      kind,
      status: 'pending',
      rawInput: input,
    },
  });
}

function toolDone(sessionId, id, output, failed) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: failed ? 'failed' : 'completed',
      rawOutput: output,
      content: [{ type: 'content', content: { type: 'text', text: output } }],
    },
  });
}

async function handlePrompt(id, params) {
  promptId = id;
  cancelled = false;
  const sessionId = params.sessionId || 's1';
  const text = (params.prompt || [])
    .map((b) => (b && b.type === 'text' ? b.text : ''))
    .join('\n');

  if (ASK) {
    send({
      jsonrpc: '2.0',
      id: `perm-${++seq}`,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 't-ask', title: 'echo', kind: 'execute', rawInput: { command: 'echo hi' } },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
  }

  if (/tool/i.test(text)) {
    tool(sessionId, 't1', 'echo', 'execute', { command: 'echo hi' });
    toolDone(sessionId, 't1', 'hi\n', false);
  }

  chunk(sessionId, 'hello ');
  chunk(sessionId, 'from mock');
  if (cancelled) {
    result(id, { stopReason: 'cancelled' });
  } else {
    result(id, { stopReason: 'end_turn' });
  }
  promptId = null;
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'session/cancel') {
    cancelled = true;
    if (promptId != null) {
      result(promptId, { stopReason: 'cancelled' });
      promptId = null;
    }
    return;
  }

  if (id === undefined || !method) return;

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: {},
      },
      agentInfo: { name: 'mock-acp', title: 'Mock ACP', version: '0.0.1' },
      authMethods: AUTH ? [{ id: 'login', name: 'Log in', description: 'mock login' }] : [],
    });
  }

  if (method === 'authenticate') {
    return AUTH ? fail(id, 'not logged in') : result(id, {});
  }

  if (method === 'session/new' || method === 'session/load') {
    if (AUTH) return fail(id, 'not authenticated; run login');
    const servers = params?.mcpServers || [];
    return result(id, {
      sessionId: params?.sessionId || 's1',
      mcpServers: servers.map((s) => s.name),
      models: {
        currentModelId: params?._meta?.model || 'mock-1',
        availableModels: [
          { modelId: 'mock-1', name: 'Mock One' },
          { modelId: 'mock-2', name: 'Mock Two' },
        ],
      },
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'plan', name: 'Plan' },
          { id: 'bypass', name: 'Bypass' },
        ],
      },
    });
  }

  if (method === 'session/prompt') return handlePrompt(id, params || {});
  if (method === 'session/set_model') return result(id, {});
  if (method === 'session/set_mode') return result(id, {});
  if (method === 'session/close') return result(id, {});

  fail(id, `unknown method ${method}`, -32601);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try { onMessage(msg); } catch (e) {
    if (msg.id !== undefined) fail(msg.id, e.message);
  }
});
rl.on('close', () => process.exit(0));
