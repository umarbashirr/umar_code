'use strict';
// One definition of the browser tool surface, used three ways: over the bridge
// by the tandem CLI, over stdio by the MCP server, and in-process by the agent
// panel. Only the transport differs.

/**
 * @param {typeof import('zod').z} z
 * @returns {Array<{name: string, bridgeTool: string, title: string, description: string,
 *                  schema: object, format?: 'image', map?: (a: object) => object}>}
 */
function browserTools(z) {
  return [
    {
      name: 'browser_navigate', bridgeTool: 'navigate', title: 'Open a URL',
      description: 'Load a URL in the preview pane and show it to the human. Bare ports work: "3000" becomes http://localhost:3000.',
      schema: { url: z.string() },
    },
    {
      name: 'browser_snapshot', bridgeTool: 'snapshot', title: 'Snapshot the page',
      description: 'Accessibility-style outline of what is on screen, with [ref=eN] handles for interaction. Start here, and take a fresh one after every navigation.',
      schema: {},
    },
    {
      name: 'browser_text', bridgeTool: 'text', title: 'Read page text',
      description: 'Visible text of the current page.',
      schema: { max: z.number().optional() },
    },
    {
      name: 'browser_click', bridgeTool: 'click', title: 'Click',
      description: 'Click an element by [ref=eN] handle or CSS selector, using a real mouse event.',
      schema: { target: z.string(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().optional() },
    },
    {
      name: 'browser_fill', bridgeTool: 'fill', title: 'Fill a field',
      description: 'Set the value of an input, textarea or contenteditable and fire input/change events.',
      schema: { target: z.string(), value: z.string() },
    },
    {
      name: 'browser_type', bridgeTool: 'type', title: 'Type',
      description: 'Send real keystrokes, optionally focusing an element first. Use this when the page listens for keydown.',
      schema: { text: z.string(), target: z.string().optional(), delay: z.number().optional() },
    },
    {
      name: 'browser_press', bridgeTool: 'press', title: 'Press a key',
      description: 'Press a key or chord, for example "Enter", "Escape", "ctrl+a".',
      schema: { key: z.string() },
    },
    {
      name: 'browser_select', bridgeTool: 'select', title: 'Select an option',
      description: 'Choose an option in a select element.',
      schema: { target: z.string(), value: z.string() },
    },
    {
      name: 'browser_hover', bridgeTool: 'hover', title: 'Hover',
      description: 'Move the mouse over an element, for menus and tooltips.',
      schema: { target: z.string() },
    },
    {
      name: 'browser_scroll', bridgeTool: 'scroll', title: 'Scroll',
      description: 'Scroll by a pixel delta, or scroll an element into view.',
      schema: { dy: z.number().optional(), target: z.string().optional() },
      route: (a) => (a.target ? 'scrollTo' : 'scroll'),
    },
    {
      name: 'browser_screenshot', bridgeTool: 'screenshot', title: 'Screenshot',
      description: 'Capture the page as an image. Use it to check layout, spacing and visual regressions.',
      schema: { fullPage: z.boolean().optional(), target: z.string().optional() },
      format: 'image',
    },
    {
      name: 'browser_console', bridgeTool: 'console', title: 'Read the console',
      description: 'Console messages the page logged since the last navigation. Check this after any action that should have worked.',
      schema: { level: z.enum(['debug', 'info', 'warning', 'error']).optional(), limit: z.number().optional() },
      render: (rows) => (rows.length ? rows.map((r) => `[${r.level}] ${r.message}  (${r.source})`).join('\n') : '(console is empty)'),
    },
    {
      name: 'browser_network', bridgeTool: 'network', title: 'Read failed requests',
      description: 'Requests that failed or returned 4xx/5xx since the last navigation.',
      schema: { limit: z.number().optional() },
      render: (rows) => (rows.length ? rows.map((r) => `${r.kind} ${r.status || r.error || ''} ${r.method || ''} ${r.url}`).join('\n') : '(no failed requests)'),
    },
    {
      name: 'browser_evaluate', bridgeTool: 'evaluate', title: 'Run JavaScript',
      description: 'Evaluate JavaScript in the page and return the result.',
      schema: { code: z.string() },
    },
    {
      name: 'browser_wait', bridgeTool: 'waitFor', title: 'Wait',
      description: 'Wait for a selector to appear, a fixed delay, or the network to go quiet.',
      schema: { selector: z.string().optional(), ms: z.number().optional(), timeout: z.number().optional() },
      map: (a) => ({ networkIdle: !a.selector && !a.ms, ...a }),
    },
    {
      name: 'browser_viewport', bridgeTool: 'setViewport', title: 'Set viewport',
      description: 'Emulate a viewport size to check responsive layout. Omit both numbers to clear the emulation.',
      schema: { width: z.number().optional(), height: z.number().optional() },
      route: (a) => (a.width && a.height ? 'setViewport' : 'clearViewport'),
    },
    { name: 'browser_back', bridgeTool: 'back', title: 'Back', description: 'Go back one history entry.', schema: {} },
    { name: 'browser_forward', bridgeTool: 'forward', title: 'Forward', description: 'Go forward one history entry.', schema: {} },
    { name: 'browser_reload', bridgeTool: 'reload', title: 'Reload', description: 'Reload the current page.', schema: {} },
    { name: 'browser_state', bridgeTool: 'state', title: 'Page state', description: 'Current url, title and loading state.', schema: {} },
    {
      name: 'browser_show', bridgeTool: 'preview', title: 'Show the preview to the human',
      description: 'Open or close the preview pane in the app window. Open it when you want the person to look at what you just did. The page keeps working while the pane is closed.',
      schema: { open: z.boolean().optional() },
    },
    {
      name: 'browser_highlight', bridgeTool: 'highlight', title: 'Highlight for the human',
      description: 'Flash a box around an element so the person watching can see which one you mean.',
      schema: { target: z.string() },
    },
  ];
}

const INSTRUCTIONS = [
  'You are working next to a live preview browser. It is a real Chromium view the human can see.',
  'Call browser_snapshot to perceive the page: it returns [ref=eN] handles that browser_click, browser_fill and browser_hover accept.',
  'Refs are dropped on navigation, so snapshot again after loading a page.',
  'After any action that should have changed something, check browser_console and browser_network before concluding it worked.',
].join(' ');

module.exports = { browserTools, INSTRUCTIONS };
