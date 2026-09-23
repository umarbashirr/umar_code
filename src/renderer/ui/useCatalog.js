import { useCallback, useEffect, useState } from 'react';

const tandem = () => window.tandem;
const EMPTY = { skills: [], agents: [], mcp: [], live: false, connectors: true };

// The skills and MCP servers this folder has. Main reads them off disk, so the
// lists are there on first paint; a running session corrects them through
// onChanged. Every action here returns the whole listing back, which keeps the
// panel and the config files from drifting apart.
export function useCatalog() {
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState(null);

  const take = useCallback((next) => {
    if (!next) return;
    setError(next.error || null);
    if (next.skills) {
      setData({
        skills: next.skills,
        agents: next.agents || [],
        mcp: next.mcp || [],
        live: !!next.live,
        connectors: next.connectors !== false,
      });
    }
  }, []);

  useEffect(() => {
    tandem().catalog.info().then(take).catch(() => {});
    const off = tandem().catalog.onChanged(take);
    const offProject = tandem().project.onChanged(() => { tandem().catalog.info().then(take).catch(() => {}); });
    return () => { off?.(); offProject?.(); };
  }, [take]);

  const run = useCallback(async (fn) => {
    try { take(await fn()); } catch (e) { setError(e.message); }
  }, [take]);

  // A server's add or sign-in in flight, or how it failed, keyed by name. It
  // lives here rather than in the row so a sign-in that takes minutes in the
  // browser survives the page switching tabs. Its errors belong to the row.
  const [pending, setPending] = useState({});
  const forServer = useCallback(async (name, fn) => {
    setPending((p) => ({ ...p, [name]: { busy: true } }));
    let error = null;
    try {
      const next = await fn();
      error = next?.error || null;
      take({ ...next, error: null });
    } catch (e) {
      error = e.message;
    }
    setPending(({ [name]: _, ...rest }) => (error ? { ...rest, [name]: { error } } : rest));
  }, [take]);

  return {
    ...data,
    error,
    pending,
    refresh: () => run(() => tandem().catalog.refresh()),
    setSkill: (name, enabled) => run(() => tandem().catalog.skill(name, enabled)),
    setConnectors: (enabled) => run(() => tandem().catalog.connectors(enabled)),
    toggleMcp: (name, enabled) => run(() => tandem().catalog.mcpToggle(name, enabled)),
    reconnectMcp: (name) => run(() => tandem().catalog.mcpReconnect(name)),
    loginMcp: async (name) => {
      const res = await tandem().catalog.mcpLogin(name);
      if (res.error) { setError(res.error); return null; }
      setError(null);
      return res.command;
    },
    addMcp: (server) => run(() => tandem().catalog.mcpAdd(server)),
    addGalleryMcp: (name, config) => forServer(name, () => tandem().catalog.mcpAdd({ name, scope: 'tandem', config })),
    authMcp: (name) => forServer(name, () => tandem().catalog.mcpAuth(name)),
    addTokenMcp: (name, token) => forServer(name, () => tandem().catalog.mcpAddToken(name, token)),
    cliSignedIn: (name) => tandem().catalog.mcpCliSignedIn(name),
    openTokenPage: (name) => tandem().catalog.mcpTokenPage(name),
    removeMcp: (name, scope) => run(() => tandem().catalog.mcpRemove(name, scope)),
  };
}
