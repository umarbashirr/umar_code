// Three things in a prompt are not prose: the skill it starts with, a file it
// points at, and whatever was clipped to it. Splitting them out of the string
// happens here and nowhere else, so the composer and the transcript can never
// disagree about what counts as a token.
//
// A string goes in and a string comes back out unchanged. That round trip is
// the whole contract: everything upstream — the per-chat drafts, the queue,
// the text a stopped turn parks back in the box — still passes plain text.

// Only at the very start, which is how the CLI reads a slash command too.
const SKILL = /^\/([a-zA-Z0-9][\w:.-]*)/;

// Preceded by a space or an opening bracket, so an email address in the middle
// of a sentence is left alone. The last character cannot be punctuation, or
// "look at @src/app.js." would swallow the full stop.
const PATH = /(^|[\s([])@([\w.\-/]*[\w\-/])/;

// What the composer prepends for an attachment: a bracketed head line, its
// indented detail lines, and a blank line between blocks.
const ATTACHED = /^\[(preview element|attached image|attached file)\]([^\n]*)((?:\n {2}[^\n]*)*)\n\n/;

const basename = (p) => {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
};

// The element picker writes the full description across several indented
// lines. The one worth showing is the element itself.
function attachedLabel(head, detail, tail) {
  if (head === 'preview element') {
    const line = /\n {2}element: (.+)/.exec(tail);
    return line ? line[1].replace(/"/g, '') : 'element';
  }
  return detail.trim() || head;
}

export function parse(input) {
  const nodes = [];
  let rest = String(input ?? '');
  const text = (t) => { if (t) nodes.push({ type: 'text', text: t }); };

  // Attachments are always the head of the message, one block each.
  for (let m; (m = ATTACHED.exec(rest));) {
    nodes.push({
      type: 'token',
      kind: 'element',
      raw: m[0],
      label: attachedLabel(m[1], m[2], m[3]),
      title: m[0].trim(),
    });
    rest = rest.slice(m[0].length);
  }

  const skill = SKILL.exec(rest);
  if (skill) {
    nodes.push({ type: 'token', kind: 'skill', raw: skill[0], label: skill[1], title: `the ${skill[1]} skill` });
    rest = rest.slice(skill[0].length);
  }

  for (let m; (m = PATH.exec(rest));) {
    const at = m.index + m[1].length;
    text(rest.slice(0, at));
    const raw = `@${m[2]}`;
    nodes.push({ type: 'token', kind: 'path', raw, label: basename(m[2]), title: m[2] });
    rest = rest.slice(at + raw.length);
  }

  text(rest);
  return nodes;
}

export const serialize = (nodes) =>
  nodes.map((n) => (n.type === 'text' ? n.text : n.raw)).join('');

// A token built from a pick rather than found in a string. The label is what
// the badge shows; raw is what the agent receives, which for a file is the
// path in full however little of it is on screen.
export function tokenFor(kind, raw) {
  const [node] = parse(raw).filter((n) => n.type === 'token' && n.kind === kind);
  return node || { type: 'token', kind, raw, label: raw, title: raw };
}

// What is being typed at the caret, if it is the start of a token. `before` is
// the run of loose text to the left of the caret, never a finished token: a
// caret parked after an @path badge is sitting next to something already
// decided, not halfway through typing it.
export function pendingToken(before, atStart) {
  const slash = /^\/([\w:.-]*)$/.exec(before);
  if (slash && atStart) return { kind: 'skill', query: slash[1], length: slash[0].length };

  const at = /(?:^|[\s([])@([\w.\-/]*)$/.exec(before);
  if (at) return { kind: 'path', query: at[1], length: at[1].length + 1 };

  return null;
}
