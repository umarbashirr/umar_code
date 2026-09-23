'use strict';
// What every chat has spent, kept across restarts for the Usage page. Each chat
// is one entry replaced whole with the totals its meter shows, so recording the
// same numbers twice changes nothing and two windows never write the same key.
// Totals across chats are summed when read, not kept.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'];

function createUsageLedger(dir) {
  const file = path.join(dir, 'usage.json');
  let chats = {};
  try { chats = JSON.parse(fs.readFileSync(file, 'utf8')).chats || {}; } catch {}

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ chats }));
        fs.renameSync(`${file}.tmp`, file);
      } catch {}
    }, 500);
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

  // provider -> model -> summed counts, plus how many chats fed each model.
  function summary() {
    const providers = {};
    let since = 0;
    for (const e of Object.values(chats)) {
      since = since ? Math.min(since, e.at) : e.at;
      const byModel = (providers[e.provider] ||= {});
      for (const [model, m] of Object.entries(e.models)) {
        const into = (byModel[model] ||= { ...Object.fromEntries(COUNTS.map((k) => [k, 0])), chats: 0 });
        for (const k of COUNTS) into[k] += m[k] || 0;
        into.chats += 1;
      }
    }
    return { providers, since, chats: Object.keys(chats).length };
  }

  return { record, summary };
}

module.exports = { createUsageLedger };
