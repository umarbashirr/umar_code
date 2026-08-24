import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const pba = () => window.pba;

const uid = (p) => `${p}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// Drop the [preview element] / [attached …] preamble the composer adds, and
// leave what the human actually typed. Exported because the composer shows the
// same thing on a queued message.
export const spoken = (t) => String(t).replace(/^(\[(?:preview element|attached [a-z]+)\][\s\S]*?\n\n)+/, '');

// One conversation. `key` is ours and outlives the session under it: a chat
// parked while idle keeps its transcript here and is resumed on the next
// message, so switching chats never interrupts one that is working.
const blankChat = () => ({
  key: uid('c'),
  session: null,
  title: 'New chat',
  items: [],
  busy: false,
  queued: [],
  mode: 'ask',
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
  // block.
  const streams = useRef(new Map());
  const streamOf = useCallback((key) => {
    let st = streams.current.get(key);
    if (!st) { st = { id: null, pending: '', raf: 0, seen: new Set() }; streams.current.set(key, st); }
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

  const flushStream = useCallback((key) => {
    const st = streamOf(key);
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

  const appendStream = useCallback((key, text) => {
    const st = streamOf(key);
    st.pending += text;
    if (!st.raf) st.raf = requestAnimationFrame(() => flushStream(key));
  }, [flushStream, streamOf]);

  useEffect(() => {
    const offs = [];

    offs.push(pba().agent.onMessage(({ chat, msg }) => {
      if (!chat || !msg) return;
      const st = streamOf(chat);

      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
          flushStream(chat);
          const id = uid('a');
          st.id = id;
          push(chat, { id, kind: 'assistant', text: '', streaming: true });
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && st.id) {
          appendStream(chat, ev.delta.text);
        } else if (ev?.type === 'content_block_stop' && st.id) {
          // Land the tail before the block closes, or the last few tokens of
          // every message go missing.
          flushStream(chat);
          patch(chat, st.id, { streaming: false });
          st.id = null;
        }
        return;
      }

      if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use') {
            push(chat, { id: b.id, kind: 'tool', name: b.name, input: b.input, state: 'input-available' });
          } else if (b.type === 'text' && !st.id) {
            // Only render text that did not already arrive as deltas.
            const key = (b.text || '').slice(0, 80);
            if (!st.seen.has(key)) {
              // Guards one turn against a duplicate, so it does not need to
              // remember the whole conversation.
              if (st.seen.size >= 200) st.seen.clear();
              st.seen.add(key);
              push(chat, { id: uid('t'), kind: 'assistant', text: b.text });
            }
          }
        }
        return;
      }

      if (msg.type === 'user') {
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          patch(chat, b.tool_use_id, {
            state: b.is_error ? 'output-error' : 'output-available',
            output: b.content,
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
          items: [...c.items, {
            id: uid('r'),
            kind: 'note',
            error: !!failed,
            text: failed ? `turn ended: ${msg.subtype} ${secs}` : `done in ${secs}`,
          }],
        }));
        window.pbaRail?.refresh();
      }
    }));

    offs.push(pba().agent.onReady(({ chat, sessionId, model: m, mode: sessionMode }) => {
      if (!chat) return;
      edit(chat, (c) => ({
        ...c,
        session: sessionId || c.session,
        // One of ours, not one of the SDK's four: the session is the one
        // holding the answer after a resume.
        mode: sessionMode || c.mode,
      }));
      if (m) setModel((cur) => cur || m);
      if (chat === activeRef.current) window.pbaRail?.setCurrent(sessionId);
      window.pbaRail?.refresh();
    }));

    offs.push(pba().agent.onPermission(({ chat, ...p }) => push(chat, { ...p, id: p.id, kind: 'perm' })));

    // The session can move the mode on its own: approving a plan leaves plan
    // mode whether or not anyone touched the picker.
    offs.push(pba().agent.onMode?.(({ chat, mode: m }) => edit(chat, (c) => ({ ...c, mode: m }))) ?? (() => {}));

    offs.push(pba().agent.onDecided?.(({ chat, id, decision }) =>
      patch(chat || activeRef.current, id, { decided: decision })) ?? (() => {}));

    offs.push(pba().agent.onError(({ chat, error }) => {
      edit(chat || activeRef.current, (c) => ({
        ...c,
        busy: false,
        items: [...c.items, { id: uid('e'), kind: 'note', error: true, text: `agent error: ${error}` }],
      }));
    }));

    // A session ending is not the chat ending: a parked chat is stopped on
    // purpose and its transcript stays on screen.
    offs.push(pba().agent.onClosed(({ chat } = {}) => {
      if (chat) edit(chat, (c) => ({ ...c, busy: false }));
    }));

    // `pba ask` from the terminal can open a chat too.
    offs.push(pba().agent.onEcho?.(({ chat, text }) => {
      const key = chat || activeRef.current;
      edit(key, (c) => ({ ...c, busy: true, items: [...c.items, { id: uid('u'), kind: 'user', text }] }));
      if (!chatsRef.current.find((c) => c.key === key)?.session) window.pbaRail?.begin(text);
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
      setDriver({ installed: d.installed, version: d.version, message: d.message });
      if (!d.models?.length) return setModels([]);
      setModels(d.models);
      setModel((cur) => cur || d.current || d.models[0].value);
    };
    pba().agent.models().then(apply).catch(() => {});
    // The probe finishes after the first paint on a cold cache.
    return pba().agent.onDriver?.((d) => apply({ ...d, current: null })) ?? undefined;
  }, []);

  const active = useMemo(
    () => chats.find((c) => c.key === activeKey) || chats[0],
    [chats, activeKey],
  );

  // The main process routes `pba ask` at whatever is on screen.
  useEffect(() => {
    pba().agent.active?.(activeKey, active?.session || null);
  }, [activeKey, active?.session]);

  // The rail draws a working badge on every chat with a turn in flight, which
  // is the only way to tell a background chat is still going.
  useEffect(() => {
    const working = chats.filter((c) => c.busy);
    window.pbaRail?.setBusy?.(working.map((c) => c.session).filter(Boolean), working.some((c) => !c.session));
  }, [chats]);

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
    // The rail reads chats off disk and claude has not written this one yet, so
    // give it the first message to show until the transcript catches up.
    if (!chat?.session && key === activeRef.current) window.pbaRail?.begin(said);
    try {
      await pba().agent.send(key, chat?.session || null, text, images);
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
    pba().agent.decide(key, id, decision, input);
    // answers, when there are any, so the settled card can show what was picked
    patch(key, id, { decided: decision, answers: input?.answers });
  }, [patch]);

  // Stopping the turn also empties the queue, and the parked text is handed
  // back to the caller so the composer can put it where the user left it.
  const interrupt = useCallback(async () => {
    const key = activeRef.current;
    const parked = (chatsRef.current.find((c) => c.key === key)?.queued || []).map((m) => m.text);
    edit(key, (c) => ({ ...c, queued: [], busy: false, items: [...c.items, { id: uid('i'), kind: 'note', text: 'interrupted' }] }));
    await pba().agent.interrupt(key);
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
      pba().agent.reset(prev.key).catch(() => {});
    }
  }, []);

  // New chat. Nothing is stopped and nothing is thrown away; a chat that was
  // never used is reused rather than piling up empties.
  const reset = useCallback(async () => {
    const cur = chatsRef.current.find((c) => c.key === activeRef.current);
    if (cur && !cur.items.length && !cur.session) {
      window.pbaRail?.setCurrent(null);
      return;
    }
    const next = blankChat();
    setChats((all) => [...all, next]);
    switchTo(next.key);
    window.pbaRail?.setCurrent(null);
  }, [switchTo]);

  // Open a stored chat. One already in memory is just brought forward, live
  // turn and all. One off disk is replayed here and resumed on the next
  // message, so clicking through the rail costs nothing.
  const open = useCallback(async (s) => {
    const known = chatsRef.current.find((c) => c.session === s.id);
    if (known) {
      switchTo(known.key);
      window.pbaRail?.setCurrent(s.id);
      return;
    }

    const chat = { ...blankChat(), session: s.id, title: s.title.slice(0, 80) };
    setChats((all) => [...all, chat]);
    switchTo(chat.key);
    window.pbaRail?.setCurrent(s.id);

    try {
      const t = await pba().agent.transcript(s.id);
      const next = [];
      if (t.truncated) {
        next.push({ id: 'trim', kind: 'note', text: `earlier messages trimmed, showing the last ${t.messages.length}` });
      }
      for (const m of t.messages) {
        const content = m.message?.content;
        if (typeof content === 'string') {
          if (m.type === 'user') next.push({ id: `h${next.length}`, kind: 'user', text: strip(content) });
          continue;
        }
        if (!Array.isArray(content)) continue;

        if (m.type === 'assistant') {
          for (const b of content) {
            if (b.type === 'tool_use') next.push({ id: b.id, kind: 'tool', name: b.name, input: b.input, state: 'output-available' });
            else if (b.type === 'text' && b.text?.trim()) next.push({ id: `h${next.length}`, kind: 'assistant', text: b.text });
          }
          continue;
        }
        const said = strip(content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n'));
        if (said) next.push({ id: `h${next.length}`, kind: 'user', text: said });
        for (const b of content) {
          if (b.type === 'tool_result') {
            const i = next.findIndex((n) => n.id === b.tool_use_id);
            if (i >= 0) next[i] = { ...next[i], state: b.is_error ? 'output-error' : 'output-available', output: b.content };
          }
        }
      }
      edit(chat.key, (c) => ({ ...c, items: next }));
    } catch (e) {
      push(chat.key, { id: uid('e'), kind: 'note', error: true, text: `could not open that chat: ${e.message}` });
    }
  }, [edit, push, switchTo]);

  const changeModel = useCallback(async (value) => {
    setModel(value);
    await pba().agent.setModel(value);
  }, []);

  const changeMode = useCallback(async (value) => {
    const key = activeRef.current;
    edit(key, (c) => ({ ...c, mode: value }));
    await pba().agent.mode(key, value);
  }, [edit]);

  return {
    items: active.items,
    busy: active.busy,
    session: active.session,
    title: active.title,
    mode: active.mode,
    queued: active.queued,
    models, model, driver,
    chats, activeKey,
    send, enqueue, unqueue, flushQueue,
    decide, interrupt, reset, open, switchTo, changeModel, changeMode,
  };
}
