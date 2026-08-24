import { useEffect, useState } from 'react';

const EMPTY = { dir: '', name: '', branch: null, chosen: false, home: '', recents: [] };

// The folder this window is rooted at, and the branch it is on. The chat header
// shows both, so it needs them in React rather than in the vanilla shell.
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
