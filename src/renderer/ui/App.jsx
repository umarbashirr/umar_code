import { Fragment, useCallback, useEffect, useState } from 'react';

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { DiffView, editHunks, hunkStats, isEditTool } from '@/components/diff-view';
import { ToolRow, ToolStrip, Pre, toolLabel, toolSummary } from '@/components/tool-row';
import { AgentRow } from '@/components/agent-row';
import { FleetStrip } from '@/components/fleet-strip';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Composer } from '@/components/composer';
import { QuestionCard } from '@/components/question-card';
import { SettingsDialog } from '@/components/settings-dialog';
import { TokenText } from '@/components/token-text';
import { Button } from '@/components/ui/button';

import { useAgent } from './useAgent';
import { useCatalog } from './useCatalog';
import { useSettings, useUpdates } from './useSettings';
import { toast } from '../app.js';

// Everything clipped to a message becomes a preamble above what was typed. An
// element picked out of the preview is described in full; a picture travels as
// real image bytes and only needs naming here; any other file is named by its
// path, because the agent can open it itself and a pasted-in log is a waste of
// the context window.
// What the person wrote against the attachment, folded onto one line. A block
// is a head line and its indented continuations, so a note with a newline in it
// would end the block early and leave the rest as loose prose.
const noteLine = (a) => (a.note ? `  note: ${String(a.note).replace(/\s+/g, ' ').trim()}` : null);

function attachmentText(list) {
  const lines = [];

  for (const a of list) {
    if (a.kind === 'element') {
      const { hit, shotPath } = a;
      lines.push([
        '[preview element]',
        `  css: ${hit.css}`,
        `  element: ${hit.role === 'generic' ? hit.tag : hit.role} ${JSON.stringify(hit.name || hit.text || '')}`,
        `  ref: ${hit.ref}   size: ${hit.rect.w}x${hit.rect.h} at ${hit.rect.x},${hit.rect.y}`,
        shotPath ? `  screenshot: ${shotPath}` : null,
        noteLine(a),
      ].filter(Boolean).join('\n'));
    } else if (a.kind === 'image') {
      lines.push([
        `[attached image] ${a.name}`,
        a.path ? `  file: ${a.path}` : null,
        noteLine(a),
      ].filter(Boolean).join('\n'));
    } else if (a.kind === 'file') {
      lines.push([
        `[attached file] ${a.name}`,
        `  path: ${a.path}`,
        noteLine(a),
        '  Read it before answering.',
      ].filter(Boolean).join('\n'));
    }
  }

  return lines.length ? lines.join('\n\n') + '\n\n' : '';
}

const toolText = (output) => {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? '', null, 2);
  return output.map((b) => (b.type === 'image' ? '[screenshot]' : b.text ?? JSON.stringify(b))).join('\n');
};

// Live tool results carry a path (main strips the base64 before IPC); a replayed
// transcript still carries the bytes for its most recent few. Handle both.
const toolImages = (output) =>
  (Array.isArray(output) ? output : []).filter((b) => b.type === 'image' && (b.path || b.source?.data));

const EMPTY_DRAFT = { text: '', attachments: [] };

const imageSrc = (b) => (b.path
  ? `file://${encodeURI(b.path)}`
  : `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);

export default function App() {
  const agent = useAgent();
  const catalog = useCatalog();
  const { settings, set, reset } = useSettings();
  const updates = useUpdates();
  // null when closed; otherwise the section to land on, so Help → Check for
  // updates opens the page already showing updates.
  const [settingsAt, setSettingsAt] = useState(null);
  // A half-typed message belongs to the chat it was typed in, so drafts are
  // kept per chat rather than following you around the rail.
  const [drafts, setDrafts] = useState({});
  const key = agent.activeKey;
  const draft = drafts[key] || EMPTY_DRAFT;
  const text = draft.text;
  const attachments = draft.attachments;

  const editDraft = useCallback((field, next) => {
    setDrafts((all) => {
      const cur = all[key] || EMPTY_DRAFT;
      return { ...all, [key]: { ...cur, [field]: typeof next === 'function' ? next(cur[field]) : next } };
    });
  }, [key]);
  const setText = useCallback((next) => editDraft('text', next), [editDraft]);
  const setAttachments = useCallback((next) => editDraft('attachments', next), [editDraft]);
  const setNote = useCallback(
    (id, note) => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, note } : a))),
    [setAttachments],
  );

  // Bridge to the vanilla half: the picker pushes here, the preview's error
  // card sends straight through.
  useEffect(() => {
    // The note was written in the page, on a bar anchored to the element, so it
    // arrives with the hit rather than being asked for once it gets here.
    window.addAttachment = (hit, shotPath) =>
      setAttachments((a) => [
        ...a,
        { id: `el${Date.now()}`, kind: 'element', hit, shotPath, note: hit.note || '' },
      ]);
    window.sendToAgent = (t) => agent.send(t);
    window.tandemChat = {
      open: agent.open,
      newChat: agent.reset,
      // The folder changed under us, so every chat here goes with it.
      clearChats: agent.clear,
      settings: (at) => setSettingsAt(typeof at === 'string' ? at : 'appearance'),
    };
    return () => { window.addAttachment = null; window.sendToAgent = null; window.tandemChat = null; };
  }, [agent.send, agent.open, agent.reset, agent.clear]);

  // News, once. A version the person has already been shown and ignored is not
  // worth a second interruption, so the version each toast named is written to
  // the settings file before it goes up.
  useEffect(() => {
    if (!settings?.startup.checkUpdates) return;
    const told = settings.notices;

    if (updates.app.behind && told.app !== updates.app.latest) {
      set({ notices: { app: updates.app.latest } });
      toast(`Tandem ${updates.app.latest} is out`, `You are on ${updates.app.current}`, [
        { label: 'Update', primary: true, run: () => setSettingsAt('updates') },
        { label: 'Later' },
      ]);
    }

    // The bundled CLI moving is Tandem's problem, not the person's. What is
    // worth interrupting for is a newer claude already sitting on their PATH.
    const c = updates.claude;
    if (c?.canSwitch && told.claude !== c.system.version) {
      set({ notices: { claude: c.system.version } });
      toast(
        `Claude ${c.system.version} is on your PATH`,
        `The agent is running ${c.running?.version || 'the bundled build'}`,
        [
          { label: 'Use it', primary: true, run: () => set({ claude: { binary: 'path' } }) },
          { label: 'Not now' },
        ],
      );
    }
  }, [
    updates.app.behind, updates.app.latest, updates.claude?.canSwitch,
    settings?.startup.checkUpdates, settings?.notices.app, settings?.notices.claude,
  ]);

  // Enter while the agent is working parks the message instead of losing it.
  // Enter on an empty box is the second half of that gesture: it hands
  // everything parked to the turn already running.
  const submit = useCallback((_message, e) => {
    e?.preventDefault?.();
    const body = text.trim();
    // An attachment with nothing typed is still a message: a screenshot and a
    // note say plenty. Only an empty box with nothing clipped to it is nothing
    // to send, and that is the keystroke that releases a parked queue.
    if (!body && !attachments.length) {
      if (agent.queued.length) agent.flushQueue();
      return;
    }
    const full = attachmentText(attachments) + body;
    const images = attachments.filter((a) => a.kind === 'image');
    if (agent.busy) agent.enqueue(full, images);
    else agent.send(full, images);
    setText('');
    setAttachments([]);
  }, [text, attachments, agent]);

  const empty = agent.items.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-[38px] flex-none items-center px-4 text-sm text-foreground/90">
        <span className="truncate">{agent.title}</span>
        {agent.busy && <Shimmer className="ml-3 text-xs">working</Shimmer>}
      </div>

      <Conversation className={empty ? 'mt-auto flex-none' : 'min-h-0 flex-1'}>
        <ConversationContent className="mx-auto w-full max-w-3xl gap-3">
          {empty ? (
            <h1 className="py-6 text-center font-medium text-2xl tracking-tight">What should change?</h1>
          ) : (
            <Items items={agent.items} agent={agent} />
          )}
        </ConversationContent>
        {!empty && <ConversationScrollButton />}
      </Conversation>

      <FleetStrip
        agents={agent.running}
        onStop={agent.stopAgent}
        onShow={(a) => document.getElementById(`row-${a.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} />

      <Composer
        agent={agent}
        catalog={catalog}
        text={text}
        setText={setText}
        attachments={attachments}
        setAttachments={setAttachments}
        onNote={setNote}
        onSubmit={submit} />

      <SettingsDialog
        open={settingsAt !== null}
        section={settingsAt || 'appearance'}
        onOpenChange={(o) => { if (!o) setSettingsAt(null); }}
        settings={settings}
        set={set}
        reset={reset}
        agent={agent}
        updates={updates} />

      {/* Balances the conversation's mt-auto so an empty chat sits centred. */}
      {empty && <div className="mb-auto flex-none" />}
    </div>
  );
}

// A turn is mostly tool calls, and one line each turns twenty greps into a
// screenful of scrolling past your own work. So a run of them folds: whatever
// is running stays a row you can read, and everything it already did becomes
// the one line above it saying how much of what. An edit breaks the run and
// keeps its own row, because a diff is something to read rather than a step on
// the way somewhere.
function runs(items) {
  const out = [];
  for (const item of items) {
    const foldable = item.kind === 'tool' && !isEditTool(toolLabel(item.name));
    const last = out[out.length - 1];
    if (foldable && last?.run) last.run.push(item);
    else out.push(foldable ? { id: item.id, run: [item] } : { id: item.id, item });
  }
  return out;
}

// Two calls are not a run worth folding: it would cost a click and save a line.
const FOLD_AT = 3;

function Items({ items, agent }) {
  return runs(items).map((g) => {
    if (!g.run) return <Item key={g.id} item={g.item} agent={agent} />;
    if (g.run.length < FOLD_AT) {
      return (
        <Fragment key={g.id}>
          {g.run.map((it) => <Item key={it.id} item={it} agent={agent} />)}
        </Fragment>
      );
    }
    // The last one is the live one while the turn runs, and the one that just
    // finished once it stops. Either way it is the one worth reading.
    const done = g.run.slice(0, -1);
    const current = g.run[g.run.length - 1];
    return (
      <div key={g.id} className="flex flex-col gap-px">
        <ToolStrip items={done}>
          {done.map((it) => <Item key={it.id} item={it} agent={agent} />)}
        </ToolStrip>
        <Item item={current} agent={agent} />
      </div>
    );
  });
}

function Item({ item, agent }) {
  const onDecide = agent.decide;

  // An agent owns whatever it did, so its rows are drawn inside it rather than
  // loose in the transcript where they would interleave with everyone else's.
  if (item.kind === 'agent') {
    return (
      <div id={`row-${item.id}`}>
        <AgentRow
          item={item}
          onStop={agent.stopAgent}
          onBackground={agent.backgroundAgent}
          onOpen={agent.openAgent}>
          <Items items={item.children || []} agent={agent} />
        </AgentRow>
      </div>
    );
  }

  if (item.kind === 'user') {
    return (
      <Message from="user">
        <MessageContent className="whitespace-pre-wrap">
          {item.images?.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  alt={img.name || 'attachment'}
                  title={img.name}
                  className="max-h-40 rounded-md border"
                  src={`data:${img.media};base64,${img.data}`} />
              ))}
            </div>
          )}
          <TokenText text={item.text} />
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <Message from="assistant">
        <MessageContent>
          <MessageResponse isAnimating={item.streaming}>{item.text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === 'tool') {
    const label = toolLabel(item.name);
    const images = toolImages(item.output);
    const hunks = editHunks(label, item.input || {});
    const text = toolText(item.output);

    // A file edit is a diff. Showing it as JSON with two long strings in it is
    // the same information in the shape nobody can read.
    if (hunks) {
      const { added, removed } = hunkStats(hunks);
      return (
        <ToolRow
          name={label}
          input={item.input}
          state={item.state}
          defaultOpen
          right={(
            <span className="flex items-center gap-1.5 font-mono text-xs">
              {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
              {removed > 0 && <span className="text-rose-600 dark:text-rose-400">-{removed}</span>}
            </span>
          )}>
          <DiffView hunks={hunks} />
          {item.state === 'output-error' && <Pre className="mt-2 text-destructive">{text}</Pre>}
        </ToolRow>
      );
    }

    return (
      <ToolRow name={label} input={item.input} state={item.state} defaultOpen={item.state === 'output-error'}>
        <Pre>{JSON.stringify(item.input, null, 2)}</Pre>
        {images.map((b, i) => (
          <img
            key={i}
            alt="screenshot"
            className="mt-2 max-w-full rounded-md border"
            loading="lazy"
            src={imageSrc(b)} />
        ))}
        {text && (
          <Pre className={`mt-2 ${item.state === 'output-error' ? 'text-destructive' : ''}`}>
            {text.slice(0, 4000)}
          </Pre>
        )}
      </ToolRow>
    );
  }

  if (item.kind === 'perm') {
    const label = toolLabel(item.tool);
    if (item.decided) {
      // A question that was answered says what the answer was; there is nothing
      // useful in telling someone they allowed their own reply.
      if (item.answers) {
        return (
          <div className="px-2 text-muted-foreground text-xs">
            {Object.entries(item.answers).map(([q, a]) => (
              <div key={q} className="truncate"><span className="text-foreground">{a}</span> — {q}</div>
            ))}
          </div>
        );
      }
      return (
        <div className="px-2 text-muted-foreground text-xs">
          {label}: {item.decided === 'deny' ? 'denied' : `allowed (${item.decided})`}
        </div>
      );
    }

    // A question is not a permission, whatever the transport says.
    if (item.tool === 'AskUserQuestion') {
      return (
        <QuestionCard
          input={item.input}
          onAnswer={(answers, annotations) =>
            onDecide(item.id, 'allow', { ...item.input, answers, ...(annotations ? { annotations } : {}) })}
          onSkip={() => onDecide(item.id, 'deny')} />
      );
    }
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Which agent is stuck on this. Without it a subagent's request
              reads as though the main thread asked. */}
          {item.agent && (
            <button
              type="button"
              title="Show the agent that asked"
              onClick={() => document.getElementById(`row-${item.agent.toolUseId}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-500">
              {item.agent.label}
            </button>
          )}
          <span className="text-[13px]">
            {item.title || <>Allow <span className="font-mono font-medium">{label}</span>?</>}
          </span>
          <span className="truncate font-mono text-muted-foreground text-xs">
            {toolSummary(label, item.input)}
          </span>
          {/* Why this one stopped when the mode lets other calls through. */}
          {item.reason && (
            <span className="text-amber-700 text-xs dark:text-amber-500/90">{item.reason}</span>
          )}
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" className="h-7" onClick={() => onDecide(item.id, 'allow')}>Allow</Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => onDecide(item.id, 'always')}>Always</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => onDecide(item.id, 'deny')}>Deny</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`font-mono text-xs ${item.error ? 'text-destructive' : 'text-muted-foreground'}`}>
      {item.text}
    </div>
  );
}
