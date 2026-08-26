#!/usr/bin/env node
'use strict';
// MCP front end to the preview pane, so an agent in the terminal can see and
// drive the page instead of guessing at it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const state = require('../cli/state');

// Which project the agent is working in. The window may have several open, so
// the request has to say. The terminal that started this server exports
// TANDEM_CWD, and that is a better answer than the shell's cwd, which drifts
// as the agent moves around the tree.
const callerCwd = () => process.env.TANDEM_CWD || process.cwd();

function connection() {
  if (process.env.TANDEM_BRIDGE_URL && process.env.TANDEM_TOKEN) {
    return { url: process.env.TANDEM_BRIDGE_URL, token: process.env.TANDEM_TOKEN };
  }
  const s = state.find(callerCwd());
  if (!s) throw new Error('no tandem window open for this folder. Run `tandem .` first.');
  return { url: s.url, token: s.token };
}

async function call(tool, args = {}) {
  const { url, token } = connection();
  const res = await fetch(`${url}/tool/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tandem-token': token, 'x-tandem-cwd': callerCwd() },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({ error: `bad response (${res.status})` }));
  if (!res.ok || body.error) throw new Error(body.error || `request failed (${res.status})`);
  return body.result;
}

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

const server = new McpServer(
  { name: 'tandem', version: '0.1.0' },
  { instructions: 'Controls the preview browser pane sitting next to this terminal. Call browser_snapshot first: it returns [ref=eN] handles that browser_click, browser_fill and browser_hover accept. Use browser_console and browser_network to see what the page reported after an action.' },
);

const wrap = (fn) => async (args) => {
  try { return await fn(args || {}); }
  catch (e) { return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }; }
};

server.registerTool('browser_navigate',
  { title: 'Open a URL', description: 'Load a URL in the preview pane. Bare ports work: "3000" becomes http://localhost:3000.', inputSchema: { url: z.string() } },
  wrap(async ({ url }) => text(await call('navigate', { url }))));

server.registerTool('browser_snapshot',
  { title: 'Snapshot the page', description: 'Accessibility-style outline of what is on screen, with [ref=eN] handles for interaction. Start here.', inputSchema: {} },
  wrap(async () => text(await call('snapshot'))));

server.registerTool('browser_text',
  { title: 'Read page text', description: 'Visible text of the current page.', inputSchema: { max: z.number().optional() } },
  wrap(async (a) => text(await call('text', a))));

server.registerTool('browser_click',
  { title: 'Click', description: 'Click an element by [ref=eN] handle or CSS selector, with a real mouse event.', inputSchema: { target: z.string(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().optional() } },
  wrap(async (a) => text(await call('click', a))));

server.registerTool('browser_fill',
  { title: 'Fill a field', description: 'Set the value of an input, textarea, or contenteditable and fire input/change events.', inputSchema: { target: z.string(), value: z.string() } },
  wrap(async (a) => text(await call('fill', a))));

server.registerTool('browser_type',
  { title: 'Type', description: 'Send real keystrokes, optionally focusing an element first. Use this when the page listens for keydown.', inputSchema: { text: z.string(), target: z.string().optional(), delay: z.number().optional() } },
  wrap(async (a) => text(await call('type', a))));

server.registerTool('browser_press',
  { title: 'Press a key', description: 'Press a key or chord, for example "Enter", "Escape", "ctrl+a".', inputSchema: { key: z.string() } },
  wrap(async (a) => text(await call('press', a))));

server.registerTool('browser_select',
  { title: 'Select an option', description: 'Choose an option in a select element.', inputSchema: { target: z.string(), value: z.string() } },
  wrap(async (a) => text(await call('select', a))));

server.registerTool('browser_hover',
  { title: 'Hover', description: 'Move the mouse over an element, for menus and tooltips.', inputSchema: { target: z.string() } },
  wrap(async (a) => text(await call('hover', a))));

server.registerTool('browser_scroll',
  { title: 'Scroll', description: 'Scroll by a pixel delta, or scroll an element into view.', inputSchema: { dy: z.number().optional(), target: z.string().optional() } },
  wrap(async (a) => text(a.target ? await call('scrollTo', a) : await call('scroll', a))));

server.registerTool('browser_screenshot',
  { title: 'Screenshot', description: 'Capture the page as an image. Use it to check layout and visual regressions.', inputSchema: { fullPage: z.boolean().optional(), target: z.string().optional() } },
  wrap(async (a) => {
    const shot = await call('screenshot', a);
    const data = fs.readFileSync(shot.path).toString('base64');
    return {
      content: [
        { type: 'image', data, mimeType: 'image/png' },
        { type: 'text', text: `${shot.width}x${shot.height} saved to ${shot.path}` },
      ],
    };
  }));

server.registerTool('browser_console',
  { title: 'Read the console', description: 'Console messages the page has logged since the last navigation.', inputSchema: { level: z.enum(['debug', 'info', 'warning', 'error']).optional(), limit: z.number().optional() } },
  wrap(async (a) => {
    const rows = await call('console', a);
    return text(rows.length ? rows.map((r) => `[${r.level}] ${r.message}  (${r.source})`).join('\n') : '(console is empty)');
  }));

server.registerTool('browser_network',
  { title: 'Read failed requests', description: 'Requests that failed or returned 4xx/5xx since the last navigation.', inputSchema: { limit: z.number().optional() } },
  wrap(async (a) => {
    const rows = await call('network', a);
    return text(rows.length ? rows.map((r) => `${r.kind} ${r.status || r.error || ''} ${r.method || ''} ${r.url}`).join('\n') : '(no failed requests)');
  }));

server.registerTool('browser_evaluate',
  { title: 'Run JavaScript', description: 'Evaluate JavaScript in the page and return the result.', inputSchema: { code: z.string() } },
  wrap(async (a) => text(await call('evaluate', a))));

server.registerTool('browser_wait',
  { title: 'Wait', description: 'Wait for a selector to appear, a fixed delay, or the network to go quiet.', inputSchema: { selector: z.string().optional(), ms: z.number().optional(), timeout: z.number().optional() } },
  wrap(async (a) => text(await call('waitFor', { networkIdle: !a.selector && !a.ms, ...a }))));

server.registerTool('browser_viewport',
  { title: 'Set viewport', description: 'Emulate a viewport size to check responsive layout. Omit both numbers to clear.', inputSchema: { width: z.number().optional(), height: z.number().optional() } },
  wrap(async (a) => text(a.width && a.height ? await call('setViewport', a) : await call('clearViewport'))));

server.registerTool('browser_back', { title: 'Back', description: 'Go back one history entry.', inputSchema: {} }, wrap(async () => text(await call('back'))));
server.registerTool('browser_forward', { title: 'Forward', description: 'Go forward one history entry.', inputSchema: {} }, wrap(async () => text(await call('forward'))));
server.registerTool('browser_reload', { title: 'Reload', description: 'Reload the current page.', inputSchema: {} }, wrap(async () => text(await call('reload'))));
server.registerTool('browser_state', { title: 'Page state', description: 'Current url, title and loading state.', inputSchema: {} }, wrap(async () => text(await call('state'))));

server.registerTool('browser_show',
  { title: 'Show the preview to the human', description: 'Open or close the preview pane in the app window. Open it when you want the person to look at what you just did; the pane starts hidden and the page keeps working while it is closed.', inputSchema: { open: z.boolean().optional() } },
  wrap(async (a) => text(await call('preview', a))));

server.registerTool('browser_highlight',
  { title: 'Highlight for the human', description: 'Flash a box around an element so the person watching can see which one you mean.', inputSchema: { target: z.string() } },
  wrap(async (a) => text(await call('highlight', a))));

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`tandem mcp: ${e.message}\n`);
  process.exit(1);
});
