import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { SquareIcon } from 'lucide-react';

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { DiffView, editHunks, hunkStats, isEditTool } from '@/components/diff-view';
import { ToolRow, ToolStrip, Pre, toolLabel, toolSummary } from '@/components/tool-row';
import { AgentRow } from '@/components/agent-row';
import { FleetStrip } from '@/components/fleet-strip';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Composer } from '@/components/composer';
import { QuestionCard } from '@/components/question-card';
import { CustomizePage } from '@/components/customize-page';
import { UsagePage } from '@/components/usage-page';
import { TokenText } from '@/components/token-text';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

import { clock, useTick } from '@/lib/clock';

import { useAgent } from './useAgent';
import { useCatalog } from './useCatalog';
import { useSettings, useUpdates } from './useSettings';
import { enterFullPage, leaveFullPage, toast } from '../app.js';
import { publish, showAgent } from './shell/agents-store.js';

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

// Between a message going out and the first row coming back, and again between
// one tool finishing and the next starting, the transcript holds still. A held
// transcript and a hung agent look identical, so a shimmering "Thinking" fills
// those gaps. It is only up when nothing else on screen is already moving:
// streaming text, a tool mid-call and a subagent still running in the
// foreground all say the same thing on their own, and a question is waiting on
// the human, not the model. A backgrounded subagent is the exception, its
// shimmer is about its own work and the main turn is off waiting on something
// else, so the gap here still needs filling.
function stalled(items) {
  const last = items[items.length - 1];
  if (!last) return true;
  if (last.kind === 'assistant') return !last.streaming;
  if (last.kind === 'tool') return last.state !== 'input-available' && last.state !== 'input-streaming';
  if (last.kind === 'agent') return last.status !== 'running' || !!last.background;
  if (last.kind === 'perm') return !!last.decided;
  return true;
}

// When `on` has been true for a whole `ms`, the moment it went true. Zero the
// rest of the time. The gap between one tool finishing and the next starting
// is usually a couple of hundred milliseconds of wire, and a line that flashes
// up in every one of those gaps is worse than no line: it turns a turn that is
// going fine into a strobe.
function useSettled(on, ms) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!on) {
      setAt(0);
      return undefined;
    }
    const began = Date.now();
    const t = setTimeout(() => setAt(began), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return at;
}

// The word on its own was the whole answer for a while, and it is not enough.
// A shimmer sweeps at the same rate after ninety seconds as after two, so a
// long tool call and a dead socket look identical, and the person sits there
// deciding whether to reload. A number that goes up cannot be faked by a stuck
// render. It waits a couple of seconds first, because a clock reading 0:00 on
// a wait nobody had noticed yet only invents the worry.
function ThinkingLine({ since }) {
  useTick(true);
  const held = Date.now() - since;

  return (
    <div className="tandem-in flex items-baseline gap-2 px-2">
      <Shimmer className="text-[13px]">Thinking</Shimmer>
      {held >= 2500 && (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">{clock(held)}</span>
      )}
    </div>
  );
}

// The turn's own clock, up in the header beside the chat's name. Deliberately
// not a second shimmer: two things pulsing at once read as two separate states
// and the reader goes looking for the difference. A dot and a number, and the
// number is the point. This one runs the whole turn, including the stretches
// where a tool row or a subagent is already saying its own piece, so there is
// never a moment with nothing on screen moving.
function TurnClock({ since }) {
  useTick(true);

  return (
    <span className="tandem-in ml-3 flex items-center gap-1.5 text-muted-foreground text-xs">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
      working
      {since > 0 && <span className="font-mono tabular-nums">{clock(Date.now() - since)}</span>}
    </span>
  );
}

// Shown at most once per launch for a given installed version. `open` is
// computed by the caller from state lifted to App itself: the Updates page
// and the chat both mount and unmount this component as navigation toggles
// between them, so state kept here would forget a dismissal on every trip
// back to the chat. "Later" leaves `restart.ready` alone, so the dot on the
// Updates nav item (updatesBehind, in settings-panel.jsx) and the row in the
// Updates page keep the offer around for whenever the person gets to it.
function RestartDialog({ updates, busy, open, onDismiss }) {
  const { restart } = updates;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tandem {restart.installed} is installed</DialogTitle>
          <DialogDescription>
            Restart to use it.
            {busy && ' An agent turn is running in a chat. Restarting stops it, the same as quitting would.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>Later</Button>
          <Button onClick={updates.relaunch}>Restart now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const agent = useAgent();
  // The Agents tab draws from this chat's state but mounts in the right column.
  useEffect(() => publish(agent));
  const catalog = useCatalog();
  const { settings, set, reset } = useSettings();
  const updates = useUpdates();
  const [restartDismissedFor, setRestartDismissedFor] = useState(null);
  const dismissRestart = useCallback(
    () => setRestartDismissedFor(updates.restart.installed),
    [updates.restart.installed],
  );
  const restartOpen = !!(updates.restart.ready && updates.restart.installed !== restartDismissedFor);
  // The Customize page, in the chat's place. null when the chat is showing;
  // otherwise the section on screen, so Help → Check for updates lands on
  // updates and the skills chip lands on skills.
  const [customizeAt, setCustomizeAt] = useState(null);
  const customize = useCallback((at) => {
    enterFullPage();
    setCustomizeAt(at);
  }, []);
  const closeCustomize = useCallback(() => {
    leaveFullPage();
    setCustomizeAt(null);
  }, []);
  const [usageOpen, setUsageOpen] = useState(false);
  const openUsage = useCallback(() => {
    enterFullPage();
    setUsageOpen(true);
  }, []);
  const closeUsage = useCallback(() => {
    leaveFullPage();
    setUsageOpen(false);
  }, []);
  // Picking a chat, from the rail or the palette, means you want to read it, so
  // whichever full page is up gives the window back.
  const showChat = useCallback(() => {
    leaveFullPage();
    setUsageOpen(false);
    setCustomizeAt(null);
  }, []);
  // A half-typed message belongs to the chat it was typed in, so drafts are
  // kept per chat rather than following you around the rail.
  const [drafts, setDrafts] = useState({});
  const key = agent.activeKey;
  const draft = drafts[key] || EMPTY_DRAFT;
  const text = draft.text;
  const attachments = draft.attachments;

  // The bridge below hands these to the vanilla half once and never rebinds,
  // so they read the chat that is open now rather than the one that was open
  // when the bridge was installed. Keyed off a ref for that reason.
  const keyRef = useRef(key);
  keyRef.current = key;

  const editDraft = useCallback((field, next) => {
    const k = keyRef.current;
    setDrafts((all) => {
      const cur = all[k] || EMPTY_DRAFT;
      return { ...all, [k]: { ...cur, [field]: typeof next === 'function' ? next(cur[field]) : next } };
    });
  }, []);
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
      open: (chat) => { showChat(); return agent.open(chat); },
      newChat: (dir) => { showChat(); return agent.reset(dir); },
      // The folder changed under us, so every chat here goes with it.
      clearChats: agent.clear,
      // Deleting one, transcript and all. The draft goes with it: half a
      // message typed into a chat that no longer exists is nobody's to keep.
      remove: async (chat) => {
        const res = await agent.removeChat(chat);
        if (chat.key) setDrafts(({ [chat.key]: _gone, ...rest }) => rest);
        return res;
      },
      settings: (at) => customize(typeof at === 'string' ? at : 'appearance'),
      customize: (at) => customize(typeof at === 'string' ? at : 'skills'),
      usage: openUsage,
    };
    return () => { window.addAttachment = null; window.sendToAgent = null; window.tandemChat = null; };
  }, [agent.send, agent.open, agent.reset, agent.clear, agent.removeChat, customize, openUsage, showChat]);

  // News, once. A version the person has already been shown and ignored is not
  // worth a second interruption, so the version each toast named is written to
  // the settings file before it goes up.
  useEffect(() => {
    if (!settings?.startup.checkUpdates) return;
    const told = settings.notices;

    if (updates.app.behind && told.app !== updates.app.latest) {
      set({ notices: { app: updates.app.latest } });
      toast(`Tandem ${updates.app.latest} is out`, `You are on ${updates.app.current}`, [
        { label: 'Update', primary: true, run: () => customize('updates') },
        { label: 'Later' },
      ]);
    }

    // The CLI is theirs to update, so this is news rather than a chore Tandem
    // can do for them. Nothing here replaces a binary; it points at the tab
    // that names the command.
    const c = updates.claude;
    if (c?.behind && told.claude !== c.latest) {
      set({ notices: { claude: c.latest } });
      toast(`Claude ${c.latest} is out`, `You are running ${c.running?.version}`, [
        { label: 'How', primary: true, run: () => customize('updates') },
        { label: 'Later' },
      ]);
    }
  }, [
    updates.app.behind, updates.app.latest, updates.claude?.behind, updates.claude?.latest,
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
  // A gap the transcript is not already explaining, once it has lasted long
  // enough to be a gap rather than the wire.
  const thinkingSince = useSettled(agent.busy && stalled(agent.items), 400);
  // Any chat, not just the one on screen: a turn running in a background chat
  // is just as real a reason to think before restarting.
  const anyTurnRunning = agent.chats.some((c) => c.busy);

  if (usageOpen) return <UsagePage providers={agent.providers} onClose={closeUsage} />;

  if (customizeAt !== null) {
    return (
      <>
        <RestartDialog updates={updates} busy={anyTurnRunning} open={restartOpen} onDismiss={dismissRestart} />
        <CustomizePage
          section={customizeAt}
          onSection={setCustomizeAt}
          onClose={closeCustomize}
          catalog={catalog}
          settings={settings}
          set={set}
          reset={reset}
          agent={agent}
          updates={updates} />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <RestartDialog updates={updates} busy={anyTurnRunning} open={restartOpen} onDismiss={dismissRestart} />
      <div className="flex h-[38px] flex-none items-center border-b border-border/60 px-4 text-sm text-foreground/90">
        <span className="truncate">{agent.title}</span>
        {agent.busy && <TurnClock since={agent.startedAt} />}
      </div>

      <Conversation className={empty ? 'mt-auto flex-none' : 'min-h-0 flex-1'}>
        <ConversationContent className="mx-auto w-full max-w-3xl gap-3">
          {empty ? (
            <h1 className="py-6 text-center font-medium text-2xl tracking-tight">What should change?</h1>
          ) : (
            <Transcript key={agent.activeKey} items={agent.items} agent={agent} />
          )}
          {thinkingSince > 0 && <ThinkingLine since={thinkingSince} />}
        </ConversationContent>
        {!empty && <ConversationScrollButton />}
      </Conversation>

      <FleetStrip
        agents={agent.running}
        onStop={agent.stopAgent}
        onShow={(a) => (a.kind === 'agent'
          ? showAgent(a.id)
          : document.getElementById(`row-${a.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))} />

      <Composer
        agent={agent}
        settings={settings}
        catalog={catalog}
        text={text}
        setText={setText}
        attachments={attachments}
        setAttachments={setAttachments}
        onNote={setNote}
        onSubmit={submit} />

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

// A row landing, seen landing. Without this the transcript grows by jumping,
// and a jump is what the window does when it redraws, not what an agent does
// when it finishes a thought. The wrapper is keyed on the item, so a row that
// merely changes underneath it — a tool filling in its output, a diff arriving
// a beat after its row — sits still instead of replaying.
const Row = ({ children }) => <div className="tandem-in">{children}</div>;

const TAIL = 30;

function Transcript({ items, agent }) {
  const total = runs(items).length;
  const [pinnedStart, setPinnedStart] = useState(null);
  const start = pinnedStart ?? Math.max(0, total - TAIL);
  useEffect(() => { if (pinnedStart === null && total) setPinnedStart(start); }, [pinnedStart, total, start]);

  const { scrollRef } = useStickToBottomContext();
  const fromBottom = useRef(null);
  const earlier = () => {
    const el = scrollRef.current;
    fromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setPinnedStart(Math.max(0, start - TAIL));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && fromBottom.current !== null) el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [start, scrollRef]);

  return (
    <>
      {start > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          onClick={earlier}>
          Show {Math.min(start, TAIL)} earlier
        </Button>
      )}
      <Items items={items} agent={agent} from={start} />
    </>
  );
}

export function Items({ items, agent, from = 0 }) {
  return runs(items).slice(from).map((g) => {
    if (!g.run) return <Row key={g.id}><Item item={g.item} agent={agent} /></Row>;
    if (g.run.length < FOLD_AT) {
      return (
        <Fragment key={g.id}>
          {g.run.map((it) => <Row key={it.id}><Item item={it} agent={agent} /></Row>)}
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
        {/* Keyed, so the row the run is currently on is a new element each
            time the run moves on. Without the key React reconciles the next
            tool call into the last one's markup and the reader inherits
            whatever they had opened on the call before. */}
        <Row key={current.id}><Item item={current} agent={agent} /></Row>
      </div>
    );
  });
}

function Item({ item, agent }) {
  const onDecide = agent.decide;

  // An agent owns whatever it did, and that lives in the Agents tab. Here it is
  // one row, so three at once cost three lines of the chat and not three logs.
  if (item.kind === 'agent') {
    return (
      <div id={`row-${item.id}`}>
        <AgentRow
          item={item}
          onStop={agent.stopAgent}
          onBackground={agent.backgroundAgent}
          onShow={(it) => showAgent(it.id)} />
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
          {/* The caret rides the last paragraph while text is still coming.
              Prose that pauses for a second between chunks looks finished
              without it, and the reader reaches for the composer mid-answer. */}
          <MessageResponse
            className={item.streaming ? 'tandem-streaming' : undefined}
            isAnimating={item.streaming}>
            {item.text}
          </MessageResponse>
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
          at={item.at}
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

    // A shell left running in the background, a dev server say. It is done as
    // a call but not as a process, so the row says so and can stop it.
    const live = item.taskId && (item.status === 'running' || item.status === 'stopping');
    return (
      <div id={`row-${item.id}`}>
        <ToolRow
          name={label}
          input={item.input}
          state={item.state}
          at={item.at}
          defaultOpen={item.state === 'output-error'}
          right={item.taskId && (
            <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/75">
              <span>{live ? 'background' : item.status}</span>
              {live && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Stop this command"
                  onClick={(e) => { e.stopPropagation(); agent.stopAgent(item); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); agent.stopAgent(item); } }}
                  className="grid size-5 place-items-center rounded hover:bg-secondary hover:text-foreground">
                  <SquareIcon className="size-3" />
                </span>
              )}
            </span>
          )}>
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
      </div>
    );
  }

  if (item.kind === 'perm') {
    const label = toolLabel(item.tool);
    if (item.decided) {
      // A question that was answered says what the answer was; there is nothing
      // useful in telling someone they allowed their own reply.
      if (item.answers) {
        return (
          <div className="flex flex-col gap-1.5 px-2 text-xs">
            {Object.entries(item.answers).map(([q, a]) => (
              <div key={q}>
                <div className="text-muted-foreground">{q}</div>
                {/* The picker's advice to the asker, not part of the answer. */}
                <div className="text-foreground">{String(a).replace(/\s*\(Recommended\)/g, '')}</div>
              </div>
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
            <Button
              variant="ghost"
              size="xs"
              title="Show the agent that asked"
              onClick={() => document.getElementById(`row-${item.agent.toolUseId}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="h-auto rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-normal text-amber-700 dark:text-amber-500">
              {item.agent.label}
            </Button>
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
