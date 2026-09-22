'use strict';

// A chat needs the human when an undecided permission (or AskUserQuestion) card
// sits in its transcript. Subagent `waiting` on an agent row is a different
// signal and stays local to the fleet strip.
function chatWaiting(items) {
  return (items || []).some((it) => it.kind === 'perm' && !it.decided);
}

// One badge for the rail row. Waiting beats busy so a parked approval does not
// read as ordinary work.
function railBadge({ busy, agents, waiting }) {
  if (waiting) return { label: 'needs you', tone: 'wait' };
  if (busy) return { label: agents ? `${agents} agents` : 'working', tone: 'busy' };
  return null;
}

// Marked-done chats fold away unless something still needs attention.
function keepRailOpen({ busy, waiting }) {
  return !!(busy || waiting);
}

module.exports = { chatWaiting, railBadge, keepRailOpen };
