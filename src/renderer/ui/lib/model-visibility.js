// Cursor names a model with its default settings attached, as in
// `gpt-5.5[context=272k,reasoning=medium,fast=false]`. Those settings move
// between CLI releases, so a choice keyed on the whole value would be forgotten
// on every update. The part before the bracket is the model.
export const cursorModelId = (value) => String(value || '').split('[')[0];

/* Which of a CLI's models the picker lists, for the CLIs that list more than
   anyone wants to scroll. A row is { id, free }.

   Cursor keeps what you hid, so a model it adds later shows up. OpenCode lists
   dozens of paid models beside a handful of free ones that work without a
   login, so it keeps what you chose to show, and until you choose, that is the
   free ones. */
export const VISIBILITY = {
  cursor: {
    id: (m) => cursorModelId(m.value),
    isShown: (row, s) => !s.cursor.hidden.includes(row.id),
    setShown(rows, on, s) {
      const ids = rows.map((r) => r.id);
      const hidden = on ? s.cursor.hidden.filter((h) => !ids.includes(h)) : [...s.cursor.hidden, ...ids];
      return { cursor: { hidden: [...new Set(hidden)] } };
    },
    note: 'Models Cursor adds later are shown until you hide them.',
  },
  opencode: {
    id: (m) => m.value,
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
