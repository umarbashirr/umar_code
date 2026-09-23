// Cursor names a model with its default settings attached, as in
// `gpt-5.5[context=272k,reasoning=medium,fast=false]`. Those settings move
// between CLI releases, so a choice keyed on the whole value would be forgotten
// on every update. The part before the bracket is the model.
export const cursorModelId = (value) => String(value || '').split('[')[0];

/* Which of a CLI's models the picker lists. A row is { id, free }.

   Most CLIs keep what you hid, so a model they add later shows up. OpenCode
   lists dozens of paid models beside a handful of free ones that work without
   a login, so it keeps what you chose to show, and until you choose, that is
   the free ones. */
function hiding(provider, id, label) {
  return {
    id,
    isShown: (row, s) => !s[provider].hidden.includes(row.id),
    setShown(rows, on, s) {
      const ids = rows.map((r) => r.id);
      const was = s[provider].hidden;
      const hidden = on ? was.filter((h) => !ids.includes(h)) : [...was, ...ids];
      return { [provider]: { hidden: [...new Set(hidden)] } };
    },
    note: `Models ${label} adds later are shown until you hide them.`,
  };
}

const byValue = (m) => m.value;

export const VISIBILITY = {
  // The 1M-context copy of a Claude model is the same model to choose.
  claude: hiding('claude', (m) => m.value.replace(/\[1m\]$/, ''), 'Claude'),
  cursor: hiding('cursor', (m) => cursorModelId(m.value), 'Cursor'),
  grok: hiding('grok', byValue, 'Grok'),
  codex: hiding('codex', byValue, 'Codex'),
  opencode: {
    id: byValue,
    isShown: (row, s) => (s.opencode.shown ? s.opencode.shown.includes(row.id) : !!row.free),
    setShown(rows, on, s, all) {
      const ids = rows.map((r) => r.id);
      const was = all.filter((r) => VISIBILITY.opencode.isShown(r, s)).map((r) => r.id);
      return { opencode: { shown: on ? [...new Set([...was, ...ids])] : was.filter((id) => !ids.includes(id)) } };
    },
    note: 'Until you change this, the free models are shown. After that, models OpenCode adds later stay hidden until you show them.',
    reset: { label: 'Free only', patch: { opencode: { shown: null } } },
  },
};

export function isHidden(m, settings) {
  const v = settings && VISIBILITY[m.provider];
  return !!v && !v.isShown({ id: v.id(m), free: m.free }, settings);
}
