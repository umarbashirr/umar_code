/* The Agents tab and the chat beside it.

   A subagent's work used to be drawn inside the chat, under its row, and three
   running at once buried the conversation in three growing logs. The chat now
   keeps one line per agent and the transcript lives in the right column.

   The chat owns the state: useAgent builds the agent rows and loads a replayed
   one's transcript. So the chat publishes what it has here on every render,
   and the view reads it back. The store adds one thing of its own, which agent
   the tab is showing.

   Same shape as the other stores here: a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { runCommand } from '../../app.js';

let agent = null; // the active chat's useAgent() value
let chat = null;
let selected = null; // an agent row's id

const listeners = new Set();
let version = 0;

export const getAgentsVersion = () => version;

export function subscribeAgents(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

// Every agent row in the chat, at any depth, oldest first. An agent can start
// agents of its own, and those rows are as worth opening as the top ones.
function collect(items, out = []) {
  for (const it of items) {
    if (it.kind !== 'agent') continue;
    out.push(it);
    collect(it.children || [], out);
  }
  return out;
}

export function publish(next) {
  if (next === agent) return;
  // Another chat's agents are not this one's. The selection goes with it.
  if (next.activeKey !== chat) {
    chat = next.activeKey;
    selected = null;
  }
  agent = next;
  changed();
}

export const agentsState = () => ({
  agent,
  agents: agent ? collect(agent.items) : [],
  selected,
});

export function selectAgent(id) {
  if (selected === id) return;
  selected = id;
  changed();
}

// A row in the chat or a chip in the strip was clicked. Put that agent on
// screen in the focused folder's column.
export function showAgent(id) {
  selectAgent(id);
  runCommand('agents', true);
}
