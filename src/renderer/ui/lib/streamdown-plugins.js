import { useEffect, useMemo, useState } from 'react';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';

// mermaid and katex were static imports, so every window parsed mermaid, dagre,
// rough and katex at startup to render chat messages that are almost always
// prose and code. Load them the first time a message actually needs one.
//
// cjk and code stay eager: a coding agent emits fenced code constantly, and
// shiki already splits its grammars into their own chunks.
const BASE = { cjk, code };

const NEEDS = {
  math: /(?:\$\$[\s\S]+?\$\$)|(?:\$[^$\n]+\$)|\\\(|\\\[/,
  mermaid: /```\s*mermaid/i,
};

const loaders = {
  math: () => import('@streamdown/math').then((m) => m.math),
  mermaid: () => import('@streamdown/mermaid').then((m) => m.mermaid),
};

// Module-level, not per-component: two messages with a diagram should share one
// mermaid, and a plugin already fetched must not make the next message wait.
const loaded = {};
const inflight = {};

function request(name, onReady) {
  if (loaded[name]) return true;
  inflight[name] ||= loaders[name]()
    .then((plugin) => { loaded[name] = plugin; })
    .catch(() => { /* leave it unloaded; the fence renders as plain code */ });
  inflight[name].then(onReady);
  return false;
}

export function usePlugins(text) {
  const wanted = useMemo(() => {
    const body = typeof text === 'string' ? text : '';
    return Object.keys(NEEDS).filter((name) => NEEDS[name].test(body));
  }, [text]);

  // Only used to re-render once a plugin lands; the plugins themselves live in
  // the module scope above.
  const [, bump] = useState(0);

  useEffect(() => {
    let live = true;
    for (const name of wanted) request(name, () => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, [wanted]);

  const ready = wanted.filter((name) => loaded[name]).join(',');

  return useMemo(() => {
    if (!ready) return BASE;
    const out = { ...BASE };
    for (const name of ready.split(',')) out[name] = loaded[name];
    return out;
  }, [ready]);
}
