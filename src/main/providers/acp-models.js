'use strict';

const ACRONYM = new Set(['gpt', 'glm']);
const NUMBER = /^\d+$/;

function modelName(id) {
  const out = [];
  let prev = '';
  for (const part of id.split('-')) {
    if (NUMBER.test(part) && NUMBER.test(prev)) out[out.length - 1] += `.${part}`;
    else if (/^\d/.test(part) && ACRONYM.has(prev)) out[out.length - 1] += `-${part}`;
    else out.push(ACRONYM.has(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1));
    prev = part;
  }
  return out.join(' ');
}

function modelsFrom(res) {
  const rows = res?.models?.availableModels || [];
  return rows
    .filter((m) => m && (m.modelId || m.id || m.value))
    .map((m) => {
      const value = m.modelId || m.id || m.value;
      const said = m.name || m.displayName || '';
      const bare = value.split('[')[0];
      return { value, displayName: !said || said === bare ? modelName(bare) : said };
    });
}

module.exports = { modelsFrom, modelName };
