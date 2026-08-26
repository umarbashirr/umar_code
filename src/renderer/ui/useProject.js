import { useEffect, useState } from 'react';

const EMPTY = { dir: '', name: '', branch: null, chosen: false, home: '', recents: [], projects: [], focused: '' };

// The folders this window has open, which of them is focused, and the branch
// each is on. The chat header shows the folder its own chat runs in, so it needs
// the whole set rather than only the focused one.
export function useProject() {
  const [info, setInfo] = useState(EMPTY);

  useEffect(() => {
    let alive = true;
    const load = () => window.tandem.project.info().then((i) => alive && setInfo(i)).catch(() => {});
    load();
    const off = window.tandem.project.onChanged((i) => alive && setInfo(i));
    // Nothing tells this window when the branch changes: it happens in a shell,
    // or in another terminal entirely. Main reads one file to answer, so asking
    // every few seconds costs less than watching the ref would.
    const timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => { alive = false; off?.(); clearInterval(timer); };
  }, []);

  return info;
}

export const shortPath = (p, home) => {
  if (!p) return '';
  if (p === home) return '~';
  return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
};
