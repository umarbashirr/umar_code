'use strict';
// What every chat has spent, kept across restarts for the Usage page. Each chat
// is one entry replaced whole with the totals its meter shows, so recording the
// same numbers twice changes nothing and two windows never write the same key.
// Totals across chats are summed when read, not kept.
const fs = require('fs');
const path = require('path');
const { dayOf } = require('./usage-history');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'];

function createUsageLedger(dir) {
  const file = path.join(dir, 'usage.json');
  let chats = {};
  try { chats = JSON.parse(fs.readFileSync(file, 'utf8')).chats || {}; } catch {}

  let timer = null;
  function flush() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ chats }));
      fs.renameSync(`${file}.tmp`, file);
    } catch {}
  }
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };

  function record(chat, provider, models) {
    if (!chat || !models || typeof models !== 'object') return;
    const clean = {};
    for (const [model, m] of Object.entries(models)) {
      clean[model] = Object.fromEntries(COUNTS.map((k) => [k, Number(m?.[k]) || 0]));
    }
    chats[chat] = { provider: provider || 'claude', at: Date.now(), models: clean };
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, e] of Object.entries(chats)) if (e.at < cutoff) delete chats[k];
    save();
  }

  // provider -> { byDay: {day: {model: counts}} }, the shape the transcripts
  // give the Usage page, so a CLI with no transcripts of its own draws the same.
  // A chat is filed under the day it last spent anything.
  function summary() {
    const providers = {};
    for (const e of Object.values(chats)) {
      const day = (providers[e.provider] ||= { byDay: {}, byProject: {} }).byDay[dayOf(e.at)] ||= {};
      for (const [model, m] of Object.entries(e.models)) {
        const into = (day[model] ||= Object.fromEntries(COUNTS.map((k) => [k, 0])));
        for (const k of COUNTS) into[k] += m[k] || 0;
      }
    }
    return providers;
  }

  return { record, summary, flush };
}

module.exports = { createUsageLedger };
