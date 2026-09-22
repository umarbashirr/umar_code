// Cursor names a model with its default settings attached, as in
// `gpt-5.5[context=272k,reasoning=medium,fast=false]`. Those settings move
// between CLI releases, so a choice keyed on the whole value would be forgotten
// on every update. The part before the bracket is the model.
export const cursorModelId = (value) => String(value || '').split('[')[0];

export const isHidden = (m, hidden) =>
  m.provider === 'cursor' && !!hidden?.length && hidden.includes(cursorModelId(m.value));
