import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon, CrosshairIcon, FileIcon, TriangleAlertIcon } from 'lucide-react';

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { sizeLabel } from '@/lib/attachments';
// The preview pane is a native view sitting above this document, so it has to
// move out of the way while a dialog is up.
import { parkPreview } from '../../app.js';

function PathRow({ label, path }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
      <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Copy the path"
        onClick={() => { navigator.clipboard?.writeText(path); setCopied(true); }}
        className="text-muted-foreground">
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

const Field = ({ label, children, mono }) => (
  <div className="flex gap-3 text-xs">
    <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
    <span className={cn('min-w-0 flex-1 break-words', mono && 'font-mono')}>{children}</span>
  </div>
);

// The picture at the size it was shrunk to, which is also the size the agent
// sees. A filename tells you nothing about which screenshot you grabbed.
function Body({ item }) {
  if (item.kind === 'image') {
    return (
      <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 p-2">
        {/* Pinned to the viewport rather than to the dialog: a percentage cap
            resolves against an auto height and does nothing. The subtraction is
            the header, the path row and the padding around them, so a tall
            picture ends up scaled instead of scrolled. */}
        <img src={item.preview} alt={item.name} className="max-h-[calc(82vh-9rem)] w-auto max-w-full object-contain" />
      </div>
    );
  }

  if (item.kind === 'element') {
    const { hit, shotPath } = item;
    return (
      <div className="flex flex-col gap-2.5">
        <Field label="element">{hit.role === 'generic' ? hit.tag : hit.role}</Field>
        {(hit.name || hit.text) && <Field label="text">{hit.name || hit.text}</Field>}
        <Field label="css" mono>{hit.css}</Field>
        <Field label="ref" mono>{hit.ref}</Field>
        {hit.rect && (
          <Field label="box" mono>{hit.rect.w}×{hit.rect.h} at {hit.rect.x},{hit.rect.y}</Field>
        )}
        {shotPath && <PathRow label="shot" path={shotPath} />}
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-destructive text-sm">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span>{item.error}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
        <FileIcon className="size-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm">{item.name}</div>
          <div className="text-muted-foreground text-xs">{sizeLabel(item.size)}</div>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Files go across as a path. The agent opens this one itself when you send the message.
      </p>
    </div>
  );
}

// A line in your own words, travelling with the thing it is about. The element
// picker opens this dialog on what it just attached and lands the caret here,
// so pointing at something and saying what is wrong with it is one gesture
// rather than a trip back to the message box.
function Note({ item, onNote }) {
  const field = useRef(null);
  const fresh = !item.note;

  useEffect(() => {
    if (fresh) field.current?.focus();
    // Only on arrival. Re-focusing on every keystroke would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Labelled like the read-only rows above it, so a note already written still
  // announces itself as the note rather than as a box of unexplained text.
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">note</span>
      <Input
        ref={field}
        value={item.note || ''}
        onChange={(e) => onNote(item.id, e.target.value)}
        // Enter has nothing left to confirm, the note is already saved, so it
        // means the same thing here as it does anywhere else: done.
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        placeholder="Anything the agent should know about this"
        className="h-8 flex-1 text-sm" />
    </div>
  );
}

const subtitle = (item) => {
  if (item.kind === 'image') return `${item.width}×${item.height} · ${sizeLabel(item.size)}`;
  if (item.kind === 'file') return sizeLabel(item.size);
  if (item.kind === 'element') return 'picked in the preview';
  return 'could not be attached';
};

export function AttachmentPreview({ item, onNote, onOpenChange }) {
  const open = !!item;

  useEffect(() => {
    parkPreview(open);
    return () => parkPreview(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] max-w-3xl flex-col gap-3 p-4 sm:max-w-3xl">
        {item && (
          <>
            <DialogHeader className="gap-0 text-left">
              <DialogTitle className="flex items-center gap-2 truncate pr-6 text-sm">
                {item.kind === 'element' && <CrosshairIcon className="size-4 shrink-0 text-muted-foreground" />}
                <span className="truncate">{item.kind === 'element' ? 'Element from the page' : item.name}</span>
              </DialogTitle>
              <DialogDescription className="text-xs">{subtitle(item)}</DialogDescription>
            </DialogHeader>

            <Body item={item} />

            {onNote && item.kind !== 'error' && <Note item={item} onNote={onNote} />}

            {item.path && <PathRow label="file" path={item.path} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
