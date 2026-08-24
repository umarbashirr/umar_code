import { useCallback, useEffect, useState } from 'react';
import { ListChecksIcon, BugIcon, MonitorIcon } from 'lucide-react';

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { DiffView, editHunks, hunkStats } from '@/components/diff-view';
import { ToolRow, Pre, toolSummary } from '@/components/tool-row';
import { Suggestions, Suggestion } from '@/components/ai-elements/suggestion';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Composer } from '@/components/composer';
import { QuestionCard } from '@/components/question-card';
import { Button } from '@/components/ui/button';

import { useAgent } from './useAgent';
import { useCatalog } from './useCatalog';

const STARTERS = [
  { icon: ListChecksIcon, title: 'Start with a plan', sub: 'Agree on the approach before code',
    prompt: 'Read the project and explain how it is put together, then propose a plan before writing any code.' },
  { icon: BugIcon, title: 'Debug an issue', sub: 'Find the root cause first',
    prompt: 'Something is broken. Reproduce it, find the root cause, and tell me what you find before fixing anything.' },
  { icon: MonitorIcon, title: 'Drive the preview', sub: 'Load the page and look at it',
    prompt: 'Open the app in the preview, snapshot the page, and tell me what is on screen and what looks wrong.' },
];

// Everything clipped to a message becomes a preamble above what was typed. An
// element picked out of the preview is described in full; a picture travels as
// real image bytes and only needs naming here; any other file is named by its
// path, because the agent can open it itself and a pasted-in log is a waste of
// the context window.
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
      ].filter(Boolean).join('\n'));
    } else if (a.kind === 'image') {
      lines.push(`[attached image] ${a.name}${a.path ? `\n  file: ${a.path}` : ''}`);
    } else if (a.kind === 'file') {
      lines.push(`[attached file] ${a.name}\n  path: ${a.path}\n  Read it before answering.`);
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

const imageSrc = (b) => (b.path
  ? `file://${encodeURI(b.path)}`
  : `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);

export default function App() {
  const agent = useAgent();
  const catalog = useCatalog();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);

  // Bridge to the vanilla half: the picker pushes here, the preview's error
  // card sends straight through.
  useEffect(() => {
    window.addAttachment = (hit, shotPath) =>
      setAttachments((a) => [...a, { id: `el${Date.now()}`, kind: 'element', hit, shotPath }]);
    window.sendToAgent = (t) => agent.send(t);
    window.pbaChat = { open: agent.open, newChat: agent.reset };
    return () => { window.addAttachment = null; window.sendToAgent = null; window.pbaChat = null; };
  }, [agent.send, agent.open, agent.reset]);

  // Enter while the agent is working parks the message instead of losing it.
  // Enter on an empty box is the second half of that gesture: it hands
  // everything parked to the turn already running.
  const submit = useCallback((_message, e) => {
    e?.preventDefault?.();
    const body = text.trim();
    if (!body) {
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
            agent.items.map((item) => <Item key={item.id} item={item} onDecide={agent.decide} />)
          )}
        </ConversationContent>
        {!empty && <ConversationScrollButton />}
      </Conversation>

      <Composer
        agent={agent}
        catalog={catalog}
        text={text}
        setText={setText}
        attachments={attachments}
        setAttachments={setAttachments}
        onSubmit={submit} />

      {empty && (
        <div className="mx-auto mb-auto w-full max-w-3xl flex-none px-4 pb-8">
          <Suggestions className="flex-col items-stretch gap-0">
            {STARTERS.map((s) => (
              <Suggestion
                key={s.title}
                suggestion={s.prompt}
                onClick={(p) => agent.send(p)}
                variant="ghost"
                className="h-auto justify-start gap-3 rounded-lg border-b px-3 py-2.5 last:border-b-0">
                <s.icon className="size-4 text-muted-foreground" />
                <span className="text-sm">{s.title}</span>
                <span className="truncate text-muted-foreground text-sm">{s.sub}</span>
              </Suggestion>
            ))}
          </Suggestions>
        </div>
      )}
    </div>
  );
}

function Item({ item, onDecide }) {
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
          {item.text}
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
    const label = item.name.replace(/^mcp__preview__/, '').replace(/^mcp__[^_]+__/, '');
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
    const label = item.tool.replace(/^mcp__[^_]+__/, '');
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
          <span className="text-[13px]">
            Allow <span className="font-mono font-medium">{label}</span>?
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
