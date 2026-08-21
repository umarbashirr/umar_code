'use strict';
// The agent panel's runtime. Runs Claude in-process through the Agent SDK, with
// the preview browser handed over as native tools so nothing has to be wired up
// by the user.
const { EventEmitter } = require('events');
const fs = require('fs');
const { browserTools, INSTRUCTIONS } = require('../shared/browser-tools');
const { claudeBinary } = require('./driver');
const shellEnv = require('./shell-path');

// How a screenshot tool result announces where the file landed. index.js reads
// it back to strip the base64 copy before the message reaches the renderer, so
// the two have to agree.
const shotNote = (r) => `${r.width}x${r.height} saved to ${r.path}`;
const SHOT_NOTE = /^(\d+)x(\d+) saved to (.+)$/;

// Tools that only read; asking permission for these is noise.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch']);

class AgentSession extends EventEmitter {
  constructor({ cwd, invoke, resume, model, settings, mcpOff }) {
    super();
    this.cwd = cwd;
    this.invoke = invoke;              // (bridgeTool, args) => Promise<result>
    this.resume = resume || null;      // session id to continue, from history.js
    this.queue = [];
    this.waiting = null;
    this.closed = false;
    this.busy = false;
    this.pending = new Map();          // permission id -> resolve
    this.permissionMode = 'default';
    // Chosen from the cached catalogue before any session existed, so the first
    // query starts on the right model instead of switching after it is up.
    this.model = model || null;
    // Skills switched off and project servers rejected, in the shape the CLI's
    // own settings use. catalog.js works these out; see sessionSettings there.
    this.settings = settings && Object.keys(settings).length ? settings : null;
    // Servers no settings file can reject, dropped once the session is up.
    this.mcpOff = mcpOff || [];
    this.sessionId = null;
    this.query = null;
    // Held for setMcpServers: it replaces the whole dynamic set, so the browser
    // tools have to be handed back every time or they go with it.
    this.preview = null;
    this.dynamic = {};
  }

  async start() {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');

    const CORE = new Set(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill',
      'browser_type', 'browser_screenshot', 'browser_console', 'browser_show']);

    const tools = browserTools(z).map((t) =>
      sdk.tool(t.name, t.description, t.schema, async (args) => {
        const route = t.route ? t.route(args) : t.bridgeTool;
        const mapped = t.map ? t.map(args) : args;
        const result = await this.invoke(route, mapped);

        if (t.format === 'image' && result?.path) {
          const data = fs.readFileSync(result.path).toString('base64');
          return {
            content: [
              { type: 'image', data, mimeType: 'image/png' },
              { type: 'text', text: shotNote(result) },
            ],
          };
        }
        const text = t.render ? t.render(result)
          : typeof result === 'string' ? result
            : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      }, { alwaysLoad: CORE.has(t.name) }),
    );

    const preview = sdk.createSdkMcpServer({ name: 'preview', version: '0.1.0', tools });
    this.preview = preview;
    const bin = claudeBinary();
    if (bin) this.emit('stderr', `using claude binary at ${bin}\n`);

    this.abort = new AbortController();
    this.query = sdk.query({
      prompt: this.#input(),
      options: {
        cwd: this.cwd,
        abortController: this.abort,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        // Launched from a desktop launcher the app has a bare PATH, and every
        // MCP server configured as a plain command name fails to start. See
        // shell-path.js.
        env: { ...process.env, PATH: shellEnv.cached() },
        mcpServers: { preview },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
        ...(this.settings ? { settings: this.settings } : {}),
        ...(this.model ? { model: this.model } : {}),
        canUseTool: (name, input, opts) => this.#permission(name, input, opts),
        // Continue an earlier session in place. forkSession stays off so the
        // transcript keeps one id and one file on disk.
        ...(this.resume ? { resume: this.resume, forkSession: false } : {}),
        stderr: (d) => this.emit('stderr', d),
        ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
      },
    });

    this.#pump();
    return this;
  }

  async *#input() {
    while (!this.closed) {
      if (!this.queue.length) {
        await new Promise((r) => { this.waiting = r; });
        if (this.closed) return;
      }
      const turn = this.queue.shift();
      if (turn == null) return;
      yield {
        type: 'user',
        message: { role: 'user', content: blocks(turn) },
        parent_tool_use_id: null,
        session_id: this.sessionId || '',
        origin: { kind: 'human' },
      };
    }
  }

  async #pump() {
    try {
      for await (const msg of this.query) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.permissionMode = msg.permissionMode || this.permissionMode;
          this.model = msg.model || this.model;
          this.emit('ready', {
            sessionId: msg.session_id,
            model: msg.model,
            permissionMode: this.permissionMode,
            tools: msg.tools?.length,
          });
          this.#dropDisabledServers();
        }
        if (msg.type === 'result') this.busy = false;
        this.emit('message', msg);
      }
    } catch (err) {
      if (!this.closed) this.emit('error', err?.message || String(err));
    } finally {
      this.busy = false;
      this.emit('closed');
    }
  }

  #permission(name, input, { suggestions } = {}) {
    if (name.startsWith('mcp__preview__') || AUTO_ALLOW.has(name)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, input, suggestions });
      this.emit('permission', { id, tool: name, input });
    });
  }

  decide(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (decision === 'allow') entry.resolve({ behavior: 'allow', updatedInput: entry.input });
    else if (decision === 'always') {
      entry.resolve({ behavior: 'allow', updatedInput: entry.input, updatedPermissions: entry.suggestions });
    } else entry.resolve({ behavior: 'deny', message: 'The human declined this action.' });
    return true;
  }

  // `images` is what the human attached: base64 already, because the model can
  // only look at a picture whose bytes came with the message.
  send(text, images) {
    this.busy = true;
    this.queue.push(images?.length ? { text, images } : text);
    if (this.waiting) { const w = this.waiting; this.waiting = null; w(); }
  }

  async interrupt() {
    try { await this.query?.interrupt(); } catch {}
    this.busy = false;
  }

  // The models the logged-in account can actually use, straight from the SDK,
  // so the picker never offers something that will fail on send.
  async models() {
    try { return await this.query?.supportedModels() ?? []; } catch { return []; }
  }

  async setModel(model) {
    try { await this.query?.setModel(model || undefined); this.model = model || null; } catch {}
    return this.model;
  }

  // Servers the user switched off that live in ~/.claude.json or a plugin: no
  // settings key rejects those, so the running session is told to drop them.
  async #dropDisabledServers() {
    for (const name of this.mcpOff) {
      try { await this.query?.toggleMcpServer(name, false); } catch {}
    }
  }

  // Every slash command the session knows, which is the disk listing plus the
  // ones the CLI ships with.
  async commands() {
    try { return await this.query?.supportedCommands() ?? []; } catch { return []; }
  }

  async mcpStatus() {
    try { return await this.query?.mcpServerStatus() ?? []; } catch { return []; }
  }

  async toggleMcp(name, enabled) {
    this.mcpOff = enabled ? this.mcpOff.filter((n) => n !== name) : [...new Set([...this.mcpOff, name])];
    try { await this.query?.toggleMcpServer(name, enabled); return { ok: true }; } catch (e) {
      return { error: e?.message || String(e) };
    }
  }

  async reconnectMcp(name) {
    try { await this.query?.reconnectMcpServer(name); return { ok: true }; } catch (e) {
      return { error: e?.message || String(e) };
    }
  }

  // A server added to a config file mid-chat is invisible to the CLI, which
  // read those files at startup. Adding it dynamically as well means it works
  // in this chat too, and the next one picks the same server up from disk.
  //
  // setMcpServers replaces the whole dynamic set, so the preview tools have to
  // ride along in every call or the browser disappears from the session.
  async #syncDynamic() {
    if (!this.query) return { error: 'no session' };
    try {
      const res = await this.query.setMcpServers({ preview: this.preview, ...this.dynamic });
      const failed = Object.entries(res?.errors || {}).filter(([n]) => n !== 'preview');
      return failed.length ? { error: failed.map(([n, m]) => `${n}: ${m}`).join('; ') } : { ok: true };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  }

  async addMcpServer(name, config) {
    this.dynamic[name] = config;
    return this.#syncDynamic();
  }

  async removeMcpServer(name) {
    delete this.dynamic[name];
    const res = await this.#syncDynamic();
    // Config-loaded servers are not part of the dynamic set, so removing the
    // entry does nothing for them; switching it off is what the session hears.
    try { await this.query?.toggleMcpServer(name, false); } catch {}
    return res;
  }

  // The account's cloud connectors are fetched by the CLI at startup, so the
  // switch really lands on the next chat; a session already holding them open
  // is told to drop them so the two views agree.
  async setConnectors(on, off) {
    if (Array.isArray(off)) this.mcpOff = off;
    try {
      await this.query?.applyFlagSettings({ disableClaudeAiConnectors: on ? null : true });
    } catch { /* an older CLI simply keeps them until the next chat */ }
    if (!on) await this.#dropDisabledServers();
    return { ok: true };
  }

  // Skills come and go through the settings layer, which can be re-merged
  // without restarting the session.
  async setSkillOverrides(overrides) {
    try {
      await this.query?.applyFlagSettings({ skillOverrides: Object.keys(overrides).length ? overrides : null });
      return { ok: true };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    try { await this.query?.setPermissionMode(mode); } catch {}
    return mode;
  }

  stop() {
    this.closed = true;
    for (const [id] of this.pending) this.decide(id, 'deny');
    if (this.waiting) { const w = this.waiting; this.waiting = null; w(); }
    try { this.abort?.abort(); } catch {}
  }
}

// Pictures go ahead of the words. The models read a prompt that refers back to
// an image it has already seen more reliably than one that arrives first.
function blocks(turn) {
  if (typeof turn === 'string') return [{ type: 'text', text: turn }];
  return [
    ...turn.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media, data: img.data },
    })),
    { type: 'text', text: turn.text },
  ];
}

module.exports = { AgentSession, SHOT_NOTE };
