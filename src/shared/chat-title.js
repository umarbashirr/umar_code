'use strict';

const PASTE = /<pasted_content\b[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g;
const PLACEHOLDER = /\[(Image #\d+|Pasted text #\d+|Attached )[^\]]*\]/g;

// What the composer puts ahead of the typed text for a picked element, a
// picture or a file: a bracketed head line, indented detail lines, a blank
// line. The agent needs all of it. A title needs none of it, except the note
// someone wrote against it, which is the message when nothing was typed.
const ATTACHED = /^\[(?:preview element|attached [a-z]+)\][^\n]*(?:\n {2}[^\n]*)*\n\n/;
const NOTE = /\n {2}note: ([^\n]+)/g;

function chatTitle(text) {
  let raw = String(text || '');
  const notes = [];
  for (let m; (m = ATTACHED.exec(raw));) {
    for (const n of m[0].matchAll(NOTE)) notes.push(n[1]);
    raw = raw.slice(m[0].length);
  }
  const typed = raw
    .replace(PASTE, ' ')
    .replace(PLACEHOLDER, ' ')
    .replace(/```\w*/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A bare skill says which tool, not what about. The note says what about.
  if (notes.length && (!typed || /^\/\S+$/.test(typed))) return notes.join(' ').replace(/\s+/g, ' ').trim();
  if (typed) return typed;
  if (/<pasted_content|\[Pasted text #/.test(raw)) return 'Pasted text';
  if (/\[Image #/.test(raw)) return 'Image';
  return '';
}

module.exports = { chatTitle };
