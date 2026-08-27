// The themes the app ships. Names and one line of description only: every
// colour lives in styles.css under [data-scheme="…"], so a swatch is drawn by
// setting the two attributes on a div rather than by repeating hex here, and
// the picker can never drift from what the window actually paints.
export const SCHEMES = [
  ['zinc', 'Zinc', 'The default. Neutral grey, no hue anywhere.'],
  ['ocean', 'Ocean', 'Cool blue-grey with a bright blue accent.'],
  ['forest', 'Forest', 'Muted greens, low saturation.'],
  ['violet', 'Violet', 'Purple ground, the loudest of the six.'],
  ['sand', 'Sand', 'Warm greys and amber.'],
  ['nord', 'Nord', 'The Nord palette: Polar Night and Snow Storm.'],
  ['aurora', 'Aurora', 'Rounder corners, softer surfaces, indigo on cool grey.'],
];

export const SCHEME_IDS = SCHEMES.map(([id]) => id);

export const isScheme = (id) => SCHEME_IDS.includes(id);

export const DEFAULT_SCHEME = 'zinc';
