// The themes the app ships. Names and one line of description only: what a
// theme is lives in styles.css under [data-scheme="…"], so a swatch is drawn
// by setting the two attributes on a div rather than by repeating hex here,
// and the picker can never drift from what the window actually paints.
//
// The last three are not recolours. A theme owns the corner radius, the
// shadow, how thick a border is and whether a surface is see-through, so
// Aurora is rounder than the rest, Brutalist has no corners at all, and Glass
// paints a ground on <html> and tints everything above it.
export const SCHEMES = [
  ['zinc', 'Zinc', 'The default. Neutral grey, no hue anywhere.'],
  ['ocean', 'Ocean', 'Cool blue-grey with a bright blue accent.'],
  ['forest', 'Forest', 'Muted greens, low saturation.'],
  ['violet', 'Violet', 'Purple ground, the most saturated of the recolours.'],
  ['sand', 'Sand', 'Warm greys and amber.'],
  ['nord', 'Nord', 'The Nord palette: Polar Night and Snow Storm.'],
  ['aurora', 'Aurora', 'Rounder corners, softer surfaces, indigo on cool grey.'],
  ['brutal', 'Brutalist', 'Square corners, two-pixel borders, shadows that are slabs.'],
  ['glass', 'Glass', 'Translucent panels blurred over a coloured ground.'],
];

export const SCHEME_IDS = SCHEMES.map(([id]) => id);

export const isScheme = (id) => SCHEME_IDS.includes(id);

export const DEFAULT_SCHEME = 'zinc';
