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
const blankChat = () => ({
  key: uid('c'),
  session: null,
  title: 'New chat',
  items: [],
  busy: false,
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
  const first = useRef(null);
  if (!first.current) first.current = blankChat();
  const [chats, setChats] = useState(() => [first.current]);
  const [activeKey, setActiveKey] = useState(first.current.key);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [driver, setDriver] = useState(null);

  // Read inside the IPC listeners, which are registered once and would
  // otherwise close over the first render's chats.
  const chatsRef = useRef(chats);
  const activeRef = useRef(activeKey);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
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
              ...(agent ? {
                agentType: b.input?.subagent_type || 'agent',
                description: b.input?.description || '',
                status: 'running',
                tools: 0,
                ms: 0,
                at: Date.now(),
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
      setDriver({ installed: d.installed, version: d.version, message: d.message, endpoint: d.endpoint });
      if (!d.models?.length) return setModels([]);
      setModels(d.models);
      setModel((cur) => cur || d.current || d.models[0].value);
    };
    tandem().agent.models().then(apply).catch(() => {});
    // The probe finishes after the first paint on a cold cache.
    return tandem().agent.onDriver?.((d) => apply({ ...d, current: null })) ?? undefined;
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
      busy: true,
      title: c.title === 'New chat' ? said.slice(0, 80) : c.title,
      items: [...c.items, { id: uid('u'), kind: 'user', text: said, images }],
    }));
    try {
      await tandem().agent.send(key, chat?.session || null, text, images);
    } catch (e) {
      edit(key, (c) => ({
        ...c,
        busy: false,
        items: [...c.items, { id: uid('e'), kind: 'note', error: true, text: `could not reach the agent: ${e.message}` }],
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
    if (prev && prev.key !== key && !prev.busy && prev.session) {
      tandem().agent.reset(prev.key).catch(() => {});
    }
  }, []);

  // New chat. Nothing is stopped and nothing is thrown away; a chat that was
  // never used is reused rather than piling up empties.
  const reset = useCallback(async () => {
    const cur = chatsRef.current.find((c) => c.key === activeRef.current);
    if (cur && !cur.items.length && !cur.session) return;
    const next = blankChat();
    setChats((all) => [...all, next]);
    switchTo(next.key);
  }, [switchTo]);

  // The folder moved. Main has already stopped every session, and the chats
  // here belong to the folder that was open when they ran.
  const clear = useCallback(() => {
    for (const st of streams.current.values()) if (st.raf) cancelAnimationFrame(st.raf);
    streams.current.clear();
    const next = blankChat();
    setChats([next]);
    activeRef.current = next.key;
    setActiveKey(next.key);
    window.tandemRail?.refresh();
  }, []);

  // Open a stored chat. One already in memory is just brought forward, live
  // turn and all. One off disk is replayed here and resumed on the next
  // message, so clicking through the rail costs nothing.
  const open = useCallback(async (s) => {
    // A row for a chat that is already open here names it by our key: it may
    // have no session id yet, and two new chats would both match on null.
    const known = chatsRef.current.find((c) => (s.key ? c.key === s.key : c.session === s.id));
    if (known) return switchTo(known.key);

    const chat = { ...blankChat(), session: s.id, title: s.title.slice(0, 80) };
    setChats((all) => [...all, chat]);
    switchTo(chat.key);

    try {
      const t = await tandem().agent.transcript(s.id);
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

  const changeModel = useCallback(async (value) => {
    setModel(value);
    // Every chat follows the picker, and the window and prices follow with it.
    setChats((cur) => cur.map((c) => ({ ...c, usage: { ...c.usage, model: value, window: 0 } })));
    // A name typed by hand comes back as part of the list, so the picker has it
    // the next time it opens rather than only while it is selected.
    const res = await tandem().agent.setModel(value);
    if (res?.models?.length) setModels(res.models);
  }, []);

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

  const changeMode = useCallback(async (value) => {
    const key = activeRef.current;
    edit(key, (c) => ({ ...c, mode: value }));
    await tandem().agent.mode(key, value);
  }, [edit]);

  return {
    items: tree,
    running,
    busy: active.busy,
    session: active.session,
    title: active.title,
    mode: active.mode,
    queued: active.queued,
    usage,
    models, model, driver,
    chats, activeKey,
    send, enqueue, unqueue, flushQueue,
    decide, interrupt, reset, clear, open, switchTo, changeModel, forgetModel, changeMode,
    stopAgent, backgroundAgent, openAgent,
  };
}
