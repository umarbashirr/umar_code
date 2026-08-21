'use strict';
// The tool surface itself. The bridge, the MCP server and the agent panel all
// end up here.

const TOOLS = {
  navigate: { args: '{ url }', help: 'Load a URL in the preview pane. Bare ports and hostnames are expanded ("3000" -> http://localhost:3000).' },
  back: { args: '{}', help: 'Go back one entry in history.' },
  forward: { args: '{}', help: 'Go forward one entry in history.' },
  reload: { args: '{}', help: 'Reload the current page.' },
  snapshot: { args: '{ max? }', help: 'Accessibility-style outline of the page with [ref=eN] handles. Start here: refs feed click/fill/hover.' },
  text: { args: '{ max? }', help: 'Visible text of the page.' },
  html: { args: '{ max? }', help: 'Raw outer HTML.' },
  click: { args: '{ target, button?, clickCount?, modifiers? }', help: 'Click a ref from snapshot or a CSS selector, using a real mouse event.' },
  hover: { args: '{ target }', help: 'Move the mouse over an element.' },
  fill: { args: '{ target, value }', help: 'Set the value of an input, textarea, or contenteditable and fire input/change.' },
  select: { args: '{ target, value }', help: 'Pick an option in a <select>.' },
  type: { args: '{ text, target?, delay? }', help: 'Send real keystrokes, optionally focusing an element first.' },
  press: { args: '{ key }', help: 'Press a key or chord, e.g. "Enter", "ctrl+a", "Escape".' },
  scroll: { args: '{ dy?, dx? }', help: 'Scroll the page by a pixel delta.' },
  scrollTo: { args: '{ target }', help: 'Scroll an element into view.' },
  highlight: { args: '{ target }', help: 'Flash a magenta box around an element so the human can see what you mean.' },
  evaluate: { args: '{ code }', help: 'Run JavaScript in the page and return the result.' },
  waitFor: { args: '{ selector?, ms?, networkIdle?, timeout? }', help: 'Wait for a selector, a delay, or the network to go quiet.' },
  screenshot: { args: '{ fullPage?, target?, name? }', help: 'Capture a PNG and return its path on disk.' },
  setViewport: { args: '{ width, height }', help: 'Emulate a viewport size, for checking responsive layout.' },
  clearViewport: { args: '{}', help: 'Drop viewport emulation.' },
  console: { args: '{ level?, limit? }', help: 'Buffered console messages from the page.' },
  network: { args: '{ limit? }', help: 'Failed and 4xx/5xx requests seen since the last navigation.' },
  state: { args: '{}', help: 'Current url, title, loading state.' },
  devtools: { args: '{}', help: 'Toggle Chrome DevTools on the preview pane.' },
  preview: { args: '{ open? }', help: 'Show or hide the preview pane for the human. Omit open to toggle. Use it to say "look at this".' },
};

async function runTool(name, a, ctx) {
  const pane = ctx.getPane();
  if (!pane) throw new Error('no preview pane is open');
  switch (name) {
    case 'navigate': return pane.navigate(a.url, a);
    case 'back': return pane.back();
    case 'forward': return pane.forward();
    case 'reload': return pane.reload();
    case 'snapshot': return pane.snapshot({ max: a.max });
    case 'text': return pane.text(a.max);
    case 'html': return pane.html(a.max);
    case 'click': return pane.click(a.target ?? a.ref ?? a.selector, a);
    case 'hover': return pane.hover(a.target ?? a.ref ?? a.selector);
    case 'fill': return pane.fill(a.target ?? a.ref ?? a.selector, a.value ?? a.text ?? '');
    case 'select': return pane.select(a.target ?? a.ref ?? a.selector, a.value);
    case 'type': return pane.type(a.text, a);
    case 'press': return pane.press(a.key, a);
    case 'scroll': return pane.scroll(a.dy, a.dx);
    case 'scrollTo': return pane.scrollTo(a.target ?? a.ref ?? a.selector);
    case 'highlight': return pane.highlight(a.target ?? a.ref ?? a.selector);
    case 'evaluate': return pane.evaluate(a.code ?? a.js ?? a.expression);
    case 'waitFor': return pane.waitFor(a);
    case 'screenshot': return pane.screenshot(a);
    case 'setViewport': return pane.setViewport(a.width, a.height);
    case 'clearViewport': return pane.clearViewport();
    case 'console': return pane.consoleLog(a);
    case 'network': return pane.networkLog(a);
    case 'state': return pane.state();
    case 'devtools': return pane.toggleDevTools();
    case 'preview': {
      if (!ctx.showPreview) throw new Error('no window');
      return ctx.showPreview(a.open);
    }
    default: throw new Error(`unimplemented tool ${name}`);
  }
}

module.exports = { TOOLS, runTool };
