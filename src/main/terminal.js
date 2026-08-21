'use strict';
const pty = require('node-pty');
const os = require('os');
const { EventEmitter } = require('events');

const { ANSI, localUrls } = require('./sniff');

// Only there to stop the same dev-server banner toasting twice. A shell left
// open for a week restarting servers should not accumulate every URL it ever
// printed, so forget the oldest once it grows past anything plausible.
const MAX_SEEN_URLS = 200;

class Terminal extends EventEmitter {
  constructor({ id, cwd, env, cols = 120, rows = 30, shell }) {
    super();
    this.id = id;
    this.tail = '';
    this.shell = shell || defaultShell();
    this.seenUrls = new Set();
    this.proc = pty.spawn(this.shell, shellArgs(this.shell), {
      name: 'xterm-256color',
      cwd: cwd || os.homedir(),
      cols, rows,
      env: { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    this.proc.onData((d) => { this.emit('data', d); this.sniff(d); });
    this.proc.onExit(({ exitCode }) => this.emit('exit', exitCode));
  }

  sniff(chunk) {
    this.tail = (this.tail + chunk.replace(ANSI, '')).slice(-4000);
    const lines = this.tail.split('\n');
    this.tail = lines.pop() || '';
    for (const url of localUrls(lines.join('\n'))) {
      if (this.seenUrls.has(url)) continue;
      if (this.seenUrls.size >= MAX_SEEN_URLS) this.seenUrls.delete(this.seenUrls.values().next().value);
      this.seenUrls.add(url);
      this.emit('url', url);
    }
  }

  write(data) { this.proc.write(data); }
  resize(cols, rows) { try { this.proc.resize(Math.max(2, cols), Math.max(2, rows)); } catch {} }
  kill() { try { this.proc.kill(); } catch {} }
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}
function shellArgs(shell) {
  const s = shell || defaultShell();
  if (process.platform === 'win32') return [];
  return /(^|\/)(bash|zsh)$/.test(s) ? ['-l'] : [];
}

module.exports = { Terminal };
