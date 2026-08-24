'use strict';
// The agent panel's runtime. Runs Claude in-process through the Agent SDK, with
// the preview browser handed over as native tools so nothing has to be wired up
// by the user.
const { EventEmitter } = require('events');
const fs = require('fs');
const { browserTools, INSTRUCTIONS } = require('../shared/browser-tools');
const { claudeBinary } = require('./driver');
const { SDK_MODE, DEFAULT_MODE, isMode, decide, DEBUG_PREFACE } = require('./modes');
const shellEnv = require('./shell-path');

// How a screenshot tool result announces where the file landed. index.js reads
// it back to strip the base64 copy before the message reaches the renderer, so
// the two have to agree.
const shotNote = (r) => `${r.width}x${r.height} saved to ${r.path}`;
const SHOT_NOTE = /^(\d+)x(\d+) saved to (.+)$/;

// How long a browser tool waits to learn which agent called it. The CLI
// announces the tool_use a beat after it starts running the tool, so the first
// call from a subagent would otherwise be attributed to nobody.
const OWNER_WAIT = 400;

class AgentSession extends EventEmitter {
  constructor({ cwd, invoke, resume, model, mode, settings, mcpOff }) {
    super();
    this.cwd = cwd;
    this.invoke = invoke;              // (bridgeTool, args, actor) => Promise<result>
    this.resume = resume || null;      // session id to continue, from history.js
    this.queue = [];
    this.waiting = null;
    this.closed = false;
    this.busy = false;
    this.pending = new Map();          // permission id -> resolve
    // The mode the composer shows. The SDK only understands four of the seven,
    // so modes.js keeps both halves: what the SDK is told, and what this class
    // enforces on top. `preface` is how a mode gets a word in before the next
    // thing the human types.
    this.mode = isMode(mode) ? mode : DEFAULT_MODE;
    this.permissionMode = SDK_MODE[this.mode];
    this.preface = this.mode === 'debug' ? DEBUG_PREFACE : null;
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
    // Who is driving. A subagent's tool calls are only distinguishable from the
    // main thread's by working backwards: the permission callback knows the
    // agent id outright, and failing that the assistant message carrying the
    // tool_use names the Agent call it belongs to. See #actorFor.
    this.owners = new Map();           // inner tool_use id -> agent id | 'main'
    this.ownerWaits = new Map();       // inner tool_use id -> resolve
    this.tasks = new Map();            // agent id -> { toolUseId, type, description }
    this.byToolUse = new Map();        // Agent tool_use id -> agent id
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
      sdk.tool(t.name, t.description, t.schema, async (args, extra) => {
        const route = t.route ? t.route(args) : t.bridgeTool;
        const mapped = t.map ? t.map(args) : args;
        const result = await this.invoke(route, mapped, await this.#actorFor(extra));

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
        // Without this a subagent is a black box: only its tool calls come
        // through, never what it was thinking or what it concluded.
        forwardSubagentText: true,
        settingSources: ['user', 'project', 'local'],
        // Launched from a desktop launcher the app has a bare PATH, and every
        // MCP server configured as a plain command name fails to start. See
        // shell-path.js.
        env: { ...process.env, PATH: shellEnv.cached() },
        mcpServers: { preview },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
        permissionMode: this.permissionMode,
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
          // A resumed session comes back on whatever mode it was saved with.
          // The composer is showing ours, so put ours back rather than let the
          // two drift apart with nobody the wiser.
          if (msg.permissionMode && msg.permissionMode !== this.permissionMode) {
            this.query?.setPermissionMode(this.permissionMode)?.catch?.(() => {});
          }
          this.model = msg.model || this.model;
          this.emit('ready', {
            sessionId: msg.session_id,
            model: msg.model,
            mode: this.mode,
            tools: msg.tools?.length,
          });
          this.#dropDisabledServers();
        }
        this.#track(msg);
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

  // Everything needed to tell one agent's work from another's, kept as the
  // stream goes past. `task_started` is the only place the agent id and the
  // Agent tool_use id that spawned it appear together.
  #track(msg) {
    if (msg.type === 'system' && msg.subtype === 'task_started') {
      this.tasks.set(msg.task_id, {
        toolUseId: msg.tool_use_id || null,
        type: msg.subagent_type || msg.task_type || 'agent',
        description: msg.description || '',
      });
      if (msg.tool_use_id) this.byToolUse.set(msg.tool_use_id, msg.task_id);
      return;
    }
    if (msg.type !== 'assistant') return;
    // A tool_use inside a subagent carries that subagent's Agent call as its
    // parent, which names the agent. On the main thread the parent is null.
    const agent = msg.parent_tool_use_id ? this.byToolUse.get(msg.parent_tool_use_id) : null;
    for (const b of msg.message?.content || []) {
      if (b?.type !== 'tool_use') continue;
      this.#setOwner(b.id, agent || msg.parent_tool_use_id || 'main');
    }
  }

  #setOwner(toolUseId, actor) {
    if (this.owners.has(toolUseId)) return;
    this.owners.set(toolUseId, actor);
    const waiting = this.ownerWaits.get(toolUseId);
    if (waiting) { this.ownerWaits.delete(toolUseId); waiting(actor); }
  }

  // Which agent is behind this browser call. The permission callback has
  // already said so in every mode but full bypass; otherwise wait briefly for
  // the assistant message that announces the call, then give up and assume the
  // main thread rather than hold the browser hostage.
  async #actorFor(extra) {
    const id = extra?._meta?.['claudecode/toolUseId'];
    if (!id) return { id: 'main', label: 'the main thread' };
    if (!this.owners.has(id)) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { this.ownerWaits.delete(id); resolve(); }, OWNER_WAIT);
        this.ownerWaits.set(id, () => { clearTimeout(timer); resolve(); });
      });
    }
    return this.#actor(this.owners.get(id) || 'main');
  }

  #actor(agentId) {
    const task = this.tasks.get(agentId);
    if (!task) return { id: 'main', label: 'the main thread' };
    return { id: agentId, label: task.description || task.type, type: task.type, toolUseId: task.toolUseId };
  }

  // `agentID` is the subagent's id, the same value task_started calls task_id,
  // so a permission card can say which agent is asking. `title` and
  // `displayName` are the CLI's own wording for the prompt.
  #permission(name, input, { suggestions, agentID, title, displayName, toolUseID } = {}) {
    if (agentID && toolUseID) this.#setOwner(toolUseID, agentID);
    const verdict = decide(this.mode, name, input);
    if (verdict.action === 'allow') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const from = agentID ? this.#actor(agentID) : null;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, input, suggestions, tool: name });
      this.emit('permission', {
        id, tool: name, input, reason: verdict.reason, title, displayName,
        agent: from && from.id !== 'main' ? from : null,
      });
    });
  }

  // Stopping one agent rather than the whole turn, and handing a blocking one
  // to the background so the turn can carry on without it.
  async stopTask(taskId) {
    try { await this.query?.stopTask(taskId); return { ok: true }; } catch (e) {
      return { error: e?.message || String(e) };
    }
  }

  async background(toolUseId) {
    try { return { ok: await this.query?.backgroundTasks(toolUseId) }; } catch (e) {
      return { error: e?.message || String(e) };
    }
  }

  // `input` is how an answer gets back to a tool that asked for one:
  // AskUserQuestion reads its own answers off the input it is handed.
  decide(id, decision, input) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    const updatedInput = input && typeof input === 'object' ? input : entry.input;
    if (decision === 'allow') entry.resolve({ behavior: 'allow', updatedInput });
    else if (decision === 'always') {
      entry.resolve({ behavior: 'allow', updatedInput, updatedPermissions: entry.suggestions });
    } else entry.resolve({ behavior: 'deny', message: 'The human declined this action.' });

    // Approving the plan is how the SDK leaves plan mode. It does not tell us,
    // so the composer would go on claiming Plan while writes sailed through.
    if (entry.tool === 'ExitPlanMode' && decision !== 'deny' && this.mode === 'plan') {
      this.mode = 'ask';
      this.permissionMode = SDK_MODE.ask;
      this.emit('mode', { mode: this.mode });
    }
    return true;
  }

  // `images` is what the human attached: base64 already, because the model can
  // only look at a picture whose bytes came with the message.
  send(text, images) {
    this.busy = true;
    if (this.preface) { text = `${this.preface}\n\n${text}`; this.preface = null; }
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

  // What /context prints, as data rather than a markdown table: how the window
  // is spent, by category. Only a live session knows it, so a parked chat has
  // none and the panel falls back to the level without the composition.
  async contextUsage() {
    if (!this.query) return { error: "this chat has no live session" };
    try {
      return await this.query.getContextUsage() ?? null;
    } catch (e) {
      // Swallowing this once cost an afternoon of guessing why the panel was
      // blank. Whatever went wrong, say so where it can be read.
      return { error: e?.message || String(e) };
    }
  }

  // What /usage shows: session totals, and on a subscription the share of the
  // five-hour and weekly windows already spent. The SDK marks this one
  // experimental in its own name, so a CLI without it just answers null.
  async planUsage() {
    try {
      const fn = this.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      return typeof fn === 'function' ? await fn.call(this.query) : null;
    } catch (e) { return { error: e?.message || String(e) }; }
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

  // Takes one of our seven, not one of the SDK's four.
  async setMode(mode) {
    if (!isMode(mode)) return this.mode;
    const was = this.mode;
    this.mode = mode;
    this.permissionMode = SDK_MODE[mode];
    // Said once on the way in rather than stapled to every message, so a long
    // debugging session does not pay for it on every turn.
    if (mode === 'debug' && was !== 'debug') this.preface = DEBUG_PREFACE;
    if (mode !== 'debug') this.preface = null;
    try { await this.query?.setPermissionMode(this.permissionMode); } catch {}
    return this.mode;
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
