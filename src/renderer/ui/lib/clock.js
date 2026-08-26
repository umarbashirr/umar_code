// Four places on the agent screen count the same seconds, and each of them used
// to keep its own interval and its own copy of mm:ss. One of them rounded, one
// floored, and two clocks a pixel apart disagreeing by a beat is the sort of
// thing you notice without being able to say why. So: one formatter, one ticker.
import { useEffect, useState } from 'react';

export const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `0:${String(s).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// A repaint a second while `live`, and no timer at all when it is not. The
// count it keeps is thrown away. The point is that whoever called it reads
// Date.now() again on the way through.
export function useTick(live) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
}
