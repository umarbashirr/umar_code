import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { blankUsage, totals, withRequest, withResult } from '@/lib/usage';

const tandem = () => window.tandem;

const uid = (p) => `${p}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// Drop the [preview element] / [attached …] preamble the composer adds, and
// leave what the human actually typed. Exported because the composer shows the
// same thing on a queued message.
export const spoken = (t) => String(t).replace(/^(\[(?:preview element|attached [a-z]+)\][\s\S]*?\n\n)+/, '');

// Stored messages back into items. Used for a whole chat and again for one
// subagent's transcript, where `parent` is the Agent row they belong under.
function replay(messages, parent) {
  const out = [];
  const own = parent ? `${parent}:` : 'h';
  for (const m of messages) {
    const content = m.message?.content;
    const base = parent ? { parent } : {};
    if (typeof content === 'string') {
      if (m.type === 'user' && !parent) out.push({ id: `${own}${out.length}`, kind: 'user', text: strip(content), ...base });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.type === 'assistant') {
      for (const b of content) {
        if (b.type === 'tool_use') out.push({ id: b.id, kind: 'tool', name: b.name, input: b.input, state: 'output-available', ...base });
        else if (b.type === 'text' && b.text?.trim()) out.push({ id: `${own}${out.length}`, kind: 'assistant', text: b.text, ...base });
      }
      continue;
    }
    const said = strip(content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n'));
    // A subagent's first user message is the prompt it was handed, which its
    // row already shows. Its later ones are tool results.
    if (said && !parent) out.push({ id: `${own}${out.length}`, kind: 'user', text: said, ...base });
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const i = out.findIndex((n) => n.id === b.tool_use_id);
      if (i < 0) continue;
      out[i] = {
        ...out[i],
        state: b.is_error ? 'output-error' : 'output-available',
        output: b.content,
        // What the Agent call recorded about itself: counts, timing, and the
        // report, all straight from the stored result.
        ...(m.agent ? {
          kind: 'agent',
          agentId: m.agent.id,
          agentType: m.agent.type,
          status: m.agent.status === 'completed' ? 'done' : m.agent.status,
          tools: m.agent.tools,
          ms: m.agent.ms,
          tokens: m.agent.tokens,
          stats: m.agent.stats,
        } : {}),
      };
    }
  }
  return out;
}

// One conversation. `key` is ours and outlives the session under it: a chat
// parked while idle keeps its transcript here and is resumed on the next
// message, so switching chats never interrupts one that is working.
// Items stay one flat list even though subagents nest. An item spawned inside
// an agent carries that agent's Agent-call id as `parent`, and the tree is put
// back together at render time. Patching a tool result by id then works the
// same whoever ran it.
/* The conversation so far, as something the other CLI can read. A fork cannot
   hand over a thread, so it hands over the transcript: neither CLI can open the
   other's, and the new model starting from nothing is the thing a fork exists
   to avoid.

   Everything said goes across. Both sides of it, and every tool call by name
   and argument, because "I ran this and then that" is most of what a coding
   conversation is and a handover missing it reads as a summary of itself.

   The two caps below are the only things dropped, and both are announced in the
   text where they bite rather than silently.

   OUTPUT is per tool result. One `cat` of a large file or one verbose build log
   can be bigger than everything else combined, and it is also the most stale
   thing in the transcript: the new model is about to run its own commands
   against a tree that may have moved on. So the head of each result goes and
   the rest is marked.

   TOTAL is the backstop against a chat that will not fit in any window. It is
   set against real context windows rather than caution: 400k characters is
   roughly 100k tokens, which leaves room in a 200k window for the reply and the
   work after it. Trimming takes from the front, because a follow-up is nearly
   always about the recent end. */
const OUTPUT = 4000;
const TOTAL = 400000;

const clip = (text, n) => {
  const str = typeof text === 'string' ? text : JSON.stringify(text ?? null);
  if (!str || str.length <= n) return str || '';
  return `${str.slice(0, n)}\n… ${str.length - n} more characters of output, not carried over`;
};

function carriedHistory(items) {
  const lines = [];
  for (const it of items) {
    if (it.kind === 'user') lines.push(`Me:\n${it.text}`);
    else if (it.kind === 'assistant' && it.text?.trim()) lines.push(`Other assistant:\n${it.text}`);
    else if (it.kind === 'tool') {
      const args = clip(it.input, OUTPUT);
      const out = it.output === undefined ? '' : `\nResult:\n${clip(it.output, OUTPUT)}`;
      lines.push(`Other assistant ran ${it.name}:\n${args}${out}`);
    }
  }

  let body = lines.join('\n\n');
  const cut = body.length > TOTAL;
  if (cut) body = body.slice(-TOTAL);

  return [
    '<handover>',
    cut
      ? 'A conversation I was having with a different coding assistant. It was too long to carry whole, so this is the end of it:'
      : 'A conversation I was having with a different coding assistant, in full:',
    body,
    '</handover>',
    'Pick it up from here. Anything above is what the other assistant said, not something you did,',
    'and its tool output may be out of date. Read the files yourself before relying on any of it.',
  ].join('\n');
}

const blankChat = (project = null, provider = 'claude') => ({
  key: uid('c'),
  // Which CLI this chat runs on. Fixed once it sends: a thread belongs to the
  // binary that made it and no switch can carry it across. See changeModel.
  provider,
  // The folder this chat runs in. A chat keeps it for life: you can open a
  // second project, read it, come back, and this one is still working where it
  // started. Null only until the window has told us which folders are open.
  project,
  session: null,
  title: 'New chat',
  items: [],
  busy: false,
  // When the turn on this chat started, so the header can count it. Per chat,
  // because the fleet runs several at once and switching chats mid-turn must
  // not hand the other one's clock to this one.
  startedAt: 0,
  queued: [],
  mode: 'ask',
  // task id -> Agent tool_use id. The live-task feed talks in task ids and
  // everything else talks in tool_use ids.
  tasks: {},
  // What this chat has spent, kept per chat because the fleet runs several at
  // once and one shared counter would blend them.
  usage: blankUsage(),
});

// Everything the panel shows is derived from the SDK message stream. This hook
// turns that stream into a flat list of items per chat, and hands back the
// actions the composer needs for whichever chat is on screen.
export function useAgent() {
  // Which folder a chat started now would belong to. Read through a ref because
  // the IPC listeners are registered once and would otherwise close over the
  // project that was focused on the first render.
  const focusedProject = useRef(null);
  useEffect(() => {
    const apply = (info) => {
      const dir = info?.focused || info?.dir || null;
      focusedProject.current = dir;
      // The window opens with a chat in it before it knows which folders it
      // has, so that first chat is rooted by the first answer and not by
      // whichever folder happens to be focused when it is finally used.
      if (dir) setChats((all) => (all.some((c) => !c.project)
        ? all.map((c) => (c.project ? c : { ...c, project: dir }))
        : all));

      // A folder that has been closed takes its chats with it. Main has already
      // stopped their sessions; what is left is the copies here, and a chat
      // pointing at a folder the window no longer holds has nowhere to send.
      const dirs = new Set((info?.projects || []).map((p) => p.dir));
      if (dirs.size) dropChatsOutside(dirs, dir);
    };
    tandem().project.info().then(apply).catch(() => {});
    return tandem().project.onChanged(apply);
  }, []);

  // Declared before the effect above runs, and reading its state through the
  // refs, so it does not have to be a dependency of anything.
  const dropChatsOutside = (dirs, fallback) => {
    const all = chatsRef.current;
    const keep = all.filter((c) => !c.project || dirs.has(c.project));
    if (keep.length === all.length) return;

    const gone = new Set(all.filter((c) => !keep.includes(c)).map((c) => c.key));
    for (const [k, st] of streams.current) {
      if (!gone.has(k.split('\0')[0])) continue;
      if (st.raf) cancelAnimationFrame(st.raf);
      streams.current.delete(k);
    }

    const next = keep.length ? keep : [blankChat(fallback)];
    chatsRef.current = next;
    setChats(next);
    if (!next.some((c) => c.key === activeRef.current)) {
      activeRef.current = next[0].key;
      setActiveKey(next[0].key);
    }
  };

  const first = useRef(null);
  if (!first.current) first.current = blankChat();
  const [chats, setChats] = useState(() => [first.current]);
  const [activeKey, setActiveKey] = useState(first.current.key);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [driver, setDriver] = useState(null);
  // Which CLI the panel is driving. Kept beside the model list because the two
  // move together: switching provider replaces the list under the picker.
  const [provider, setProvider] = useState('claude');
  // Both CLIs and whether each is installed, so the picker can draw a locked
  // row for one that is missing instead of leaving it off the list.
  const [providers, setProviders] = useState([]);
  // How hard the model thinks, and which levels this build of the CLI takes.
  // Empty means the CLI's own default rather than a level we picked for it.
  const [effort, setEffort] = useState('');
  const [efforts, setEfforts] = useState([]);
  // Whether the chosen model is the long-context half of a pair, and whether it
  // has one at all. Haiku does not.
  const [longContext, setLongContext] = useState({ on: false, capable: false });

  // Read inside the IPC listeners, which are registered once and would
  // otherwise close over the first render's chats.
  const chatsRef = useRef(chats);
  const activeRef = useRef(activeKey);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  // Same reason: the callbacks that open a new chat are memoised on other
  // things and would otherwise hand it the CLI that was picked on first render.
  const providerRef = useRef(provider);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { activeRef.current = activeKey; }, [activeKey]);

  // Text deltas arrive per token, and two chats can be streaming at once, so
  // each keeps its own buffer: the block being written to, the chunk waiting
  // for the next frame, and the text already rendered from a non-streamed
  // block. A subagent streams alongside the thread that spawned it, so the
  // buffer is per chat and per agent, not per chat.
  const streams = useRef(new Map());
  const streamKey = (chat, parent) => `${chat}\0${parent || ''}`;
  const streamOf = useCallback((chat, parent) => {
    const k = streamKey(chat, parent);
    let st = streams.current.get(k);
    if (!st) { st = { id: null, pending: '', raf: 0, seen: new Set() }; streams.current.set(k, st); }
    return st;
  }, []);

  const edit = useCallback((key, fn) => {
    setChats((cur) => cur.map((c) => (c.key === key ? fn(c) : c)));
  }, []);

  const push = useCallback((key, item) => {
    edit(key, (c) => ({ ...c, items: [...c.items, item] }));
  }, [edit]);

  const patch = useCallback((key, id, changes) => {
    edit(key, (c) => ({ ...c, items: c.items.map((it) => (it.id === id ? { ...it, ...changes } : it)) }));
  }, [edit]);

  const flushStream = useCallback((key, parent) => {
    const st = streamOf(key, parent);
    st.raf = 0;
    const chunk = st.pending;
    const id = st.id;
    st.pending = '';
    if (!chunk || !id) return;
    edit(key, (c) => ({
      ...c,
      items: c.items.map((it) => (it.id === id ? { ...it, text: it.text + chunk } : it)),
    }));
  }, [edit, streamOf]);

  const appendStream = useCallback((key, parent, text) => {
    const st = streamOf(key, parent);
    st.pending += text;
    if (!st.raf) st.raf = requestAnimationFrame(() => flushStream(key, parent));
  }, [flushStream, streamOf]);

  useEffect(() => {
    const offs = [];

    offs.push(tandem().agent.onMessage(({ chat, msg }) => {
      if (!chat || !msg) return;
      // Everything a subagent does carries the Agent call that started it.
      const parent = msg.parent_tool_use_id || null;
      const st = streamOf(chat, parent);

      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
          flushStream(chat, parent);
          const id = uid('a');
          st.id = id;
          push(chat, { id, kind: 'assistant', text: '', streaming: true, parent });
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && st.id) {
          appendStream(chat, parent, ev.delta.text);
        } else if (ev?.type === 'content_block_stop' && st.id) {
          // Land the tail before the block closes, or the last few tokens of
          // every message go missing.
          flushStream(chat, parent);
          patch(chat, st.id, { streaming: false });
          st.id = null;
        }
        return;
      }

      // The live set of background work, sent whole every time it changes. Swap
      // for it rather than pairing start and stop events, so a missed edge
      // cannot leave a spinner running forever.
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        const live = new Set((msg.tasks || []).map((t) => t.task_id));
        edit(chat, (c) => ({
          ...c,
          items: c.items.map((it) => (it.kind === 'agent' && it.background && it.status === 'running' && it.taskId && !live.has(it.taskId)
            ? { ...it, status: 'done' }
            : it)),
        }));
        return;
      }

      // Compaction is the one moment the window empties out. Say so in the
      // transcript and drop the meter now rather than leaving it pinned until
      // the next reply arrives with a smaller request behind it.
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        const { pre_tokens: pre, post_tokens: post, trigger } = msg.compact_metadata || {};
        edit(chat, (c) => ({
          ...c,
          usage: post ? { ...c.usage, context: post } : c.usage,
          items: [...c.items, {
            id: uid('k'),
            kind: 'note',
            text: pre && post
              ? `context compacted, ${Math.round(pre / 1000)}k down to ${Math.round(post / 1000)}k`
              : `context compacted${trigger === 'manual' ? '' : ' automatically'}`,
          }],
        }));
        return;
      }

      if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_progress')) {
        const id = msg.tool_use_id;
        if (!id) return;
        edit(chat, (c) => ({
          ...c,
          tasks: { ...c.tasks, [msg.task_id]: id },
          items: c.items.map((it) => (it.id === id ? {
            ...it,
            kind: 'agent',
            taskId: msg.task_id,
            agentType: msg.subagent_type || it.agentType || 'agent',
            // Only what it was asked to do, which does not change. Progress
            // messages carry a live "Running <whatever>" line instead, and
            // letting that win makes the row rename itself every few seconds.
            description: msg.subtype === 'task_started'
              ? (msg.description || it.description)
              : it.description,
            status: 'running',
            background: msg.subtype === 'task_started' ? !!msg.is_backgrounded : it.background,
            depth: msg.spawn_depth || it.depth || 1,
            tools: msg.usage?.tool_uses ?? it.tools ?? 0,
            ms: msg.usage?.duration_ms ?? it.ms ?? 0,
            lastTool: msg.last_tool_name || it.lastTool || null,
          } : it)),
        }));
        return;
      }

      if (msg.type === 'system' && msg.subtype === 'task_notification') {
        const chatNow = chatsRef.current.find((c) => c.key === chat);
        const id = msg.tool_use_id || chatNow?.tasks[msg.task_id];
        if (!id) return;
        patch(chat, id, {
          kind: 'agent',
          status: msg.status === 'completed' ? 'done' : msg.status,
          summary: msg.summary || null,
          tools: msg.usage?.tool_uses ?? undefined,
          ms: msg.usage?.duration_ms ?? undefined,
        });
        return;
      }

      if (msg.type === 'assistant') {
        // How full the window is, which is the size of the request this reply
        // came back from. A subagent has a window of its own, so only the main
        // thread says anything about this conversation.
        if (!parent && msg.message?.usage) {
          edit(chat, (c) => ({ ...c, usage: withRequest(c.usage, msg.message.usage) }));
        }
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use') {
            // An Agent call is a container, not a step: its own rows arrive
            // later carrying its id as their parent.
            const agent = b.name === 'Agent' || b.name === 'Task';
            push(chat, {
              id: b.id,
              kind: agent ? 'agent' : 'tool',
              name: b.name,
              input: b.input,
              state: 'input-available',
              parent,
              // When the call went out. An agent needed this for its elapsed
              // line; a plain tool row needs it too, because a Bash step that
              // takes a minute is the most common reason the screen looks
              // frozen and the row had no way to say how long it had been out.
              at: Date.now(),
              ...(agent ? {
                agentType: b.input?.subagent_type || 'agent',
                description: b.input?.description || '',
                status: 'running',
                tools: 0,
                ms: 0,
              } : {}),
            });
          } else if (b.type === 'text' && !st.id) {
            // Only render text that did not already arrive as deltas.
            const key = (b.text || '').slice(0, 80);
            if (!st.seen.has(key)) {
              // Guards one turn against a duplicate, so it does not need to
              // remember the whole conversation.
              if (st.seen.size >= 200) st.seen.clear();
              st.seen.add(key);
              push(chat, { id: uid('t'), kind: 'assistant', text: b.text, parent });
            }
          }
        }
        return;
      }

      if (msg.type === 'user') {
        // The structured result of an Agent call: what it did, in numbers, plus
        // the report itself. Better than parsing it back out of the text.
        const done = msg.tool_use_result;
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          const extra = done?.agentId && done.status === 'completed' ? {
            kind: 'agent',
            status: 'done',
            tools: done.totalToolUseCount ?? undefined,
            ms: done.totalDurationMs ?? undefined,
            tokens: done.totalTokens ?? undefined,
            stats: done.toolStats || null,
            report: (done.content || []).map((p) => p.text || '').join('\n').trim() || null,
          } : done?.status === 'async_launched' ? { kind: 'agent', background: true, status: 'running' } : null;
          patch(chat, b.tool_use_id, {
            state: b.is_error ? 'output-error' : 'output-available',
            output: b.content,
            ...(extra || {}),
          });
        }
        return;
      }

      if (msg.type === 'result') {
        const secs = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
        const failed = msg.subtype && msg.subtype !== 'success';
        edit(chat, (c) => ({
          ...c,
          busy: false,
          usage: withResult(c.usage, msg),
          // A blocking agent cannot outlive the turn that was waiting on it. If
          // its notification went missing, the turn ending says the same thing,
          // and a row that spins forever is worse than one that stops early.
          items: [...c.items.map((it) => (it.kind === 'agent' && it.status === 'running' && !it.background
            ? { ...it, status: 'done' }
            : it)), {
            id: uid('r'),
            kind: 'note',
            error: !!failed,
            text: failed ? `turn ended: ${msg.subtype} ${secs}` : `done in ${secs}`,
          }],
        }));
        window.tandemRail?.refresh();
      }
    }));

    offs.push(tandem().agent.onReady(({ chat, sessionId, model: m, mode: sessionMode }) => {
      if (!chat) return;
      edit(chat, (c) => ({
        ...c,
        session: sessionId || c.session,
        // One of ours, not one of the SDK's four: the session is the one
        // holding the answer after a resume.
        mode: sessionMode || c.mode,
        // Which model the window size and the prices are read against.
        usage: m ? { ...c.usage, model: m } : c.usage,
      }));
      if (m) setModel((cur) => cur || m);
      window.tandemRail?.refresh();
    }));

    // A permission card stays at the bottom of the transcript, because it is
    // blocking the whole chat wherever it came from. `agent` says who asked, so
    // it does not read as the main thread when it was a subagent.
    offs.push(tandem().agent.onPermission(({ chat, ...p }) => {
      push(chat, { ...p, id: p.id, kind: 'perm' });
      if (p.agent?.toolUseId) patch(chat, p.agent.toolUseId, { waiting: true });
    }));

    // The session can move the mode on its own: approving a plan leaves plan
    // mode whether or not anyone touched the picker.
    offs.push(tandem().agent.onMode?.(({ chat, mode: m }) => edit(chat, (c) => ({ ...c, mode: m }))) ?? (() => {}));

    offs.push(tandem().agent.onDecided?.(({ chat, id, decision }) =>
      patch(chat || activeRef.current, id, { decided: decision })) ?? (() => {}));

    offs.push(tandem().agent.onError(({ chat, error }) => {
      edit(chat || activeRef.current, (c) => ({
        ...c,
        busy: false,
        items: [...c.items, { id: uid('e'), kind: 'note', error: true, text: `agent error: ${error}` }],
      }));
    }));

    // A session ending is not the chat ending: a parked chat is stopped on
    // purpose and its transcript stays on screen.
    offs.push(tandem().agent.onClosed(({ chat } = {}) => {
      if (chat) edit(chat, (c) => ({ ...c, busy: false }));
    }));

    // `tandem ask` from the terminal can open a chat too.
    offs.push(tandem().agent.onEcho?.(({ chat, text }) => {
      const key = chat || activeRef.current;
      edit(key, (c) => ({
        ...c,
        busy: true,
        startedAt: c.busy ? c.startedAt : Date.now(),
        // Same as a message typed here: the first one names the chat, which is
        // what the rail shows until claude has written a transcript to read.
        title: c.title === 'New chat' ? spoken(text).slice(0, 80) : c.title,
        items: [...c.items, { id: uid('u'), kind: 'user', text }],
      }));
    }) ?? (() => {}));

    return () => {
      offs.forEach((off) => { try { off?.(); } catch {} });
      for (const st of streams.current.values()) if (st.raf) cancelAnimationFrame(st.raf);
    };
  }, [push, patch, edit, appendStream, flushStream, streamOf]);

  // The model list comes from the driver cache, not from a live session: asking
  // the SDK would spawn the agent binary just to draw a dropdown.
  useEffect(() => {
    const apply = (d) => {
      if (!d) return;
      setDriver({
        installed: d.installed, version: d.version, message: d.message,
        endpoint: d.endpoint, binaryPath: d.binaryPath || null,
      });
      if (d.providers?.length) setProviders(d.providers);
      if (d.provider) {
        setProvider(d.provider);
        // The chat on screen at first paint was built before main had said which
        // CLI it prefers. One that has said nothing yet still belongs to nobody,
        // so it follows; one with a transcript keeps what it has.
        setChats((cur) => cur.map((c) => (c.items.length || c.session
          ? c
          : { ...c, provider: d.provider })));
      }
      if (d.efforts?.length) setEfforts(d.efforts);
      if (typeof d.effort === 'string') setEffort(d.effort);
      if (typeof d.long === 'boolean') setLongContext({ on: d.long, capable: !!d.longCapable });
      if (!d.models?.length) return setModels([]);
      setModels(d.models);
      // Left empty when nothing has been chosen, so the picker says "Pick a
      // model" instead of naming one the main process never received.
      setModel((cur) => cur || d.current || '');
    };
    tandem().agent.models().then(apply).catch(() => {});
    // The probe finishes after the first paint on a cold cache, and on that
    // first run it carries the choice main settled on once it had a list.
    return tandem().agent.onDriver?.(apply) ?? undefined;
  }, []);

  const active = useMemo(
    () => chats.find((c) => c.key === activeKey) || chats[0],
    [chats, activeKey],
  );

  // Back into a tree for drawing. Items keep their arrival order inside each
  // agent, so a nested run reads top to bottom the way it happened, and an
  // agent that spawned its own agents nests again.
  const tree = useMemo(() => {
    const kids = new Map();
    for (const it of active.items) {
      if (!it.parent) continue;
      const list = kids.get(it.parent) || [];
      list.push(it);
      kids.set(it.parent, list);
    }
    const build = (item) => (item.kind === 'agent'
      ? { ...item, children: (kids.get(item.id) || []).map(build) }
      : item);
    return active.items.filter((it) => !it.parent).map(build);
  }, [active.items]);

  const usage = useMemo(() => totals(active.usage), [active.usage]);

  // Every agent still going, at any depth. The strip above the composer is the
  // only thing that says a background agent exists once the transcript has
  // scrolled past the row that started it.
  const running = useMemo(
    () => active.items.filter((it) => it.kind === 'agent' && it.status === 'running'),
    [active.items],
  );

  // The main process routes `tandem ask` at whatever is on screen.
  useEffect(() => {
    tandem().agent.active?.(activeKey, active?.session || null);
  }, [activeKey, active?.session]);

  // The rail is the only view of a chat that is not on screen, so it gets the
  // whole set: the ones claude has not written to disk yet, which one you are
  // looking at, which are mid-turn, and how many agents are under each. It used
  // to get a single "pending" chat and a list of busy ids, and a second new
  // chat, or clicking away from a new one, dropped the first one's row until
  // its transcript reached disk.
  useEffect(() => {
    window.tandemRail?.sync?.({
      active: activeKey,
      // A chat nobody has typed in is not a chat yet.
      chats: chats.filter((c) => c.session || c.items.length).map((c) => ({
        key: c.key,
        project: c.project || focusedProject.current,
        session: c.session,
        title: c.title,
        busy: c.busy,
        agents: c.items.filter((it) => it.kind === 'agent' && it.status === 'running').length,
      })),
    });
  }, [chats, activeKey]);

  const sendTo = useCallback(async (key, text, images = []) => {
    if (!text.trim()) return;
    const chat = chatsRef.current.find((c) => c.key === key);
    // The bubble and the chat title show what was typed. The attachment
    // preamble is for the agent, and repeating it back at the human turns every
    // message with a picture on it into a wall of paths.
    const said = spoken(text);
    edit(key, (c) => ({
      ...c,
      // A message handed to a turn already running joins that turn's clock.
      // Only a turn starting from idle resets it.
      startedAt: c.busy ? c.startedAt : Date.now(),
      busy: true,
      title: c.title === 'New chat' ? said.slice(0, 80) : c.title,
      items: [...c.items, { id: uid('u'), kind: 'user', text: said, images }],
    }));
    try {
      const res = await tandem().agent.send(
        key, chat?.session || null, text, images, chat?.project || focusedProject.current,
        chat?.provider || providerRef.current,
      );
      // A session that could not start says why. Worth printing as it stands:
      // it names the missing CLI, and prefixing it would only muddy that.
      if (res?.error) throw new Error(res.error, { cause: 'said' });
    } catch (e) {
      const said = e.cause === 'said';
      edit(key, (c) => ({
        ...c,
        busy: false,
        items: [...c.items, {
          id: uid('e'), kind: 'note', error: true,
          text: said ? e.message : `could not reach the agent: ${e.message}`,
        }],
      }));
    }
  }, [edit]);

  const send = useCallback((text, images = []) => sendTo(activeRef.current, text, images), [sendTo]);

  const enqueue = useCallback((text, images = []) => {
    if (!text.trim()) return;
    edit(activeRef.current, (c) => ({ ...c, queued: [...c.queued, { id: uid('q'), text, images }] }));
  }, [edit]);

  const unqueue = useCallback((id) => {
    edit(activeRef.current, (c) => ({ ...c, queued: c.queued.filter((m) => m.id !== id) }));
  }, [edit]);

  // Hand the parked messages over. Sent one at a time and in order: the CLI
  // takes a message mid-turn and folds it into the turn already running, which
  // is the whole point of the queue.
  const flushChat = useCallback(async (key) => {
    const chat = chatsRef.current.find((c) => c.key === key);
    if (!chat?.queued.length) return;
    edit(key, (c) => ({ ...c, queued: [] }));
    for (const m of chat.queued) await sendTo(key, m.text, m.images);
  }, [edit, sendTo]);

  const flushQueue = useCallback(() => flushChat(activeRef.current), [flushChat]);

  // Whatever is still parked when a chat goes idle goes out on its own, so a
  // queue nobody flushed does not sit there forever. Background chats included.
  useEffect(() => {
    for (const c of chats) if (!c.busy && c.queued.length) flushChat(c.key);
  }, [chats, flushChat]);

  const decide = useCallback((id, decision, input) => {
    const key = activeRef.current;
    tandem().agent.decide(key, id, decision, input);
    // answers, when there are any, so the settled card can show what was picked
    patch(key, id, { decided: decision, answers: input?.answers });
    // The agent that asked is no longer stuck on us.
    const card = chatsRef.current.find((c) => c.key === key)?.items.find((it) => it.id === id);
    if (card?.agent?.toolUseId) patch(key, card.agent.toolUseId, { waiting: false });
  }, [patch]);

  // Stopping one agent rather than the whole turn. Everything else in flight
  // carries on, which is the point of stopping just this one.
  const stopAgent = useCallback(async (item) => {
    const key = activeRef.current;
    if (!item?.taskId) return;
    patch(key, item.id, { status: 'stopping' });
    const res = await tandem().agent.stopTask(key, item.taskId);
    patch(key, item.id, res?.error ? { status: 'running' } : { status: 'stopped' });
  }, [patch]);

  // Hand a blocking agent to the background so the turn stops waiting on it.
  const backgroundAgent = useCallback(async (item) => {
    const key = activeRef.current;
    if (!item?.id) return;
    const res = await tandem().agent.background(key, item.id);
    if (res?.ok) patch(key, item.id, { background: true });
  }, [patch]);

  // A replayed chat draws its agent rows from the meta files and only reads a
  // transcript when someone opens one. Loaded once, then kept.
  const openAgent = useCallback(async (item) => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    if (!chat?.session || !item?.agentId || item.loaded) return;
    patch(key, item.id, { loaded: 'loading' });
    try {
      const t = await tandem().agent.subagent(chat.session, item.agentId);
      const kids = replay(t.messages, item.id);
      edit(key, (c) => ({ ...c, items: [...c.items, ...kids] }));
      patch(key, item.id, { loaded: true });
    } catch (e) {
      patch(key, item.id, { loaded: true, report: item.report || `could not read that agent's transcript: ${e.message}` });
    }
  }, [edit, patch]);

  // Stopping the turn also empties the queue, and the parked text is handed
  // back to the caller so the composer can put it where the user left it.
  const interrupt = useCallback(async () => {
    const key = activeRef.current;
    const parked = (chatsRef.current.find((c) => c.key === key)?.queued || []).map((m) => m.text);
    edit(key, (c) => ({ ...c, queued: [], busy: false, items: [...c.items, { id: uid('i'), kind: 'note', text: 'interrupted' }] }));
    await tandem().agent.interrupt(key);
    return parked;
  }, [edit]);

  // Moving to another chat. A chat nobody is waiting on does not need a process
  // sitting behind it: the transcript stays here and the next message resumes
  // it. A chat that is working is left alone, which is the point.
  const switchTo = useCallback((key) => {
    const prev = chatsRef.current.find((c) => c.key === activeRef.current);
    activeRef.current = key;
    setActiveKey(key);
    // Each chat runs on its own CLI, so the picker has to name that one rather
    // than whatever was last chosen somewhere else.
    const next = chatsRef.current.find((c) => c.key === key);
    if (next?.provider) setProvider(next.provider);
    if (next?.usage?.model) setModel(next.usage.model);
    if (prev && prev.key !== key && !prev.busy && prev.session) {
      tandem().agent.reset(prev.key).catch(() => {});
    }
  }, []);

  // New chat, in the folder you are looking at unless the caller names another:
  // the rail's per-folder button starts a chat in that folder without dragging
  // the rest of the window over to it. A blank chat in the right folder is
  // reused rather than piling up empties; one in another folder is not, because
  // its folder is the thing you asked for.
  const reset = useCallback(async (project = null) => {
    const dir = project || focusedProject.current;
    const cur = chatsRef.current.find((c) => c.key === activeRef.current);
    if (cur && !cur.items.length && !cur.session && (cur.project || dir) === dir) return;
    const next = blankChat(dir, providerRef.current);
    setChats((all) => [...all, next]);
    switchTo(next.key);
  }, [switchTo]);

  /* Pointing the chat on screen at another folder, which is what the chip under
     the box is for. A chat nobody has typed in yet moves: the chip names the
     folder the next message runs in, and picking one from it is how you say
     where you meant that message to go. A chat that has already said something
     stays where it ran, transcript and session and all, so picking a folder for
     one of those starts a new chat there instead of dragging the old one over. */
  const setProject = useCallback((dir) => {
    if (!dir) return;
    const cur = chatsRef.current.find((c) => c.key === activeRef.current);
    if (cur && !cur.session && !cur.items.length) edit(cur.key, (c) => ({ ...c, project: dir }));
    else reset(dir);
  }, [edit, reset]);

  // The folder moved. Main has already stopped every session, and the chats
  // here belong to the folder that was open when they ran.
  const clear = useCallback(() => {
    for (const st of streams.current.values()) if (st.raf) cancelAnimationFrame(st.raf);
    streams.current.clear();
    const next = blankChat(focusedProject.current, providerRef.current);
    setChats([next]);
    activeRef.current = next.key;
    setActiveKey(next.key);
    window.tandemRail?.refresh();
  }, []);

  // Deleting a chat, from the rail or from anywhere else that has a row. Two
  // halves, and a chat can be either or both: the transcript on disk, which is
  // what the rail lists and what `claude --resume` offers, and the copy in
  // memory with its process behind it. A chat that was never written to disk
  // has no session id and only the second half applies.
  const removeChat = useCallback(async (row) => {
    const key = row.key || null;
    // rows() names a chat with no session by its key, so id and key matching is
    // how a chat that never reached disk says it has nothing to delete there.
    const session = row.id && row.id !== key ? row.id : null;

    if (session) {
      const res = await tandem().agent.deleteSession(session, row.project).catch((e) => ({ error: e.message }));
      if (res?.error) return res;
    } else if (key) {
      // No transcript to remove, so the process is ours to stop. (With one,
      // main stops it before the unlink.)
      await tandem().agent.reset(key).catch(() => {});
    }

    if (key) {
      for (const [k, st] of streams.current) {
        if (!k.startsWith(`${key}\0`)) continue;
        if (st.raf) cancelAnimationFrame(st.raf);
        streams.current.delete(k);
      }

      const all = chatsRef.current;
      const at = all.findIndex((c) => c.key === key);
      const rest = all.filter((c) => c.key !== key);
      // Deleting the last chat leaves the pane on a blank one rather than on
      // nothing at all.
      const next = rest.length ? rest : [blankChat(focusedProject.current, providerRef.current)];
      chatsRef.current = next;
      setChats(next);
      if (activeRef.current === key) {
        // The row that took its place, or the one above it if it was last.
        const land = next[Math.min(at, next.length - 1)];
        activeRef.current = land.key;
        setActiveKey(land.key);
      }
    }

    window.tandemRail?.refresh();
    return { ok: true };
  }, []);

  // Open a stored chat. One already in memory is just brought forward, live
  // turn and all. One off disk is replayed here and resumed on the next
  // message, so clicking through the rail costs nothing.
  const open = useCallback(async (s) => {
    // A row for a chat that is already open here names it by our key: it may
    // have no session id yet, and two new chats would both match on null.
    // Opening a chat moves the window to its folder: the files, the changes and
    // the shells beside it should be the ones that chat is talking about.
    if (s.project && s.project !== focusedProject.current) {
      tandem().project.focus(s.project).catch(() => {});
    }

    const known = chatsRef.current.find((c) => (s.key ? c.key === s.key : c.session === s.id));
    if (known) return switchTo(known.key);

    const chat = {
      ...blankChat(s.project || focusedProject.current, s.provider || providerRef.current),
      session: s.id,
      title: s.title.slice(0, 80),
    };
    setChats((all) => [...all, chat]);
    switchTo(chat.key);

    try {
      const t = await tandem().agent.transcript(s.id, chat.project);
      const next = [];
      if (t.truncated) {
        next.push({ id: 'trim', kind: 'note', text: `earlier messages trimmed, showing the last ${t.messages.length}` });
      }
      next.push(...replay(t.messages, null));
      // The agents that ran are named in their own meta files, which is how a
      // replayed row knows its type and where to find its transcript. Their
      // rows draw folded and read nothing until opened.
      const byToolUse = new Map((t.subagents || []).map((a) => [a.toolUseId, a]));
      for (let i = 0; i < next.length; i++) {
        const meta = byToolUse.get(next[i].id);
        if (!meta) continue;
        next[i] = {
          ...next[i],
          kind: 'agent',
          agentId: meta.id,
          agentType: meta.type,
          description: meta.description || next[i].input?.description || '',
          depth: meta.depth,
          status: 'done',
          loaded: false,
        };
      }
      edit(chat.key, (c) => ({ ...c, items: next }));
    } catch (e) {
      push(chat.key, { id: uid('e'), kind: 'note', error: true, text: `could not open that chat: ${e.message}` });
    }
  }, [edit, push, switchTo]);

  /* Changing how hard the model thinks. The CLI takes this when a session
     starts and has no setter for it, so main parks the idle chats and the next
     message on each resumes its transcript at the new level. A chat mid-turn
     keeps the level it started on rather than having the session pulled out
     from under it. */
  const changeEffort = useCallback(async (value) => {
    const next = value === effort ? '' : value;
    setEffort(next);
    const res = await tandem().agent.setEffort(next).catch(() => null);
    if (res && typeof res.effort === 'string') setEffort(res.effort);
  }, [effort]);

  // The long window is a different name for the same model, so this swaps the
  // name and the picker follows.
  const changeLongContext = useCallback(async (on) => {
    setLongContext((cur) => ({ ...cur, on }));
    const res = await tandem().agent.setLongContext(on).catch(() => null);
    if (res?.error) return setLongContext((cur) => ({ ...cur, on: !on }));
    if (res?.model) {
      // The list comes back with the switched-to name on it. Without that the
      // picker has a value it cannot find and falls back to its placeholder,
      // which reads as nothing being selected at all.
      if (res.models?.length) setModels(res.models);
      setModel(res.model);
      setLongContext({ on: !!res.long, capable: true });
    }
  }, []);

  /* Picking a model, and sometimes forking because of it.
     The list holds both CLIs. Crossing from one to the other is fine on a chat
     that has said nothing, and impossible on one that has: the conversation
     lives inside a thread only its own CLI can open. So a chat with messages
     forks. The old one is left exactly as it was, still on its own CLI, and the
     new one opens with the conversation carried over as text. */
  const changeModel = useCallback(async (value) => {
    const chat = chatsRef.current.find((c) => c.key === activeRef.current);
    const want = models.find((m) => m.value === value)?.provider;
    const crossing = want && chat?.provider && want !== chat.provider;

    if (crossing && chat.items.length) {
      const next = { ...blankChat(chat.project, want), title: chat.title };
      setChats((all) => [...all, next]);
      switchTo(next.key);
      setModel(value);
      setProvider(want);
      const res = await tandem().agent.setModel(value);
      if (res?.models?.length) setModels(res.models);
      if (typeof res?.long === 'boolean') setLongContext({ on: res.long, capable: !!res.longCapable });
      sendTo(next.key, carriedHistory(chat.items));
      return;
    }

    setModel(value);
    if (want) setProvider(want);
    // Every chat follows the picker, and the window and prices follow with it.
    setChats((cur) => cur.map((c) => (c.key === activeRef.current || !c.items.length
      ? { ...c, ...(want ? { provider: want } : {}), usage: { ...c.usage, model: value, window: 0 } }
      : c)));
    // A name typed by hand comes back as part of the list, so the picker has it
    // the next time it opens rather than only while it is selected.
    const res = await tandem().agent.setModel(value);
    if (res?.models?.length) setModels(res.models);
    if (res?.provider) setProvider(res.provider);
    if (typeof res?.long === 'boolean') setLongContext({ on: res.long, capable: !!res.longCapable });
  }, [models, switchTo, sendTo]);

  // Drops a hand-typed name. The main process answers with what is left and
  // which of those the picker should land on.
  const forgetModel = useCallback(async (value) => {
    const res = await tandem().agent.forgetModel?.(value);
    if (!res) return;
    if (res.models?.length) setModels(res.models);
    if (res.model) {
      setModel(res.model);
      setChats((cur) => cur.map((c) => ({ ...c, usage: { ...c.usage, model: res.model, window: 0 } })));
    }
  }, []);

  /* Switching CLI. The model has to move with it or the picker keeps showing
     the last one's name over the new one's list, and the first message would go
     out asking codex for a claude model. Main answers with both. */
  const changeProvider = useCallback(async (value) => {
    const res = await tandem().agent.setProvider?.(value);
    if (!res) return;
    setProvider(res.provider);
    setModels(res.models || []);
    setModel(res.current || '');
    setChats((cur) => cur.map((c) => ({ ...c, usage: { ...c.usage, model: res.current || '', window: 0 } })));
  }, []);

  const changeMode = useCallback(async (value) => {
    const key = activeRef.current;
    edit(key, (c) => ({ ...c, mode: value }));
    await tandem().agent.mode(key, value);
  }, [edit]);

  return {
    items: tree,
    running,
    busy: active.busy,
    startedAt: active.startedAt || 0,
    session: active.session,
    // The folder the chat on screen runs in, which is not always the focused
    // one: you can read a chat in another project without moving the window.
    project: active.project || null,
    title: active.title,
    mode: active.mode,
    queued: active.queued,
    usage,
    models, model, driver, provider, providers, effort, efforts, longContext,
    chats, activeKey,
    send, enqueue, unqueue, flushQueue,
    decide, interrupt, reset, setProject, clear, open, removeChat, switchTo, changeModel, forgetModel,
    changeProvider, changeMode,
    changeEffort, changeLongContext,
    stopAgent, backgroundAgent, openAgent,
  };
}
