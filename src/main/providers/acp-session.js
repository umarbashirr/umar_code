'use strict';
const { modelsFrom, configOption } = require('./acp-models');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AcpRpc, HANDSHAKE_MS } = require('./acp-rpc');
const { DEFAULT_MODE, isMode, decideCodex, DEBUG_PREFACE, browserTool } = require('../modes');
const { INSTRUCTIONS } = require('../../shared/browser-tools');
const shellEnv = require('../shell-env');

const CLIENT = {
  name: 'tandem',
  title: 'Tandem',
  version: (() => {
    try { return require('../../../package.json').version; } catch { return '0.0.0'; }
  })(),
};

const KIND_TOOL = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Edit',
  move: 'Edit',
  search: 'Grep',
  execute: 'Bash',
  think: 'Read',
  fetch: 'WebFetch',
  other: 'Tool',
};

/* Exact ACP mode ids we will set for each Tandem mode. `build` is deliberately
   absent: OpenCode's build is ordinary work, not ask/always/bypass, and mapping
   bypass onto it would drop the mode's meaning. Work modes that still need a
   CLI that allows edits may fall through to `build` in pickMode below. */
const MODE_CANDIDATES = {
  plan: ['plan'],
  ask: ['ask', 'default', 'normal'],
  debug: ['ask', 'default', 'normal'],
  auto: ['auto', 'acceptEdits', 'agent', 'code'],
  acceptEdits: ['acceptEdits', 'agent', 'auto'],
  always: ['ask', 'default', 'normal'],
  bypass: ['bypass', 'danger', 'full'],
};

// Modes that mean "do the work, Tandem decides" — never bypass/always/plan.
const BUILD_FALLBACK = new Set(['ask', 'debug', 'auto', 'acceptEdits']);

/* Same words Claude and Codex get, plus the disambiguation Codex needed when
   another browser skill was competing. ACP agents (Cursor, Grok, OpenCode)
   only see MCP tool lists unless we say this out loud on the first turn. */
const ACP_INSTRUCTIONS = [
  INSTRUCTIONS,
  'These browser_* tools from the tandem MCP server drive the preview pane inside this app, which is the browser the human is looking at.',
  'Use them for anything to do with a page. Any other browser tool or skill you have drives a different window that nobody can see.',
].join(' ');

const BROWSER_NAME = /^(?:mcp__(?:preview|tandem)__)?browser_\w+$/;

const textOf = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (v.content) return textOf(v.content);
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
};

function mcpEnv(env) {
  return Object.entries(env || {})
    .filter(([, v]) => v != null)
    .map(([name, value]) => ({ name, value: String(value) }));
}

function pickMode(ourMode, available) {
  if (!available?.length) return null;
  const ids = new Set(available.map((m) => m.id || m.value).filter(Boolean));
  const hit = (MODE_CANDIDATES[ourMode] || []).find((id) => ids.has(id));
  if (hit) return hit;
  // OpenCode often only advertises plan/build. Ask/auto still need a CLI that
  // allows edits so our permission callback can run; bypass and always must not
  // inherit build or they silently stop meaning what the composer shows.
  if (BUILD_FALLBACK.has(ourMode) && ids.has('build')) return 'build';
  return null;
}

/* Prefer a concrete MCP / browser tool name over ACP's coarse kind bucket.
   kind "other" used to become "Tool" and skip browser READS auto-allow. */
function toolOf(call) {
  const title = typeof call?.title === 'string' ? call.title : '';
  const raw = call?.rawInput && typeof call.rawInput === 'object' ? call.rawInput : null;
  const named = [
    title,
    raw?.name, raw?.tool, raw?.toolName, raw?.mcpTool,
  ].filter((v) => typeof v === 'string' && v);
  for (const name of named) {
    if (browserTool(name) || BROWSER_NAME.test(name)) return name;
  }
  const kind = call?.kind;
  if (kind && kind !== 'other' && KIND_TOOL[kind]) return KIND_TOOL[kind];
  return title || KIND_TOOL[kind] || 'Tool';
}

function optionFor(options, decision) {
  const want = decision === 'always' ? 'allow_always'
    : decision === 'deny' ? 'reject_once'
      : 'allow_once';
  return (options || []).find((o) => o.kind === want)
    || (decision === 'deny' ? (options || []).find((o) => String(o.kind || '').startsWith('reject')) : null)
    || (options || [])[0]
    || null;
}

class AcpSession extends EventEmitter {
  constructor({ spec, cwd, resume, model, mode, effort, bridgeEnv, mcp, shared }) {
    super();
    this.spec = spec;
    this.cwd = cwd;
    this.resume = resume || null;
    this.model = model || null;
    this.mode = isMode(mode) ? mode : DEFAULT_MODE;
    this.effort = effort || null;
    this.bridgeEnv = bridgeEnv || {};
    this.mcp = mcp || null;
    this.shared = shared || [];
    this.queue = [];
    this.closed = false;
    this.busy = false;
    this.pending = new Map();
    this.sessionId = null;
    this.rpc = null;
    this.streaming = false;
    // Debug rides ahead of the next human turn; browser instructions ride ahead
    // of the first turn only, the same way Codex puts them on thread/start.
    this.preface = [
      this.mcp ? ACP_INSTRUCTIONS : null,
      this.mode === 'debug' ? DEBUG_PREFACE : null,
    ].filter(Boolean).join('\n\n') || null;
    this.modes = [];
    this.config = [];
    this.startedAt = 0;
    this.prompting = null;
  }

  async start() {
    await shellEnv.ready();
    const bin = this.spec.binary();
    if (!bin) {
      throw new Error(this.spec.missing || `No ${this.spec.cli} on your PATH.`);
    }
    this.emit('stderr', `using ${this.spec.cli} binary at ${bin}\n`);

    this.rpc = new AcpRpc({
      bin,
      argv: this.spec.argv || ['acp'],
      cwd: this.cwd,
      env: this.spec.env ? this.spec.env() : undefined,
    });
    this.rpc.on('stderr', (d) => this.emit('stderr', d));
    this.rpc.on('notification', (m, p) => this.#note(m, p));
    this.rpc.on('request', (m, p, respond) => this.#ask(m, p, respond));
    this.rpc.on('closed', (why) => {
      if (!this.closed) this.emit('error', why);
      this.closed = true;
      this.busy = false;
      this.emit('closed');
    });

    await this.rpc.start();
    const init = await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }, HANDSHAKE_MS);

    if (init?.authMethods?.length && this.spec.authenticate) {
      try { await this.spec.authenticate(this.rpc, init); } catch {}
    }

    const mcpServers = this.#servers();
    const params = { cwd: this.cwd, mcpServers };
    let res;
    try {
      res = this.resume && init?.agentCapabilities?.loadSession
        ? await this.rpc.request('session/load', { ...params, sessionId: this.resume })
        : await this.rpc.request('session/new', params);
    } catch (e) {
      const why = e?.message || String(e);
      if (/auth|login|unauthor/i.test(why)) {
        throw new Error(`${this.spec.cli} is installed but not logged in. Run \`${this.spec.login}\`, then open a new chat.`);
      }
      throw e;
    }

    this.sessionId = res?.sessionId || this.resume || null;
    this.config = res?.configOptions || [];
    this.modes = res?.modes?.availableModes
      || (configOption(res, 'mode')?.options || []).map((o) => ({ id: o.value }));
    const advertised = res?.models?.currentModelId || configOption(res, 'model')?.currentValue;
    if (advertised && !this.model) this.model = advertised;
    if (this.model) {
      try { await this.#set('model', this.model); } catch {}
    }
    const acpMode = pickMode(this.mode, this.modes);
    if (acpMode) {
      try { await this.#set('mode', acpMode); } catch {}
    }

    this.emit('ready', {
      sessionId: this.sessionId,
      model: this.model,
      mode: this.mode,
      models: modelsFrom(res),
    });
    return this;
  }

  #servers() {
    const shared = this.shared.map((s) => ({ ...s, env: mcpEnv(s.env) }));
    if (!this.mcp?.command) return shared;
    const env = { ...(this.mcp.env || {}), ...this.bridgeEnv, TANDEM_CWD: this.cwd };
    return [{
      name: this.mcp.name || 'tandem',
      command: this.mcp.command,
      args: this.mcp.args || [],
      env: mcpEnv(env),
    }, ...shared];
  }

  send(textIn, images = []) {
    let body = textIn;
    if (this.preface) { body = `${this.preface}\n\n${body}`; this.preface = null; }
    const prompt = [];
    for (const img of images || []) {
      if (img?.data) prompt.push({ type: 'image', data: img.data, mimeType: img.media || img.mediaType || 'image/png' });
    }
    prompt.push({ type: 'text', text: body });
    this.#run(prompt);
  }

  #run(prompt) {
    this.busy = true;
    this.startedAt = Date.now();
    this.prompting = this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt })
      .then((res) => this.#promptDone(res))
      .catch((e) => {
        this.busy = false;
        this.#closeStream();
        this.emit('error', e?.message || String(e));
      });
  }

  #promptDone(res) {
    this.#closeStream();
    this.busy = false;
    this.prompting = null;
    const stop = res?.stopReason || 'end_turn';
    const cancelled = stop === 'cancelled';
    this.#emit({
      type: 'result',
      subtype: cancelled ? 'cancelled' : (stop === 'end_turn' ? 'success' : stop),
      duration_ms: this.startedAt ? Date.now() - this.startedAt : 0,
    });
  }

  async interrupt() {
    for (const [id] of this.pending) this.decide(id, 'deny');
    this.rpc?.notify('session/cancel', { sessionId: this.sessionId });
    this.busy = false;
    return { ok: true };
  }

  async setModel(model) {
    this.model = model || null;
    if (this.sessionId && this.model) {
      try { await this.#set('model', this.model); } catch (e) {
        this.emit('error', `could not switch to ${model}: ${e?.message || e}`);
      }
    }
    return this.model;
  }

  async setMode(mode) {
    if (!isMode(mode)) return this.mode;
    const was = this.mode;
    this.mode = mode;
    if (mode === 'debug' && was !== 'debug') {
      this.preface = this.preface
        ? `${this.preface}\n\n${DEBUG_PREFACE}`
        : DEBUG_PREFACE;
    }
    if (mode !== 'debug' && this.preface) {
      this.preface = this.preface
        .split('\n\n')
        .filter((p) => p !== DEBUG_PREFACE)
        .join('\n\n') || null;
    }
    const acpMode = pickMode(mode, this.modes);
    if (acpMode && this.sessionId) {
      try { await this.#set('mode', acpMode); } catch {}
    }
    this.emit('mode', { mode });
    return this.mode;
  }

  #set(category, value) {
    const option = this.config.find((o) => o?.category === category);
    if (option) return this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value });
    return category === 'model'
      ? this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: value })
      : this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: value });
  }

  decide(id, decision, input) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    const opt = optionFor(entry.options, decision);
    if (!opt || decision === 'deny' && !String(opt.kind || '').startsWith('reject') && opt.kind !== 'reject_once') {
      entry.respond.result({ outcome: { outcome: 'cancelled' } });
      return true;
    }
    entry.respond.result({ outcome: { outcome: 'selected', optionId: opt.optionId } });
    return true;
  }

  async models() { return []; }
  async commands() { return []; }
  async mcpStatus() { return []; }
  async toggleMcp() { return { error: 'this CLI takes MCP servers at session start' }; }
  async reconnectMcp() { return { error: 'this CLI takes MCP servers at session start' }; }
  async addMcpServer() { return { error: 'this CLI takes MCP servers at session start' }; }
  async removeMcpServer() { return { error: 'this CLI takes MCP servers at session start' }; }
  async setConnectors() { return { error: 'this CLI has no connectors to switch' }; }
  async setSkillOverrides() { return { error: 'this CLI turns skills off where they are installed' }; }
  async stopTask() { return { ok: false }; }
  async background() { return { ok: false }; }
  async contextUsage() { return null; }
  async planUsage() { return null; }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.busy = false;
    for (const [id] of this.pending) this.decide(id, 'deny');
    try { this.rpc?.request('session/close', { sessionId: this.sessionId }).catch(() => {}); } catch {}
    this.rpc?.close();
  }

  #emit(msg) {
    this.emit('message', { ...msg, session_id: msg.session_id ?? (this.sessionId || '') });
  }

  #stream(event) {
    this.#emit({ type: 'stream_event', event, parent_tool_use_id: null });
  }

  #openStream() {
    if (this.streaming) return;
    this.streaming = true;
    this.#stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  }

  #closeStream() {
    if (!this.streaming) return;
    this.streaming = false;
    this.#stream({ type: 'content_block_stop', index: 0 });
  }

  #note(method, params) {
    if (method !== 'session/update') return;
    const update = params?.update || params;
    const kind = update?.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = textOf(update.content);
      if (!text) return;
      this.#openStream();
      this.#stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      return;
    }
    if (kind === 'tool_call') {
      this.#closeStream();
      const id = update.toolCallId;
      const name = toolOf(update);
      const input = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : { title: update.title };
      this.#emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
        parent_tool_use_id: null,
      });
      return;
    }
    if (kind === 'tool_call_update') {
      if (update.status !== 'completed' && update.status !== 'failed') return;
      const output = textOf(update.rawOutput) || textOf(update.content) || update.status;
      this.#emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: update.toolCallId,
            content: output,
            is_error: update.status === 'failed',
          }],
        },
        parent_tool_use_id: null,
      });
      return;
    }
    if (kind === 'current_mode_update' && update.modeId) {
      const ours = Object.keys(MODE_CANDIDATES).find((m) => (MODE_CANDIDATES[m] || []).includes(update.modeId));
      if (ours && ours !== this.mode) {
        this.mode = ours;
        this.emit('mode', { mode: ours });
      }
    }
  }

  #ask(method, params, respond) {
    if (method === 'session/request_permission') return this.#permission(params, respond);
    if (method === 'fs/read_text_file') return this.#readFile(params, respond);
    if (method === 'fs/write_text_file') return this.#writeFile(params, respond);
    respond.error({ code: -32601, message: `unsupported ${method}` });
  }

  #permission(params, respond) {
    const call = params.toolCall || {};
    const tool = toolOf(call);
    const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : { title: call.title };
    const verdict = decideCodex(this.mode, tool, input);
    const options = params.options || [];
    if (verdict.action === 'allow') {
      const opt = optionFor(options, 'allow');
      return respond.result({ outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } });
    }
    const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    this.pending.set(id, { respond, options, tool, input });
    this.emit('permission', { id, tool, input, reason: verdict.reason, agent: null });
  }

  #readFile(params, respond) {
    try {
      const file = this.#within(params.path);
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n');
      const start = Math.max(0, (params.line || 1) - 1);
      const slice = params.limit ? lines.slice(start, start + params.limit) : lines.slice(start);
      respond.result({ content: slice.join('\n') });
    } catch (e) {
      respond.error({ message: e.message });
    }
  }

  #writeFile(params, respond) {
    try {
      const file = this.#within(params.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, params.content ?? '');
      respond.result({});
    } catch (e) {
      respond.error({ message: e.message });
    }
  }

  #within(rel) {
    const root = path.resolve(this.cwd);
    const abs = path.resolve(root, rel || '');
    const relTo = path.relative(root, abs);
    if (relTo.startsWith('..') || path.isAbsolute(relTo)) throw new Error('that path is outside the project folder');
    return abs;
  }
}

module.exports = {
  AcpSession, CLIENT, mcpEnv, pickMode, toolOf, MODE_CANDIDATES, ACP_INSTRUCTIONS,
};
