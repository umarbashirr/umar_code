import { useCallback, useEffect, useRef, useState } from 'react';

const pba = () => window.pba;

// Everything the panel shows is derived from the SDK message stream. This hook
// turns that stream into a flat list of items the chat pane can render, and
// hands back the actions the composer needs.
export function useAgent() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(null);
  const [title, setTitle] = useState('New chat');
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('default');
  const [driver, setDriver] = useState(null);
  // Messages typed while a turn is running. They park here, in order, until
  // something hands them to the agent.
  const [queued, setQueued] = useState([]);

  // The streaming assistant block is addressed by id rather than by position:
  // tool rows can land between deltas.
  const streamId = useRef(null);
  const seenText = useRef(new Set());
  // Text deltas arrive per token. Committing each one rebuilt the whole item
  // array and re-rendered every message in the chat, so buffer them and flush
  // once a frame.
  const pendingText = useRef('');
  const flushing = useRef(0);
  // Read inside the IPC listeners, which are registered once and would
  // otherwise close over the first render's session.
  const sessionRef = useRef(null);
  // The queue is read inside callbacks that also write it, and the flush is
  // async, so the ref is the copy that is always current.
  const queuedRef = useRef([]);
  const setLiveSession = useCallback((id) => { sessionRef.current = id; setSession(id); }, []);

  const push = useCallback((item) => setItems((prev) => [...prev, item]), []);

  const flushStream = useCallback(() => {
    flushing.current = 0;
    const chunk = pendingText.current;
    const id = streamId.current;
    pendingText.current = '';
    if (!chunk || !id) return;
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, text: it.text + chunk } : it)));
  }, []);

  const appendStream = useCallback((text) => {
    pendingText.current += text;
    if (!flushing.current) flushing.current = requestAnimationFrame(flushStream);
  }, [flushStream]);

  const patch = useCallback((id, changes) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...changes } : it)));
  }, []);

  useEffect(() => {
    const offs = [];

    offs.push(pba().agent.onMessage((msg) => {
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
          flushStream();
          const id = `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
          streamId.current = id;
          push({ id, kind: 'assistant', text: '', streaming: true });
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && streamId.current) {
          appendStream(ev.delta.text);
        } else if (ev?.type === 'content_block_stop' && streamId.current) {
          // Land the tail before the block closes, or the last few tokens of
          // every message go missing.
          flushStream();
          patch(streamId.current, { streaming: false });
          streamId.current = null;
        }
        return;
      }

      if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use') {
            push({ id: b.id, kind: 'tool', name: b.name, input: b.input, state: 'input-available' });
          } else if (b.type === 'text' && !streamId.current) {
            // Only render text that did not already arrive as deltas.
            const key = (b.text || '').slice(0, 80);
            if (!seenText.current.has(key)) {
              // Guards one turn against a duplicate, so it does not need to
              // remember the whole conversation.
              if (seenText.current.size >= 200) seenText.current.clear();
              seenText.current.add(key);
              push({ id: `t${Date.now()}`, kind: 'assistant', text: b.text });
            }
          }
        }
        return;
      }

      if (msg.type === 'user') {
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          patch(b.tool_use_id, {
            state: b.is_error ? 'output-error' : 'output-available',
            output: b.content,
          });
        }
        return;
      }

      if (msg.type === 'result') {
        setBusy(false);
        const secs = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
        const failed = msg.subtype && msg.subtype !== 'success';
        push({
          id: `r${Date.now()}`,
          kind: 'note',
          error: !!failed,
          text: failed ? `turn ended: ${msg.subtype} ${secs}` : `done in ${secs}`,
        });
        window.pbaRail?.refresh();
      }
    }));

    offs.push(pba().agent.onReady(({ sessionId, model: m, permissionMode }) => {
      setLiveSession(sessionId);
      if (m) setModel((cur) => cur || m);
      if (permissionMode) setMode(permissionMode);
      window.pbaRail?.setCurrent(sessionId);
      window.pbaRail?.refresh();
    }));

    offs.push(pba().agent.onPermission((p) => push({ ...p, id: p.id, kind: 'perm' })));

    offs.push(pba().agent.onDecided?.(({ id, decision }) => patch(id, { decided: decision })) ?? (() => {}));

    offs.push(pba().agent.onError(({ error }) => {
      setBusy(false);
      push({ id: `e${Date.now()}`, kind: 'note', error: true, text: `agent error: ${error}` });
    }));

    offs.push(pba().agent.onClosed(() => setBusy(false)));

    // `pba ask` from the terminal can open a chat too.
    offs.push(pba().agent.onEcho?.((p) => {
      push({ id: `u${Date.now()}`, kind: 'user', text: p.text });
      if (!sessionRef.current) window.pbaRail?.begin(p.text);
      setBusy(true);
    }) ?? (() => {}));

    return () => {
      offs.forEach((off) => { try { off?.(); } catch {} });
      if (flushing.current) cancelAnimationFrame(flushing.current);
    };
  }, [push, patch, setLiveSession, appendStream, flushStream]);

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

  const send = useCallback(async (text, images = []) => {
    if (!text.trim()) return;
    // The bubble and the chat title show what was typed. The attachment
    // preamble is for the agent, and repeating it back at the human turns every
    // message with a picture on it into a wall of paths.
    const said = spoken(text);
    push({ id: uid('u'), kind: 'user', text: said, images });
    setTitle((t) => (t === 'New chat' ? said.slice(0, 80) : t));
    // The rail reads chats off disk and claude has not written this one yet, so
    // give it the first message to show until the transcript catches up.
    if (!sessionRef.current) window.pbaRail?.begin(said);
    setBusy(true);
    try {
      await pba().agent.send(text, images);
    } catch (e) {
      setBusy(false);
      push({ id: `e${Date.now()}`, kind: 'note', error: true, text: `could not reach the agent: ${e.message}` });
    }
  }, [push]);

  const enqueue = useCallback((text, images = []) => {
    if (!text.trim()) return;
    queuedRef.current = [...queuedRef.current, { id: uid('q'), text, images }];
    setQueued(queuedRef.current);
  }, []);

  const unqueue = useCallback((id) => {
    queuedRef.current = queuedRef.current.filter((m) => m.id !== id);
    setQueued(queuedRef.current);
  }, []);

  // Hand the parked messages over. Sent one at a time and in order: the CLI
  // takes a message mid-turn and folds it into the turn already running, which
  // is the whole point of the queue.
  const flushQueue = useCallback(async () => {
    const parked = queuedRef.current;
    if (!parked.length) return;
    queuedRef.current = [];
    setQueued([]);
    for (const m of parked) await send(m.text, m.images);
  }, [send]);

  // Whatever is still parked when the agent goes idle goes out on its own, so a
  // queue nobody flushed does not sit there forever.
  useEffect(() => {
    if (!busy && queued.length) flushQueue();
  }, [busy, queued, flushQueue]);

  const decide = useCallback((id, decision) => {
    pba().agent.decide(id, decision);
    patch(id, { decided: decision });
  }, [patch]);

  // Stopping the turn also empties the queue, and the parked text is handed
  // back to the caller so the composer can put it where the user left it.
  const interrupt = useCallback(async () => {
    const parked = queuedRef.current.map((m) => m.text);
    queuedRef.current = [];
    setQueued([]);
    await pba().agent.interrupt();
    setBusy(false);
    push({ id: `i${Date.now()}`, kind: 'note', text: 'interrupted' });
    return parked;
  }, [push]);

  const reset = useCallback(async () => {
    await pba().agent.reset();
    setItems([]);
    setLiveSession(null);
    setTitle('New chat');
    setBusy(false);
    queuedRef.current = [];
    setQueued([]);
    seenText.current.clear();
    streamId.current = null;
    pendingText.current = '';   // a chunk buffered mid-stream belongs to the chat being dropped
    window.pbaRail?.setCurrent(null);
  }, [setLiveSession]);

  // Replay a stored transcript, then reattach the live session to it.
  const open = useCallback(async (s) => {
    setBusy(true);
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
      setItems(next);
      setTitle(s.title.slice(0, 80));
      setLiveSession(s.id);
      seenText.current.clear();
      streamId.current = null;
      pendingText.current = '';
      window.pbaRail?.setCurrent(s.id);
      await pba().agent.resume(s.id);
    } catch (e) {
      push({ id: `e${Date.now()}`, kind: 'note', error: true, text: `could not resume: ${e.message}` });
    }
    setBusy(false);
  }, [push, setLiveSession]);

  const changeModel = useCallback(async (value) => {
    setModel(value);
    await pba().agent.setModel(value);
  }, []);

  const changeMode = useCallback(async (value) => {
    setMode(value);
    await pba().agent.mode(value);
  }, []);

  return {
    items, busy, session, title, models, model, mode, driver, queued,
    send, enqueue, unqueue, flushQueue,
    decide, interrupt, reset, open, changeModel, changeMode,
  };
}

const uid = (p) => `${p}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// Drop the [preview element] / [attached …] preamble the composer adds, and
// leave what the human actually typed. Exported because the composer shows the
// same thing on a queued message.
export const spoken = (t) => String(t).replace(/^(\[(?:preview element|attached [a-z]+)\][\s\S]*?\n\n)+/, '');
