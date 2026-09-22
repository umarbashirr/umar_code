'use strict';
// A chat is named after the first thing typed into it, and what gets typed is
// often a paste: a terminal dump wrapped in <pasted_content>, a screenshot
// placeholder, a code fence. Named as-is, the rail filled with markup.
// Shared by the main process, which names stored chats, and the renderer,
// which names the one being typed into.

const PASTE = /<pasted_content\b[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g;
const PLACEHOLDER = /\[(Image #\d+|Pasted text #\d+|Attached )[^\]]*\]/g;

function chatTitle(text) {
  const raw = String(text || '');
  const typed = raw
    .replace(PASTE, ' ')
    .replace(PLACEHOLDER, ' ')
    .replace(/```\w*/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (typed) return typed;
  if (/<pasted_content|\[Pasted text #/.test(raw)) return 'Pasted text';
  if (/\[Image #/.test(raw)) return 'Image';
  return '';
}

module.exports = { chatTitle };
