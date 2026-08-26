/* The Changes view: everything in the project folder that git has not been told
   about yet, which after an agent has been working is most of what you want to
   look at.

   The list of files is on top, the selected file's patch fills the rest. The
   split is fixed rather than draggable because the list is short by nature: a
   run that touches forty files is a run you read one file at a time anyway.

   Every button here says what it does with `title` rather than a Tooltip. The
   preview is a native view the window paints on top of this document, so a
   tooltip opening over the right column opens behind the page; a native tooltip
   is drawn by the desktop and lands on top. */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  FileCodeIcon,
  GitCompareIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { runCommand } from '../../app.js';
import {
  askAboutChange,
  changesCount,
  changesState,
  copyPatch,
  diffGroups,
  getChangesVersion,
  jumpBlock,
  MARK,
  openInFiles,
  refresh,
  selectFile,
  setMode,
  subscribeChanges,
  summary,
} from './changes-store';
import { useLayout } from './Shell';

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';
const DANGER_BUTTON = 'size-7 rounded-md text-destructive';

function useChanges() {
  useSyncExternalStore(subscribeChanges, getChangesVersion, getChangesVersion);
  return changesState;
}

// --------------------------------------------------------------- file list

// The letter in the margin says what happened to the file. Green for a file
// that arrived, red for one that left, amber for one git cannot merge.
const MARK_TONE = {
  new: 'text-[hsl(var(--success))]',
  added: 'text-[hsl(var(--success))]',
  deleted: 'text-destructive',
  conflict: 'text-[hsl(var(--warning))]',
};

function FileRow({ file, on }) {
  const cut = file.path.lastIndexOf('/') + 1;

  return (
    <Button
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      className="h-7 w-full justify-start gap-2 rounded-none px-2.5 font-normal"
      title={file.path}
      onClick={() => selectFile(file.path)}>
      <Badge variant="ghost" className={`px-0 font-mono ${MARK_TONE[file.kind] || 'text-muted-foreground'}`}>
        {MARK[file.kind] || 'M'}
      </Badge>

      <span className="min-w-0 flex-1 truncate text-left text-[13px]">
        <span className="text-muted-foreground">{file.path.slice(0, cut)}</span>
        {file.path.slice(cut)}
      </span>

      {file.staged && <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">staged</Badge>}

      {file.binary
        ? <Badge variant="ghost" className="px-0 font-mono text-[10.5px] text-muted-foreground">binary</Badge>
        : (
          <>
            {file.added > 0 && (
              <Badge variant="ghost" className="px-0 font-mono text-[10.5px] text-[hsl(var(--success))]">
                {`+${file.added}`}
              </Badge>
            )}
            {file.removed > 0 && (
              <Badge variant="ghost" className="px-0 font-mono text-[10.5px] text-destructive">
                {`−${file.removed}`}
              </Badge>
            )}
          </>
        )}
    </Button>
  );
}

function FileList() {
  const s = useChanges();

  return (
    <div className="flex max-h-[40%] shrink-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col py-1.5">
          {s.files.map((f) => <FileRow key={f.path} file={f} on={f.path === s.selected} />)}
          {s.capped > 0 && (
            <div className="px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
              {`${s.capped} more changed files not listed`}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// -------------------------------------------------------------------- diff

/* A patch is dense monospaced text with a colour per line and there is no
   shadcn component for that, so these are plain elements carrying semantic
   tokens. The whole row is tinted rather than just its text: a patch is read by
   shape first, and a red block is a deletion before anyone has read a word of
   it. */
const LINE_TONE = {
  '+': 'bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]',
  '-': 'bg-destructive/10 text-destructive',
};

const GUTTER = 'w-[5ch] shrink-0 pr-2.5 text-right text-[11px] text-muted-foreground select-none';

function DiffLine({ row }) {
  if (row.kind === '@' || row.kind === '\\') {
    const mark = row.kind === '@' ? '⋯' : '⤶';
    return (
      <div className="px-2.5 pt-1.5 pb-0.5 text-[11px] whitespace-pre text-muted-foreground">
        {row.text ? `${mark} ${row.text}` : mark}
      </div>
    );
  }

  return (
    <div className={`flex ${LINE_TONE[row.kind] || ''}`}>
      <span className={GUTTER}>{row.oldNo || ''}</span>
      <span className={GUTTER}>{row.newNo || ''}</span>
      <span className="w-[2ch] shrink-0 text-muted-foreground select-none">{row.kind === ' ' ? '' : row.kind}</span>
      <span className="min-w-0 flex-1 pr-4 whitespace-pre">{row.text || ' '}</span>
    </div>
  );
}

function DiffBody({ at, blockRefs }) {
  const s = useChanges();
  const p = s.patch;

  const note = (text) => <div className="px-3.5 py-2.5 text-[11.5px] text-muted-foreground">{text}</div>;

  if (!p) return note(s.loadingPatch ? 'Reading the file' : '');
  if (p.error) return note(p.error);
  if (p.binary) return note('A binary file. There is nothing to read line by line.');
  if (p.toobig) return note('That file is too large to show here.');

  const { groups, extra } = diffGroups();
  if (!groups.length) return note('No line changes. The file mode or its permissions changed.');

  return (
    <div className="py-1.5 pb-4 font-mono text-xs leading-relaxed">
      {groups.map((g, i) => (g.block === null
        ? <DiffLine key={i} row={g.lines[0]} />
        : (
          /* An inset shadow marks the run that the jump buttons are on, rather
             than a border, which would shift these lines two pixels out of step
             with the unchanged ones around them. */
          <div
            key={i}
            ref={(node) => { blockRefs.current[g.block] = node; }}
            data-current={g.block === at ? '' : undefined}
            className="data-[current]:bg-primary/5 data-[current]:shadow-[inset_2px_0_0_hsl(var(--primary))]">
            {g.lines.map((row, j) => <DiffLine key={j} row={row} />)}
          </div>
        )))}

      {extra > 0
        ? note(`${extra} more lines. Open the file to read the rest.`)
        : p.truncated && note('The rest of this file was too long to send.')}
    </div>
  );
}

function Diff() {
  const s = useChanges();
  const { blocks } = diffGroups();
  const blockRefs = useRef([]);
  const landed = useRef(null);

  const at = blocks ? Math.min(s.blockAt, blocks - 1) : -1;

  // Pressing a jump button walks you to the next run of changed lines.
  useEffect(() => {
    blockRefs.current[at]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [at]);

  // A file you just opened lands on its first change, not on line one: in a
  // long file the changed lines are usually nowhere near the top. Which file
  // has already been landed on is remembered, because the pane re-reads the
  // open file every few seconds and a re-read must not throw away where you
  // had scrolled to.
  useEffect(() => {
    const key = `${s.selected}|${s.mode}`;
    if (!blocks || landed.current === key) return;
    landed.current = key;
    blockRefs.current[0]?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [s.selected, s.mode, blocks]);

  if (!s.selected) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b bg-card pr-2 pl-2.5">
        {/* The interesting end of a path is the file name, so an overlong one
            is cut at the front. */}
        <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono text-xs [unicode-bidi:plaintext]">
          {s.selected}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="Previous change (Alt+Up)"
            disabled={blocks < 2}
            onClick={() => jumpBlock(-1)}>
            <ChevronUpIcon />
          </Button>
          <span className="min-w-[4ch] text-center font-mono text-[10.5px] text-muted-foreground">
            {blocks ? `${at + 1}/${blocks}` : '0'}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="Next change (Alt+Down)"
            disabled={blocks < 2}
            onClick={() => jumpBlock(1)}>
            <ChevronDownIcon />
          </Button>
        </div>

        <ToggleGroup type="single" variant="outline" size="sm" value={s.mode} onValueChange={setMode}>
          <ToggleGroupItem value="full" className="px-2 text-xs" title="Show the whole file">whole file</ToggleGroupItem>
          <ToggleGroupItem value="hunks" className="px-2 text-xs" title="Show only the changed lines">changes</ToggleGroupItem>
        </ToggleGroup>

        <Separator orientation="vertical" className="mx-0.5 !h-4" />

        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Open this file in the Files tab" onClick={openInFiles}>
          <FileCodeIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Ask the agent about this change" onClick={askAboutChange}>
          <SparklesIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Copy the patch" onClick={copyPatch}>
          <CopyIcon />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <DiffBody at={at} blockRefs={blockRefs} />
      </ScrollArea>
    </div>
  );
}

// ------------------------------------------------------------ empty states

function Nothing() {
  const s = useChanges();

  if (!s.repo) {
    const nogit = s.reason === 'nogit';
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><GitCompareIcon /></EmptyMedia>
          <EmptyTitle>{nogit ? 'git is not installed' : 'Not a git repository'}</EmptyTitle>
          <EmptyDescription>
            {nogit
              ? 'This view reads the working tree with git. Install it and reopen this tab.'
              : 'Run `git init` in the terminal and this fills in with everything you change.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (s.error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><TriangleAlertIcon /></EmptyMedia>
          <EmptyTitle>git could not read the folder</EmptyTitle>
          <EmptyDescription>{s.error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (s.loadingList) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Spinner /></EmptyMedia>
          <EmptyTitle>Reading the working tree</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><CheckIcon /></EmptyMedia>
        <EmptyTitle>Nothing to review</EmptyTitle>
        <EmptyDescription>
          Every file matches the last commit. Ask the agent for a change and it shows up here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

// -------------------------------------------------------------------- pane

export default function ChangesView() {
  const s = useChanges();
  const { rightOpen, rightView, previewFull } = useLayout();
  const showing = rightOpen && rightView === 'changes';
  const count = changesCount();

  // The number on the Changes tab in the toolbar comes from here.
  useEffect(() => { window.tandemStrip?.(); }, [count]);

  // Alt and an arrow walks the changes in the open file. Plain keys would fight
  // with the chat box, which is one Tab away from here.
  useEffect(() => {
    if (!showing) return undefined;
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); jumpBlock(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); jumpBlock(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showing]);

  const empty = !s.repo || s.error || !s.files.length;

  return (
    <div id="changes-view" className="flex h-full min-h-0 flex-col" hidden={!showing || undefined}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
        <GitCompareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{summary()}</span>

        <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Re-read the working tree" onClick={() => refresh()}>
          <RotateCwIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          title={previewFull ? 'Back to the chat (Ctrl+Shift+F)' : 'Changes at full width (Ctrl+Shift+F)'}
          onClick={() => runCommand('previewFull')}>
          {previewFull ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={DANGER_BUTTON}
          title="Hide the changes (Ctrl+Shift+G)"
          onClick={() => runCommand('changes', false)}>
          <XIcon />
        </Button>
      </div>

      {empty ? <Nothing /> : (
        <>
          <FileList />
          <Separator />
          <Diff />
        </>
      )}
    </div>
  );
}
