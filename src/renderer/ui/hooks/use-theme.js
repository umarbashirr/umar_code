import { useEffect, useState } from 'react';

import { schemeState, themeState } from '../../app.js';

const read = () => ({ ...themeState(), scheme: schemeState() });

// What the window is painted in right now: the preference ('system' included),
// the light or dark it currently means, and which palette. Following the system
// means following it while the window is open, not only at launch, so this
// watches the media query as well as the settings file.
export function useTheme() {
  const [theme, setTheme] = useState(read);

  useEffect(() => {
    const sync = () => setTheme(read());
    const offSettings = window.tandem.settings.onChanged(sync);
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);
    return () => { offSettings?.(); media.removeEventListener('change', sync); };
  }, []);

  return theme;
}
