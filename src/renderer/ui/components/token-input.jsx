import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

import { parse, pendingToken } from '@/lib/tokens';
import { tokenElement } from '@/components/token-badge';
import { cn } from '@/lib/utils';

// A textarea holds characters and nothing else, so a badge with an icon in it
// is not something a textarea can be talked into. This is the same box built
// as a contenteditable, where a token is one atomic node the caret cannot get
// inside of.
//
// The rule that keeps it sane: the string is the truth and the DOM is a
// picture of it. Ordinary typing is left to the browser and read back out
// afterwards. Anything structural — inserting a token, deleting one whole,
// a line break, a paste, an undo — computes the new string, redraws from it,
// and puts the caret back by character offset. Chromium never gets the chance
// to "repair" the markup, which is where every contenteditable horror story
// starts.

const isToken = (n) => n?.nodeType === 1 && n.dataset?.raw !== undefined;
const BLOCK = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE']);

// The DOM back to a string. Chromium likes to swap the spaces either side of
// an inline node for non-breaking ones; they go back to ordinary spaces or the
// agent receives characters nobody typed. A <br> in last place is Chromium's
// placeholder for an empty final line, never content.
function valueOf(root) {
  let out = '';
  for (const child of root.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue.replace(/\u00a0/g, ' ');
    else if (isToken(child)) out += child.dataset.raw;
    else if (child.nodeName === 'BR') out += (child === root.lastChild ? '' : '\n');
    else out += valueOf(child) + (child !== root.lastChild && BLOCK.has(child.nodeName) ? '\n' : '');
  }
  return out;
}

// Only text nodes and token spans belong in here. Anything else means the
// browser has been editing the structure and the box needs redrawing.
function canonical(root) {
  for (const child of root.childNodes) {
    if (child.nodeType === 3 || isToken(child)) continue;
    return false;
  }
  return true;
}

function render(root, text) {
  const doc = root.ownerDocument;
  root.textContent = '';
  for (const node of parse(text)) {
    root.appendChild(node.type === 'text' ? doc.createTextNode(node.text) : tokenElement(doc, node));
  }
  // A badge in last place leaves the caret nowhere ordinary to land, so there
  // is always a text node after it to click into.
  if (!root.lastChild || isToken(root.lastChild)) root.appendChild(doc.createTextNode(''));
}

// Where the caret is, counted in characters of the string rather than in DOM
// positions. Measured by serializing everything in front of it, which costs a
// clone but means one definition of length rather than two that drift.
function caretOffset(root) {
  const sel = root.ownerDocument.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return valueOf(before.cloneContents()).length;
}

function placeCaret(root, offset) {
  const doc = root.ownerDocument;
  const range = doc.createRange();
  let seen = 0;
  let done = false;

  const visit = (parent) => {
    for (const child of parent.childNodes) {
      if (done) return;
      if (child.nodeType === 3) {
        const len = child.nodeValue.length;
        if (offset <= seen + len) { range.setStart(child, offset - seen); done = true; return; }
        seen += len;
      } else if (isToken(child)) {
        const len = child.dataset.raw.length;
        // landing anywhere inside a token means landing after it: there is no
        // inside to land in
        if (offset <= seen) { range.setStartBefore(child); done = true; return; }
        if (offset < seen + len) { range.setStartAfter(child); done = true; return; }
        seen += len;
      } else if (child.nodeName === 'BR') {
        if (offset <= seen) { range.setStartBefore(child); done = true; return; }
        seen += 1;
      } else {
        visit(child);
      }
    }
  };

  visit(root);
  if (done) range.collapse(true);
  else { range.selectNodeContents(root); range.collapse(false); }
  const sel = doc.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// What is half-typed at the caret. Read from the run of loose text the caret
// is in rather than from the whole string, or parking the caret after a
// finished @path badge would look exactly like typing one and pop the menu
// back open. A slash only counts in the first run of text there is.
function pendingAt(root) {
  const sel = root.ownerDocument.getSelection();
  if (!sel?.isCollapsed || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!root.contains(node) || node.nodeType !== 3) return null;
  const atStart = !node.previousSibling && node.parentNode === root;
  return pendingToken(node.nodeValue.slice(0, sel.anchorOffset), atStart);
}

// The token the caret is sitting immediately before or after, if it is sitting
// against one at all. Only for a collapsed caret: a selection that happens to
// touch a badge is an ordinary ranged delete.
function tokenBeside(root, direction) {
  const sel = root.ownerDocument.getSelection();
  if (!sel?.isCollapsed || !sel.rangeCount) return null;
  const { startContainer: node, startOffset: at } = sel.getRangeAt(0);
  if (!root.contains(node)) return null;

  if (node.nodeType === 3) {
    if (direction < 0 && at !== 0) return null;
    if (direction > 0 && at !== node.nodeValue.length) return null;
    const next = direction < 0 ? node.previousSibling : node.nextSibling;
    return isToken(next) ? next : null;
  }
  const index = direction < 0 ? at - 1 : at;
  const next = node.childNodes[index];
  return isToken(next) ? next : null;
}

const CAP = 200;

export const TokenInput = forwardRef(function TokenInput({
  value,
  onChange,
  onKeyDown,
  onPaste,
  onQuery,
  placeholder,
  className,
  ...rest
}, ref) {
  const boxRef = useRef(null);
  // What we last handed upwards. An incoming value that matches it is our own
  // echo coming back through React and must not redraw the box under the caret.
  // null until the first paint, which no string can match, so the box always
  // draws itself once on mount.
  const mine = useRef(null);
  const composing = useRef(false);
  const history = useRef({ stack: [{ text: value || '', caret: (value || '').length }], at: 0 });
  const pending = useRef(null);

  const markEmpty = (box, text) => box.classList.toggle('is-empty', !text);

  const emit = useCallback((text) => {
    mine.current = text;
    onChange(text);
  }, [onChange]);

  // Undo is ours. Taking the structural edits off Chromium's stack and leaving
  // the typing on it would give two half-working histories, so the box keeps
  // one of its own and swallows the shortcut.
  const record = useCallback((text, caret) => {
    const h = history.current;
    const top = h.stack[h.at];
    if (top && top.text === text) { top.caret = caret; return; }
    h.stack = h.stack.slice(0, h.at + 1);
    h.stack.push({ text, caret });
    if (h.stack.length > CAP) h.stack.shift();
    h.at = h.stack.length - 1;
  }, []);

  const flush = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    record(pending.current.text, pending.current.caret);
    pending.current = null;
  }, [record]);

  // Typing settles into one history entry per pause rather than one per key.
  const recordSoon = useCallback((text, caret) => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { text, caret, timer: setTimeout(() => { flush(); }, 350) };
  }, [flush]);

  const reportQuery = useCallback(() => {
    const box = boxRef.current;
    if (box && onQuery) onQuery(pendingAt(box));
  }, [onQuery]);

  // The one path every structural change goes through.
  const apply = useCallback((text, caret) => {
    const box = boxRef.current;
    if (!box) return;
    flush();
    render(box, text);
    placeCaret(box, caret);
    markEmpty(box, text);
    record(text, caret);
    emit(text);
    reportQuery();
  }, [emit, flush, record, reportQuery]);

  const restore = useCallback((step) => {
    const box = boxRef.current;
    const h = history.current;
    flush();
    const next = h.at + step;
    if (next < 0 || next >= h.stack.length) return;
    h.at = next;
    const { text, caret } = h.stack[next];
    render(box, text);
    placeCaret(box, caret);
    markEmpty(box, text);
    emit(text);
    reportQuery();
  }, [emit, flush, reportQuery]);

  useImperativeHandle(ref, () => ({
    focus: () => boxRef.current?.focus(),
    // Swap whatever is being typed at the caret for the finished token, and
    // leave a space after it so there is somewhere ordinary to carry on.
    insert: (token) => {
      const box = boxRef.current;
      if (!box) return;
      // Read the caret before touching focus: focusing an unfocused box moves
      // the selection, and the half-typed name would be lost with it.
      const text = valueOf(box);
      const offset = caretOffset(box) ?? text.length;
      const start = offset - (pendingAt(box)?.length ?? 0);
      const after = text.slice(offset);
      // A space after the badge, unless the sentence already has one there.
      const body = token.raw + (/^\s/.test(after) ? '' : ' ');
      apply(text.slice(0, start) + body + after, start + body.length);
      box.focus();
    },
  }), [apply]);

  // An incoming value that is not our own echo: a different chat, a cleared
  // box, or the text a stopped turn parked back here.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const next = value || '';
    if (next === mine.current) return;
    mine.current = next;
    render(box, next);
    markEmpty(box, next);
    history.current = { stack: [{ text: next, caret: next.length }], at: 0 };
    if (box.ownerDocument.activeElement === box) placeCaret(box, next.length);
  }, [value]);

  useEffect(() => () => { if (pending.current) clearTimeout(pending.current.timer); }, []);

  const handleInput = useCallback(() => {
    const box = boxRef.current;
    // Mid-composition the DOM is the IME's, not ours. Read it once it lands.
    if (composing.current) return;
    if (!canonical(box)) {
      const caret = caretOffset(box);
      const text = valueOf(box);
      render(box, text);
      placeCaret(box, caret ?? text.length);
      markEmpty(box, text);
      record(text, caret ?? text.length);
      emit(text);
      reportQuery();
      return;
    }
    const text = valueOf(box);
    markEmpty(box, text);
    emit(text);
    recordSoon(text, caretOffset(box) ?? text.length);
    reportQuery();
  }, [emit, record, recordSoon, reportQuery]);

  const handleBeforeInput = useCallback((e) => {
    if (composing.current) return;
    const box = boxRef.current;
    const back = e.nativeEvent.inputType === 'deleteContentBackward';
    const forward = e.nativeEvent.inputType === 'deleteContentForward';

    if (back || forward) {
      // Left alone, Chromium deletes the badge and then patches the line it
      // thinks it broke with a stray <br>, which shows up as a line break
      // nobody asked for.
      const token = tokenBeside(box, back ? -1 : 1);
      if (!token) return;
      e.preventDefault();
      const text = valueOf(box);
      const offset = caretOffset(box) ?? 0;
      const len = token.dataset.raw.length;
      const start = back ? offset - len : offset;
      apply(text.slice(0, start) + text.slice(start + len), start);
      return;
    }

    // Enter is handled in keydown; this catches the other ways a line break
    // can arrive, which would otherwise come in as markup.
    if (e.nativeEvent.inputType === 'insertParagraph' || e.nativeEvent.inputType === 'insertLineBreak') {
      e.preventDefault();
      const text = valueOf(box);
      const offset = caretOffset(box) ?? text.length;
      apply(`${text.slice(0, offset)}\n${text.slice(offset)}`, offset + 1);
    }
  }, [apply]);

  const handleKeyDown = useCallback((e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (composing.current || e.nativeEvent.isComposing) return;

    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === 'z') {
      e.preventDefault();
      return restore(e.shiftKey ? 1 : -1);
    }
    if ((e.metaKey || e.ctrlKey) && key === 'y') {
      e.preventDefault();
      return restore(1);
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = e.currentTarget.closest('form');
      const submit = form?.querySelector('button[type="submit"]');
      if (!submit?.disabled) form?.requestSubmit();
    }
  }, [onKeyDown, restore]);

  const handlePaste = useCallback((e) => {
    // The composer takes files off the clipboard first and stops the event if
    // it found any. Whatever is left is text, and it comes in flat.
    onPaste?.(e);
    if (e.defaultPrevented) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const box = boxRef.current;
    const current = valueOf(box);
    const sel = box.ownerDocument.getSelection();
    const offset = caretOffset(box) ?? current.length;
    // A paste over a selection replaces it, so the tail starts past whatever
    // was highlighted.
    const end = sel && !sel.isCollapsed ? offset + String(sel).length : offset;
    apply(current.slice(0, offset) + text + current.slice(end), offset + text.length);
  }, [apply, onPaste]);

  return (
    <div
      {...rest}
      ref={boxRef}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      contentEditable
      suppressContentEditableWarning
      // What InputGroupTextarea was carrying, and what this box has to carry
      // in its place: the slot the group hangs its focus ring off, and the
      // sizing that stops a flex-col group centring it on its own content.
      data-slot="input-group-control"
      data-placeholder={placeholder}
      className={cn(
        'tandem-input w-full flex-1 max-h-48 min-h-16 overflow-y-auto whitespace-pre-wrap break-words outline-none',
        className,
      )}
      onInput={handleInput}
      onBeforeInput={handleBeforeInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') reportQuery(); }}
      onMouseUp={reportQuery}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; handleInput(); }} />
  );
});
