/* The Files view: the project folder as a tree, and a read-only look at
   whatever you click. It shares the right column with the preview browser and
   is switched to from the same row of tabs, so only one of the two is on screen
   at a time.

   Every button here says what it does with `title` rather than a Tooltip. The
   preview is a native view the window paints on top of this document, so a
   tooltip opening over the right column opens behind the page; a native tooltip
   is drawn by the desktop and lands on top. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeftIcon,
  BinaryIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCwIcon,
  SearchIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { runCommand } from '../../app.js';
import { onProject, project } from '../../project.js';
import {
  askAboutFile,
  clearQuery,
  closeFile,
  copyPath,
  filesState,
  getFilesVersion,
  HIGHLIGHT_LIMIT,
  highlight,
  openExternal,
  openFile,
  refreshAll,
  restoreScroll,
  revealFile,
  setFileBody,
  setQuery,
  subscribeFiles,
  toggleDir,
  toggleHidden,
  visibleRows,
} from './files-store';
import { useLayout } from './Shell';
import { activeKind, subscribeTabs } from './tabs-store';

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';

// A button that stays pressed while what it turned on is still on.
const ARMED = 'data-[armed]:bg-muted-foreground data-[armed]:text-background';

function useFiles() {
  useSyncExternalStore(subscribeFiles, getFilesVersion, getFilesVersion);
  return filesState;
}

/* Whether the tree is the thing on screen. Two stores answer that between them:
   the strip says which tab is active in a folder, and focus says which folder to
   ask. A folder holds one tree at most, so the kind of its active tab is the
   whole question. */
const subscribeTop = (fn) => {
  const offTabs = subscribeTabs(fn);
  const offFocus = onProject(fn);
  return () => { offTabs(); offFocus(); };
};

// A boolean rather than the tabs version, so opening a preview somewhere else
// in the strip does not redraw the tree.
const onTop = () => activeKind(project.focused) === 'files';

// ----------------------------------------------------------------- labels

const KB = 1024;

function sizeLabel(n) {
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(n < 10 * KB ? 1 : 0)} KB`;
  return `${(n / KB / KB).toFixed(1)} MB`;
}

const CODE = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'ex', 'exs', 'hs', 'clj', 'scala',
]);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const TEXTISH = new Set(['md', 'mdx', 'markdown', 'txt', 'log', 'yml', 'yaml', 'toml', 'ini', 'env', 'csv']);

function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'json' || ext === 'jsonc') return FileJsonIcon;
  if (IMAGES.has(ext)) return FileImageIcon;
  if (CODE.has(ext)) return FileCodeIcon;
  if (TEXTISH.has(ext)) return FileTextIcon;
  return FileIcon;
}

// ------------------------------------------------------------------- rows

/* One row of the tree or of the search results. The padding is inline rather
   than a class: the indent depends on how deep the folder is, and the size
   variant's own padding would otherwise win on the other side. */
function Row({ selected, indent = 8, title, onClick, children }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      data-on={selected || undefined}
      className="w-full justify-start gap-1.5 font-normal data-[on]:bg-accent data-[on]:font-medium"
      style={{ paddingLeft: indent, paddingRight: 10 }}
      title={title}
      onClick={onClick}>
      {children}
    </Button>
  );
}

function Note({ row }) {
  return (
    <p
      className={cn('py-1 pr-2.5 font-mono text-[11px]', row.bad ? 'text-destructive' : 'text-muted-foreground')}
      style={{ paddingLeft: 10 + row.depth * 14 }}>
      {row.text}
    </p>
  );
}

function EntryRow({ row, open, selected }) {
  const { entry, depth } = row;
  const Icon = entry.dir ? (open ? FolderOpenIcon : FolderIcon) : fileIcon(entry.name);

  return (
    <Row
      selected={selected}
      indent={8 + depth * 14}
      title={entry.link ? `${entry.path} (symlink)` : entry.path}
      onClick={() => (entry.dir ? toggleDir(entry.path) : openFile(entry.path))}>
      {entry.dir
        ? (open ? <ChevronDownIcon className="text-muted-foreground" /> : <ChevronRightIcon className="text-muted-foreground" />)
        : <span className="size-3 shrink-0" />}
      <Icon className="text-muted-foreground" />
      <span className={cn('truncate', entry.hidden && 'text-muted-foreground')}>{entry.name}</span>
      {!entry.dir && (
        <span className="ml-auto shrink-0 pl-2.5 font-mono text-[10px] text-muted-foreground">
          {sizeLabel(entry.size)}
        </span>
      )}
    </Row>
  );
}

// ------------------------------------------------------------------- tree

function Tree() {
  const s = useFiles();
  const rows = visibleRows();

  // A folder with nothing in it, or one main could not read, is the whole pane
  // rather than a single grey line at the top of an otherwise blank tree.
  const only = rows.length === 1 && rows[0].kind === 'note' && rows[0].depth === 0 ? rows[0] : null;
  if (only && !only.loading) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">{only.bad ? <TriangleAlertIcon /> : <FolderIcon />}</EmptyMedia>
          <EmptyTitle>{only.bad ? 'Could not read that folder' : 'Nothing here'}</EmptyTitle>
          <EmptyDescription>{only.text}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-1 py-1.5">
        {rows.map((row) => (row.kind === 'note'
          ? <Note key={row.key} row={row} />
          : (
            <EntryRow
              key={row.key}
              row={row}
              open={s.tree.open.has(row.entry.path)}
              selected={s.tree.selected === row.entry.path} />
          )))}
      </div>
    </ScrollArea>
  );
}

// --------------------------------------------------------------- searching

function Results() {
  const s = useFiles();
  const res = s.search.result;

  if (!res) return <p className="p-2.5 font-mono text-[11px] text-muted-foreground">looking…</p>;

  if (!res.matches.length) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
          <EmptyTitle>{`Nothing named like "${s.search.query.trim()}"`}</EmptyTitle>
          {res.capped && <EmptyDescription>The folder was too big to index all of it.</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-1 py-1.5">
        <p className="px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
          {res.total > res.matches.length
            ? `${res.matches.length} of ${res.total} matches`
            : `${res.total} match${res.total === 1 ? '' : 'es'}`}
        </p>

        {res.matches.map((m) => {
          const Icon = fileIcon(m.name);
          const dir = m.path.slice(0, m.path.length - m.name.length).replace(/\/$/, '');
          return (
            <Row
              key={m.path}
              selected={s.tree.selected === m.path}
              title={m.path}
              onClick={() => openFile(m.path)}>
              <span className="size-3 shrink-0" />
              <Icon className="text-muted-foreground" />
              <span className="truncate">{m.name}</span>
              {/* The tail of a long path says more than its head, so it is the
                  end that survives the ellipsis. */}
              {dir && (
                <span
                  dir="rtl"
                  className="ml-auto min-w-0 truncate pl-3 text-right font-mono text-[10.5px] text-muted-foreground">
                  {dir}
                </span>
              )}
            </Row>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// --------------------------------------------------------------- the file

// A checkerboard behind the image, so transparent pixels read as transparent
// rather than as whatever the theme happens to be.
const CHECKER = {
  backgroundImage:
    'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%, transparent 75%, hsl(var(--muted)) 75%),'
    + 'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%, transparent 75%, hsl(var(--muted)) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 8px 8px',
};

function Picture({ src, alt }) {
  return (
    <div className="grid place-items-center p-6" style={CHECKER}>
      <img src={src} alt={alt} className="max-h-[60vh] max-w-full object-contain" />
    </div>
  );
}

function Code({ data }) {
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (data.text.length > HIGHLIGHT_LIMIT || data.lang === 'text') return undefined;
    let live = true;
    highlight(data.text, data.lang)
      .then((html) => { if (live) setDone({ data, html }); })
      .catch(() => { /* a language Shiki does not carry: the plain version stands */ });
    return () => { live = false; };
  }, [data]);

  // Shiki escapes what it emits, and the only input is the file on disk.
  if (done?.data === data) {
    return <div className="py-2.5" dangerouslySetInnerHTML={{ __html: done.html }} />;
  }

  // The fallback and the Shiki output share a shape, so the line-number rule in
  // the stylesheet works for both. No trailing newline: the line spans are laid
  // out as blocks, so one would show up as an extra empty row under every line.
  return (
    <div className="py-2.5">
      <pre className="shiki plain">
        <code>
          {data.text.split('\n').map((line, i) => <span key={i} className="line">{line}</span>)}
        </code>
      </pre>
    </div>
  );
}

function Unreadable({ data }) {
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon"><BinaryIcon /></EmptyMedia>
        <EmptyTitle>{data.kind === 'binary' ? 'A binary file' : 'Too big to open here'}</EmptyTitle>
        <EmptyDescription>
          {data.kind === 'binary'
            ? 'There is nothing useful to show.'
            : `This file is ${sizeLabel(data.size)}, past what this pane will read into memory.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={openExternal}>Open with the system app</Button>
      </EmptyContent>
    </Empty>
  );
}

function FileBody() {
  const s = useFiles();
  const d = s.view.data;

  // Back to the line you were reading once a re-read lands.
  useLayoutEffect(restoreScroll, [s.view.path, d]);

  if (!d) return <p className="p-2.5 font-mono text-[11px] text-muted-foreground">reading…</p>;

  if (d.error) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TriangleAlertIcon /></EmptyMedia>
          <EmptyTitle>Could not read that file</EmptyTitle>
          <EmptyDescription>{d.error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (d.kind === 'binary' || d.kind === 'toobig') return <Unreadable data={d} />;

  /* #file-view is still here for the stylesheet: the Shiki markup arrives as
     HTML and its line numbers, tab size and dark-theme colours are all rules
     hanging off this id. */
  return (
    <ScrollArea id="file-view" className="min-h-0 flex-1" viewportRef={setFileBody}>
      {d.kind === 'image' && <Picture src={d.dataUrl} alt={d.name} />}

      {d.kind !== 'image' && (
        <>
          {/* An SVG is a picture and a file you edit, so it gets both. */}
          {d.svg && <><Picture src={d.svg} alt={d.name} /><Separator /></>}
          {d.text.length
            ? <Code data={d} />
            : <p className="p-2.5 font-mono text-[11px] text-muted-foreground">empty file</p>}
        </>
      )}
    </ScrollArea>
  );
}

function FileHead() {
  const s = useFiles();
  const d = s.view.data;

  const bits = d && !d.error ? [sizeLabel(d.size)] : [];
  if (d?.kind === 'text') bits.push(`${d.lines} line${d.lines === 1 ? '' : 's'}`, d.lang);

  return (
    <div className="flex h-[34px] shrink-0 items-center gap-2 border-b bg-card pr-2 pl-1">
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Back to the tree" onClick={closeFile}>
        <ArrowLeftIcon />
      </Button>

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate font-mono text-xs" title={s.view.path}>{s.view.path}</span>
        {bits.length > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{bits.join(' · ')}</span>
        )}
      </div>

      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Copy the path" onClick={copyPath}>
        <CopyIcon />
      </Button>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Show in the file manager" onClick={revealFile}>
        <FolderOpenIcon />
      </Button>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Open with the system app" onClick={openExternal}>
        <ExternalLinkIcon />
      </Button>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Ask the agent about this file" onClick={askAboutFile}>
        <SparklesIcon />
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------- bar

function FilesBar() {
  const s = useFiles();
  const { previewFull } = useLayout();
  const input = useRef(null);

  // Clearing the box is the start of typing the next name, not the end of
  // looking, so the caret stays where it was.
  const clear = () => { clearQuery(); input.current?.focus(); };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') clearQuery();
    // Enter on a single match is the whole point of typing a filename.
    if (e.key === 'Enter' && s.search.result?.matches.length) openFile(s.search.result.matches[0].path);
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
      <InputGroup className="h-8 min-w-0 flex-1">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          ref={input}
          spellCheck={false}
          placeholder="Find a file by name"
          className="font-mono text-[13px]"
          value={s.search.query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown} />
        {s.search.query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" title="Clear" onClick={clear}>
              <XIcon />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Re-read the folder" onClick={refreshAll}>
        <RotateCwIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-armed={s.tree.showHidden ? '' : undefined}
        className={`${ICON_BUTTON} ${ARMED}`}
        title={s.tree.showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
        onClick={toggleHidden}>
        {s.tree.showHidden ? <EyeIcon /> : <EyeOffIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-armed={previewFull ? '' : undefined}
        className={`${ICON_BUTTON} ${ARMED}`}
        title={previewFull ? 'Back to the chat (Ctrl+Shift+F)' : 'Files at full width (Ctrl+Shift+F)'}
        onClick={() => runCommand('previewFull')}>
        {previewFull ? <Minimize2Icon /> : <Maximize2Icon />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={`${ICON_BUTTON} hover:text-destructive`}
        title="Hide the files (Ctrl+Shift+D)"
        onClick={() => runCommand('files', false)}>
        <XIcon />
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------- pane

export default function FilesView() {
  const s = useFiles();
  const { rightOpen } = useLayout();
  const top = useSyncExternalStore(subscribeTop, onTop, onTop);

  // Hidden rather than unmounted, the way it always was. The folders you
  // expanded and the file you were part way down are worth keeping while you
  // read a diff in the next tab.
  return (
    <div
      id="files-view"
      className="flex h-full min-h-0 flex-col"
      hidden={!(rightOpen && top) || undefined}>
      <FilesBar />

      {s.view.path
        ? <><FileHead /><FileBody /></>
        : (s.search.query.trim() ? <Results /> : <Tree />)}
    </div>
  );
}
