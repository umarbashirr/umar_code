'use strict';

function hasUndecidedPerm(items) {
  return (items || []).some((it) => it.kind === 'perm' && !it.decided);
}

function railBadge({ busy, agents, waiting }) {
  if (waiting) return { label: 'needs you', tone: 'wait' };
  if (busy) return { label: agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : 'working', tone: 'busy' };
  return null;
}

function keepRailOpen({ busy, waiting }) {
  return !!(busy || waiting);
}

module.exports = { hasUndecidedPerm, railBadge, keepRailOpen };
