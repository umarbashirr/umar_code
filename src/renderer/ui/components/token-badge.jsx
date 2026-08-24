import { cn } from '@/lib/utils';

// The icons live here as raw path data rather than as lucide-react components,
// because the composer has to stamp the same badge as a plain DOM node and
// React is not involved in that half. One definition, two renderers, no chance
// of a skill looking like one thing in the box and another in the transcript.
const ICON = {
  skill: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  path: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/>',
  element: '<circle cx="12" cy="12" r="8"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
};

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const tokenClass = (kind) => `tandem-token tok-${kind}`;

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// The composer's copy. contenteditable="false" is what makes it one atom: the
// caret cannot land inside it and one backspace takes the whole thing.
export function tokenElement(doc, token) {
  const el = doc.createElement('span');
  el.className = tokenClass(token.kind);
  el.contentEditable = 'false';
  el.dataset.raw = token.raw;
  el.dataset.kind = token.kind;
  el.title = token.title || token.raw;
  el.innerHTML = `<svg ${SVG_ATTRS}>${ICON[token.kind] || ''}</svg><span>${escape(token.label)}</span>`;
  return el;
}

export function TokenBadge({ kind, label, title, className }) {
  return (
    <span className={cn(tokenClass(kind), className)} title={title}>
      {/* the same path data the composer stamps, so the two cannot drift */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: ICON[kind] || '' }} />
      <span>{label}</span>
    </span>
  );
}
