'use strict';
// Everything the settings page changes, in one JSON file next to the recent
// projects list. Main owns it because the terminal font, the startup folder and
// which claude binary to run are all decided before the renderer exists.
//
// Reads never throw and never block on a missing file: a corrupt settings.json
// falls back to the defaults rather than taking the window down with it.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { DIR } = require('./projects');

const FILE = path.join(DIR, 'settings.json');

const DEFAULTS = {
  appearance: {
    theme: 'system',        // system | light | dark
    zoom: 1,
  },
  terminal: {
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", monospace',
  },
  agent: {
    model: '',              // empty means whatever the CLI picks
    mode: 'ask',
  },
  startup: {
    reopenProject: true,
    checkUpdates: true,
  },
  claude: {
    // Which claude the agent runs: the one bundled in the app, or a newer one
    // found on PATH. See driver.js.
    binary: 'bundled',      // bundled | path
  },
  // The last version each toast named. A person who ignored the news about
  // 0.6.0 should not be told about 0.6.0 again every time they open a window;
  // 0.6.1 is news again. Kept here rather than in localStorage so it survives a
  // cleared cache and can be read back from the file.
  notices: {
    app: '',
    claude: '',
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

// One level deep is all this file is. A section in the file that is no longer a
// section here is dropped, and a key the defaults do not have is ignored, so an
// old file cannot smuggle junk into a new build.
function normalize(raw) {
  const out = clone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    const given = raw[section];
    if (!given || typeof given !== 'object') continue;
    for (const key of Object.keys(defaults)) {
      if (given[key] !== undefined && typeof given[key] === typeof defaults[key]) {
        out[section][key] = given[key];
      }
    }
  }
  return out;
}

class Settings extends EventEmitter {
  constructor(file = FILE) {
    super();
    this.file = file;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.data = normalize(raw);
  }

  all() { return clone(this.data); }

  get(section) { return clone(this.data[section] || {}); }

  // Takes a partial tree ({ appearance: { theme: 'dark' } }) and returns the
  // whole thing back, which is what every IPC handler here answers with: the
  // panel never has to guess what the file ended up holding.
  patch(partial) {
    this.data = normalize({ ...this.data, ...merge(this.data, partial) });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {}
    this.emit('changed', this.all(), partial);
    return this.all();
  }

  reset() {
    this.data = clone(DEFAULTS);
    try { fs.unlinkSync(this.file); } catch {}
    this.emit('changed', this.all(), null);
    return this.all();
  }
}

function merge(base, partial) {
  const out = {};
  for (const [section, values] of Object.entries(partial || {})) {
    if (!values || typeof values !== 'object') continue;
    out[section] = { ...(base[section] || {}), ...values };
  }
  return out;
}

module.exports = { Settings, DEFAULTS, FILE };
