'use strict';
/* A chat backed by codex instead of claude.
 *
 * Same outward contract as AgentSession: the seven events index.js listens for,
 * and send/interrupt/decide/setModel/setMode/stop. The panel never learns which
 * one it is talking to.
 *
 * Inside, the two are nothing alike. claude comes through the Agent SDK, which
 * hands us messages already in the shape the renderer parses. codex speaks its
 * own JSON-RPC and thinks in thread items, so everything below #emit is a
 * translation: codex items in, claude-shaped messages out. That choice is worth
 * naming because it is load-bearing. It buys the whole renderer, the transcript
 * components and the tool rows for free, and it costs us anything codex can say
 * that claude cannot. Reasoning summaries, thread sections and review mode all
 * flatten or fall on the floor here. When one of them starts mattering this is
 * the file that has to grow a real event shape.
 *
 * The preview browser is not built in the way it is for claude. codex reads MCP
 * servers from config, and Tandem already ships one that reaches the pane over
 * the bridge, so the tools arrive the ordinary way. See mcp/server.js.
 */
const path = require('path');
const { EventEmitter } = require('events');
const { AppServer } = require('./codex-rpc');
const { codexBinary, CLIENT } = require('./codex-driver');
const { INSTRUCTIONS } = require('../shared/browser-tools');
const { CODEX_MODE, DEFAULT_MODE, isMode, decideCodex, DEBUG_PREFACE } = require('./modes');
const shellEnv = require('./shell-env');

const ROOT = path.join(__dirname, '..', '..');

/* Approval requests, old names and new. codex kept the flat ones working while
   the item/* shapes took over, and which pair a build sends depends on its
   version, so both are answered. `family` is which vocabulary the answer has to
   be written in, and they are not the same three words: the item/* pair says
   accept, the flat pair says approved, and a permissions request is not a yes
   or no at all but a profile handed back.

   Getting this wrong fails quietly, which is why it is a table rather than a
   guess. codex logs a deserialize error to stderr, the tool call dies with
   "approval request failed", and the turn carries on as though nobody had
   answered. */
const APPROVALS = {
  'item/commandExecution/requestApproval': { tool: 'Bash', family: 'item' },
  'item/fileChange/requestApproval': { tool: 'Edit', family: 'item' },
  execCommandApproval: { tool: 'Bash', family: 'flat' },
  applyPatchApproval: { tool: 'Edit', family: 'flat' },
  'item/permissions/requestApproval': { tool: 'Permissions', family: 'grant' },
};

const ANSWER = {
  item: {
    allow: () => ({ decision: 'accept' }),
    always: () => ({ decision: 'acceptForSession' }),
    deny: () => ({ decision: 'decline' }),
  },
  flat: {
    allow: () => ({ decision: 'approved' }),
    always: () => ({ decision: 'approved_for_session' }),
    deny: () => ({ decision: { denied: { rejection: 'The human declined this action.' } } }),
  },
  // Widening the sandbox rather than allowing one call. Approving hands back
  // the profile that was asked for; declining hands back an empty one, which
  // grants nothing and lets the turn carry on.
  grant: {
    allow: (params) => ({ permissions: params.permissions || {}, scope: 'turn' }),
    always: (params) => ({ permissions: params.permissions || {}, scope: 'session' }),
    deny: () => ({ permissions: {} }),
  },
};

/* codex says the sandbox twice, in two vocabularies. thread/start takes the
   plain mode name, turn/start takes a policy object, and the turn is the only
   one of the two that can be moved once the thread exists. So the mode switcher
   only means anything mid-chat if the policy goes out with the turn.

   writableRoots is spelled out rather than left empty because an empty one is
   the ambiguous case: the workspace this session is for is the cwd, and saying
   so costs nothing and cannot be read two ways. */
const SANDBOX_POLICY = {
  'read-only': () => ({ type: 'readOnly' }),
  'workspace-write': (cwd) => ({ type: 'workspaceWrite', writableRoots: [cwd] }),
  'danger-full-access': () => ({ type: 'dangerFullAccess' }),
};

// How a codex thread item is named once it reaches the panel. The names on the
// right are claude's, because that is what the tool rows in the transcript know
// how to draw.
const TOOL_NAME = {
  commandExecution: 'Bash',
  fileChange: 'Edit',
  webSearch: 'WebSearch',
  imageView: 'Read',
  sleep: 'Bash',
};

const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2));

/* What the session is told about the preview pane. claude gets the same words
   appended to its system prompt; codex takes them on thread/start.
 *
 * Two things are said here that claude never needs to hear. codex namespaces
 * every MCP tool as mcp__<server>__<tool>, so the bare names in INSTRUCTIONS
 * match nothing it can call. And codex ships a bundled `browser` skill that
 * drives ChatGPT's own in-app browser, which is not the window on screen: left
 * to itself the model reads "browser" in that skill's description, follows it,
 * and reports back that the browser is not connected while Tandem's pane sits
 * there waiting. Naming ours and saying which one is on screen is the whole
 * fix. */
const CODEX_INSTRUCTIONS = [
  INSTRUCTIONS.replace(/\bbrowser_/g, 'mcp__tandem__browser_'),
  'These mcp__tandem__ tools drive the preview pane inside this app, which is the browser the human is looking at.',
  'Use them for anything to do with a page. Any other browser tool or skill you have drives a different window that nobody can see.',
].join(' ');

class CodexSession extends EventEmitter {
  constructor({ cwd, resume, model, mode, effort, bridgeEnv }) {
    super();
    this.cwd = cwd;
    this.resume = resume || null;
    this.model = model || null;
    this.effort = effort || null;
    this.bridgeEnv = bridgeEnv || {};
    this.mode = isMode(mode) ? mode : DEFAULT_MODE;
    this.preface = this.mode === 'debug' ? DEBUG_PREFACE : null;

    this.closed = false;
    this.busy = false;
    this.sessionId = null;        // codex calls it a thread; the panel calls it a session
    this.turnId = null;
    this.rpc = null;
    this.pending = new Map();     // permission id -> { respond, input, tool }
    this.open = new Set();        // agentMessage item ids with a text block open
    this.edits = new Map();       // fileChange item id -> its changes, for the dialog
    this.usage = null;            // last thread/tokenUsage/updated, thread totals
    this.window = 0;              // how many tokens this model's window holds
    this.limits = null;           // last account/rateLimits/updated
    this.startedAt = 0;
    this.starting = null;         // the turn/start still in flight, if there is one
    // What codex is set to right now, which is not always what the mode says.
    // #policy() below is what closes the gap.
    this.applied = { sandbox: null, approvalPolicy: null };
  }

  async start() {
    await shellEnv.ready();
    const bin = codexBinary();
    if (!bin) throw new Error('No codex on your PATH. Install the Codex CLI, then open a new chat.');
    this.emit('stderr', `using codex binary at ${bin}\n`);

    const { sandbox, approvalPolicy } = CODEX_MODE[this.mode];

    this.rpc = new AppServer({ bin, cwd: this.cwd, config: this.#config() });
    this.rpc.on('stderr', (d) => this.emit('stderr', d));
    this.rpc.on('notification', (m, p) => this.#note(m, p));
    this.rpc.on('request', (m, p, respond) => this.#ask(m, p, respond));
    this.rpc.on('closed', (why) => {
      if (!this.closed) this.emit('error', why);
      this.closed = true;
      this.busy = false;
      this.emit('closed');
    });

    // The one experimental thing we opt into. Without it codex never offers the
    // model a question tool, so it writes its questions out as prose and there
    // is nothing to click. Opting in exposes more of the protocol rather than
    // destabilising what we already use, and if codex ever stops sending these
    // the model falls back to prose on its own. See #question.
    await this.rpc.start({ clientInfo: CLIENT, capabilities: { experimentalApi: true } });

    const params = {
      cwd: this.cwd,
      sandbox,
      approvalPolicy,
      // Additive, unlike baseInstructions, which would replace the whole prompt
      // codex builds for itself and take its own tools with it.
      developerInstructions: CODEX_INSTRUCTIONS,
      ...(this.model ? { model: this.model } : {}),
    };
    const res = this.resume
      ? await this.rpc.request('thread/resume', { ...params, threadId: this.resume })
      : await this.rpc.request('thread/start', params);

    this.applied = { sandbox, approvalPolicy };
    this.sessionId = res?.thread?.id || null;
    this.model = res?.model || this.model;
    this.emit('ready', { sessionId: this.sessionId, model: this.model, mode: this.mode });
    return this;
  }

  /* Everything codex cannot be told through the protocol. The preview tools are
     the only entry that matters: codex spawns this server itself, so it needs
     the bridge's address and token in its own environment rather than ours. */
  #config() {
    const server = path.join(ROOT, 'mcp', 'server.js');
    const env = { ...this.bridgeEnv, TANDEM_CWD: this.cwd };
    // Values are parsed as TOML. A JSON string and a TOML string are the same
    // thing and so are the arrays, but a JSON object is not a TOML table, so
    // the environment goes in one dotted key per variable rather than whole.
    const out = [
      `mcp_servers.tandem.command=${JSON.stringify(process.env.TANDEM_NODE || 'node')}`,
      `mcp_servers.tandem.args=${JSON.stringify([server])}`,
      /* The question tool. Off by default in codex 0.150.1, which is why a codex
         chat used to answer "ask me something" with a numbered list and a
         "reply with 1, 2 or 3" rather than the card claude gets. Set per session
         rather than written to the person's config.toml: it is how Tandem wants
         to run codex, not a change to how their codex runs. */
      'features.default_mode_request_user_input=true',
    ];
    for (const [k, v] of Object.entries(env)) {
      if (v != null) out.push(`mcp_servers.tandem.env.${k}=${JSON.stringify(String(v))}`);
    }
    return out;
  }

  // --- what the panel calls -------------------------------------------------

  send(textIn, images = []) {
    const body = this.preface ? `${this.preface}\n\n${textIn}` : textIn;
    this.preface = null;

    // Pictures ahead of the words, for the reason blocks() gives on the claude
    // side: a prompt that refers back to a picture the model has already seen
    // lands better than one that arrives first.
    const input = [];
    for (const img of images || []) {
      // Two shapes and only these two. A data url is the one form that needs no
      // file on disk, and a picture that does have one goes as localImage so
      // codex reads the bytes itself: a file:// url is passed through to the API
      // untouched and comes back a 400 for an image_url of an invalid format.
      if (img?.data) input.push({ type: 'image', url: `data:${img.media || img.mediaType || 'image/png'};base64,${img.data}` });
      else if (img?.path) input.push({ type: 'localImage', path: img.path });
    }
    input.push({ type: 'text', text: body });

    this.#emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: body }] },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });

    if (this.busy) this.#steer(input);
    else this.#start(input);
  }

  #start(input) {
    this.busy = true;
    this.startedAt = Date.now();
    this.starting = this.rpc?.request('turn/start', {
      threadId: this.sessionId,
      input,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...this.#policy(),
    });
    this.starting?.then((res) => { this.turnId = res?.turn?.id || null; })
      .catch((e) => {
        this.busy = false;
        this.emit('error', e?.message || String(e));
      });
  }

  /* A message typed while a turn is running. codex folds it into that turn,
     which is what the composer's queue was written against, but only if it is
     told which turn: expectedTurnId is required, and a steer without it is
     refused outright. That refusal is the whole reason this is not two lines.
     There is nothing on screen for a message that never arrived, so a steer
     that cannot land turns into a turn of its own instead. */
  async #steer(input) {
    try {
      const turnId = this.turnId || (await this.starting)?.turn?.id;
      if (!turnId) throw new Error('no turn to steer');
      await this.rpc.request('turn/steer', { threadId: this.sessionId, expectedTurnId: turnId, input });
    } catch {
      // Nearly always the turn ending between the human hitting enter and this
      // reaching codex, and what they meant by it does not change.
      this.#start(input);
    }
  }

  /* The sandbox and the approval policy this turn should run under, sent only
     when they are not what codex already has. Both are set at thread/start and
     an override on a turn sticks for the turns after it, so sending the
     difference is enough, and sending nothing while the mode has not moved
     leaves a config.toml that tunes workspace-write with its say. */
  #policy() {
    const { sandbox, approvalPolicy } = CODEX_MODE[this.mode];
    const out = {};
    if (sandbox !== this.applied.sandbox && SANDBOX_POLICY[sandbox]) {
      out.sandboxPolicy = SANDBOX_POLICY[sandbox](this.cwd);
      this.applied.sandbox = sandbox;
    }
    if (approvalPolicy !== this.applied.approvalPolicy) {
      out.approvalPolicy = approvalPolicy;
      this.applied.approvalPolicy = approvalPolicy;
    }
    return out;
  }

  /* Stopping is the one thing that has to work on the first press, and codex
     will only stop a turn it is given the id of. Pressed before turn/start has
     answered there is no id yet, so this waits for the one thing that has it.
     Nothing is emitted here: codex answers the interrupt with turn/completed,
     status interrupted, and that is what ends the turn on screen. */
  async interrupt() {
    const turnId = this.turnId || (await this.starting?.catch(() => null))?.turn?.id;
    if (!turnId) return { ok: true };
    try {
      await this.rpc?.request('turn/interrupt', { threadId: this.sessionId, turnId });
    } catch {}
    return { ok: true };
  }

  // No thread-level setter, and none is needed: turn/start says the model and
  // codex keeps it for every turn after. So this lands on the next message.
  async setModel(model) {
    this.model = model || null;
    return { model: this.model };
  }

  async setMode(mode) {
    if (!isMode(mode)) return { mode: this.mode };
    this.mode = mode;
    this.preface = mode === 'debug' ? DEBUG_PREFACE : this.preface;
    this.emit('mode', { mode });
    return { mode };
  }

  // `input` is how an answer gets back from a question card: the panel returns
  // the whole tool input with `answers` filled in, the way claude's does.
  decide(id, decision, input) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const say = entry.answer[decision] || entry.answer.deny;
    const reply = say(entry.params, input);
    this.pending.delete(id);
    entry.respond(reply);
    return true;
  }

  /* The panel asks these of every session it holds, so every one has to exist
     or the handler behind it throws rather than drawing an empty panel. The
     model list comes from codex-driver, not from here, and the skills and MCP
     panels read protocol methods this cut does not. */
  async models() { return []; }

  async commands() { return []; }

  async mcpStatus() { return []; }

  /* The MCP and skills panels drive these on every live session. codex takes
     its servers from config.toml at start and has no runtime setter for any of
     it, so the honest answer is that the panel changed nothing. Saying so beats
     returning ok and letting someone believe a server went away. */
  async toggleMcp() { return { error: 'codex reads its MCP servers from config.toml' }; }

  async reconnectMcp() { return { error: 'codex reads its MCP servers from config.toml' }; }

  async addMcpServer() { return { error: 'codex reads its MCP servers from config.toml' }; }

  async removeMcpServer() { return { error: 'codex reads its MCP servers from config.toml' }; }

  async setConnectors() { return { error: 'codex has no connectors to switch' }; }

  async setSkillOverrides() { return { error: 'codex reads its skills from config.toml' }; }

  // No subagent tracking in this cut: codex reports subAgentActivity items that
  // nothing here reads yet, so there is never an id to look one up by.
  async subagent() { return null; }

  async stopTask() { return { ok: false }; }

  async background() { return { ok: false }; }

  /* What the meter draws. codex sends both of these unprompted while a turn
     runs, so this is the last thing it said rather than a fresh question.

     The popover wants a breakdown of the window by category, which is the one
     thing codex does not report: it counts the window as one number. Saying so
     in the field the panel reads for it puts a sentence where the breakdown
     would be, rather than leaving "the breakdown arrives once this chat is
     idle" up forever on a chat where it never will. */
  async contextUsage() {
    if (!this.usage) return null;
    return {
      input_tokens: this.usage.inputTokens || 0,
      output_tokens: this.usage.outputTokens || 0,
      cache_read_input_tokens: this.usage.cachedInputTokens || 0,
      total_tokens: this.usage.totalTokens || 0,
      error: 'codex counts the window as one total, with no breakdown behind it',
    };
  }

  async planUsage() {
    const r = this.limits;
    if (!r) return null;
    // The meter draws claude's five-hour and weekly windows, and codex names
    // the same two primary and secondary, so they line up without inventing a
    // third. resets_at is read with new Date(), and codex counts in seconds, so
    // a raw number here would land the reset in 1970 and show nothing.
    const win = (w) => (w ? {
      utilization: w.usedPercent ?? 0,
      resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
    } : null);
    return {
      subscription_type: r.planType || null,
      rate_limits: { five_hour: win(r.primary), seven_day: win(r.secondary) },
    };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.busy = false;
    this.rpc?.close();
  }

  // --- codex in, claude-shaped out ------------------------------------------

  #emit(msg) {
    this.emit('message', { ...msg, session_id: msg.session_id ?? (this.sessionId || '') });
  }

  #stream(event) {
    this.#emit({ type: 'stream_event', event, parent_tool_use_id: null });
  }

  #tool(id, name, input) {
    this.#emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      parent_tool_use_id: null,
    });
  }

  #result(id, content, isError) {
    this.#emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text(content), is_error: !!isError }],
      },
      parent_tool_use_id: null,
    });
  }

  #note(method, params) {
    if (method === 'item/agentMessage/delta') {
      const id = params.itemId;
      if (!id) return;
      if (!this.open.has(id)) {
        this.open.add(id);
        this.#stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      this.#stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: params.delta || '' } });
      return;
    }

    if (method === 'item/started') return this.#itemStarted(params.item || {});
    if (method === 'item/completed') return this.#itemDone(params.item || {});

    if (method === 'thread/tokenUsage/updated') {
      this.usage = params.tokenUsage?.total || null;
      this.window = params.tokenUsage?.modelContextWindow || this.window;
      // How full the window is, which the panel reads off the request an
      // assistant message came back from. Nothing to draw and everything to
      // count, so it goes out as a message with no content in it. Without this
      // the meter never appears at all on a codex chat: it hides itself until
      // something has been spent, and nothing else here says anything was.
      const last = params.tokenUsage?.last;
      if (last) {
        this.#emit({
          type: 'assistant',
          message: { role: 'assistant', content: [], usage: this.#apiUsage(last) },
          parent_tool_use_id: null,
        });
      }
      return;
    }

    if (method === 'account/rateLimits/updated') {
      this.limits = params.rateLimits || null;
      return;
    }

    if (method === 'turn/completed') return this.#turnDone(params.turn || {});

    /* A turn that went wrong says so twice: this, and then turn/completed with
       a status of failed. Only the second one ends the turn, so this says what
       happened and touches nothing else. Clearing busy here instead would let
       the next message start a turn while this one is still running, and a
       retryable error is not the end of anything at all. */
    if (method === 'error') {
      const why = params.error?.message || 'the turn failed';
      // A retry is not a failure yet, so it goes where the log goes rather than
      // putting a red card in the transcript for something codex went on to do.
      if (params.willRetry) this.emit('stderr', `codex is retrying after: ${why}\n`);
      else this.emit('error', why);
      return;
    }

    // Worth showing, not worth a transcript row of its own.
    if (method === 'warning' || method === 'configWarning') {
      this.emit('stderr', `${params.message || params.summary || ''}\n`);
    }
  }

  #itemStarted(item) {
    // Kept because the approval that follows a file change names the item and
    // says nothing about what is in it. See #askInput.
    if (item.type === 'fileChange') this.edits.set(item.id, item.changes || []);
    const name = TOOL_NAME[item.type];
    if (name) return this.#tool(item.id, name, this.#input(item));
    if (item.type === 'mcpToolCall') {
      return this.#tool(item.id, `mcp__${item.server}__${item.tool}`, item.arguments || {});
    }
  }

  #itemDone(item) {
    if (item.type === 'agentMessage') {
      if (this.open.has(item.id)) {
        this.open.delete(item.id);
        this.#stream({ type: 'content_block_stop', index: 0 });
      } else if (item.text) {
        // No deltas came for this one, so nothing is on screen yet. Happens on a
        // resumed thread and on short replies that arrive whole.
        this.#emit({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: item.text }] },
          parent_tool_use_id: null,
        });
      }
      return;
    }

    if (item.type === 'commandExecution') {
      return this.#result(item.id, item.aggregatedOutput ?? '', item.exitCode !== 0 && item.exitCode != null);
    }
    if (item.type === 'fileChange') {
      const files = (item.changes || []).map((c) => c.path || c.file || '').filter(Boolean);
      return this.#result(item.id, files.length ? files.join('\n') : (item.status || 'done'), item.status === 'failed');
    }
    if (item.type === 'mcpToolCall') {
      const out = item.error ? (item.error.message || 'the tool failed') : item.result;
      return this.#result(item.id, out ?? '', !!item.error);
    }
    if (TOOL_NAME[item.type]) return this.#result(item.id, item.status || 'done', false);
  }

  #turnDone(turn) {
    // A block still open means the last message never got its stop event, and
    // the renderer would leave that bubble spinning for the rest of the chat.
    for (const _ of this.open) this.#stream({ type: 'content_block_stop', index: 0 });
    this.open.clear();

    this.busy = false;
    this.turnId = null;
    this.starting = null;
    this.edits.clear();
    const failed = turn.status && turn.status !== 'completed';
    this.#emit({
      type: 'result',
      subtype: failed ? (turn.error?.message ? 'error' : turn.status) : 'success',
      duration_ms: turn.durationMs ?? (this.startedAt ? Date.now() - this.startedAt : 0),
      usage: this.usage ? this.#apiUsage(this.usage) : undefined,
      // What the panel actually accounts from, and it wants the running total
      // rather than this turn's share: it replaces its copy whole every time.
      // codex counts one model per thread, so there is one row.
      modelUsage: this.usage
        ? {
          [this.model || 'codex']: {
            inputTokens: Math.max(0, (this.usage.inputTokens || 0) - (this.usage.cachedInputTokens || 0)),
            outputTokens: this.usage.outputTokens || 0,
            cacheReadInputTokens: this.usage.cachedInputTokens || 0,
            cacheCreationInputTokens: this.usage.cacheWriteInputTokens || 0,
            contextWindow: this.window || 0,
          },
        }
        : undefined,
    });
  }

  // codex keeps cached tokens inside the input count and claude keeps them
  // beside it. Splitting them back apart is what stops the window reading as
  // half again as full as it is, and it is the same arithmetic in both places.
  #apiUsage(u) {
    return {
      input_tokens: Math.max(0, (u.inputTokens || 0) - (u.cachedInputTokens || 0)),
      output_tokens: u.outputTokens || 0,
      cache_read_input_tokens: u.cachedInputTokens || 0,
    };
  }

  #input(item) {
    if (item.type === 'commandExecution') return { command: item.command, description: item.cwd };
    if (item.type === 'fileChange') return { changes: item.changes };
    if (item.type === 'webSearch') return { query: item.query };
    return {};
  }

  // --- approvals ------------------------------------------------------------

  #ask(method, params, respond) {
    if (method === 'item/tool/requestUserInput') return this.#question(params, respond);

    const spec = APPROVALS[method];
    if (!spec) {
      // Something this build asks for that this cut does not know. Hanging is
      // the one unacceptable answer, so say so and let the turn move on.
      this.emit('stderr', `codex asked for ${method}, which Tandem does not handle yet\n`);
      return respond({});
    }

    const answer = ANSWER[spec.family];
    const input = this.#askInput(spec, params);
    const verdict = decideCodex(this.mode, spec.tool, input);
    if (verdict.action === 'allow') return respond(answer.allow(params));

    const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    this.pending.set(id, { respond, answer, params, input, tool: spec.tool });
    this.emit('permission', {
      id, tool: spec.tool, input, reason: params.reason || verdict.reason, agent: null,
    });
  }

  /* The agent asking the human something, which is not a permission whatever
     the transport says. The panel already draws this for claude's
     AskUserQuestion, so the two shapes are reconciled here rather than in a
     second card: codex names its options with a label and no value, keys its
     answers by a question id, and wants each answer as an array of strings.

     The id map is why this is not a pure function. The card answers by question
     text, because that is what claude's tool returns, and codex will only take
     the id it asked with. */
  #question(params, respond) {
    const asked = Array.isArray(params.questions) ? params.questions : [];
    if (!asked.length) return respond({ answers: {} });

    const ids = new Map();
    const questions = asked.map((q) => {
      ids.set(q.question, q.id);
      return {
        question: q.question,
        header: q.header,
        options: (q.options || []).map((o) => ({ label: o.label, value: o.label, description: o.description })),
        multiSelect: false,
      };
    });

    // The card hands back one string per question, comma-joined where it let
    // several be picked, so it is split apart again on the way out.
    const shape = (given) => ({
      answers: Object.fromEntries(
        Object.entries(given?.answers || {})
          .filter(([q]) => ids.has(q))
          .map(([q, a]) => [ids.get(q), { answers: String(a).split(',').map((v) => v.trim()).filter(Boolean) }]),
      ),
    });

    const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    this.pending.set(id, {
      respond,
      params,
      tool: 'AskUserQuestion',
      input: { questions },
      answer: { allow: (_p, g) => shape(g), always: (_p, g) => shape(g), deny: () => ({ answers: {} }) },
    });
    this.emit('permission', { id, tool: 'AskUserQuestion', input: { questions }, agent: null });
  }

  /* What the dialog shows. Enough to judge the call by, in the keys the panel's
     tool rows already read for the claude tool of the same name.

     A file change is the awkward one. Its approval carries an item id, a reason
     and nothing else, so the changes have to come from the item/started that
     announced them; without that the human is asked to approve an edit with no
     edit in front of them. */
  #askInput(spec, params) {
    if (spec.tool === 'Edit') {
      return { changes: this.edits.get(params.itemId) || params.changes || params.patch, root: params.grantRoot };
    }
    if (spec.tool === 'Permissions') return { permissions: params.permissions, cwd: params.cwd };
    return {
      command: Array.isArray(params.command) ? params.command.join(' ') : params.command,
      cwd: params.cwd,
    };
  }
}

module.exports = { CodexSession };
