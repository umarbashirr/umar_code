/* The local bridge the MCP server talks to. The status bar says whether it is
   up, and offers the one command that registers it with claude. */
'use strict';
import { toast } from './toast.jsx';

export const bridge = { url: '', command: '' };

const listeners = new Set();
let version = 0;

export const getBridgeVersion = () => version;

export function subscribeBridge(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadBridge() {
  if (bridge.url) return bridge;
  const info = await window.tandem.bridgeInfo();
  bridge.url = info.url;
  bridge.command = `claude mcp add tandem -- node ${info.mcp}`;
  version += 1;
  for (const fn of listeners) fn();
  return bridge;
}

export async function copyMcpCommand() {
  await loadBridge();
  await navigator.clipboard.writeText(bridge.command);
  toast('Copied', bridge.command, [{ label: 'ok', primary: true }]);
}
