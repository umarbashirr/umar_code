'use strict';

function createChatPrefs() {
  const byChat = new Map();

  function entry(chat) {
    let e = byChat.get(chat);
    if (!e) {
      e = {};
      byChat.set(chat, e);
    }
    return e;
  }

  function modeOf(chat, fallback) {
    return byChat.get(chat)?.mode ?? fallback;
  }

  function modelOf(chat, fallback) {
    return byChat.get(chat)?.model ?? fallback;
  }

  // Empty string is a real choice (CLI default), so unset and '' must differ.
  function effortOf(chat, fallback) {
    const e = byChat.get(chat);
    return e && 'effort' in e ? e.effort : fallback;
  }

  function setMode(chat, mode) {
    entry(chat).mode = mode;
    return mode;
  }

  function setModel(chat, model) {
    entry(chat).model = model;
    return model;
  }

  function setEffort(chat, effort) {
    entry(chat).effort = effort;
    return effort;
  }

  function resolve(chat, defaults = {}) {
    return {
      mode: modeOf(chat, defaults.mode),
      model: modelOf(chat, defaults.model),
      effort: effortOf(chat, defaults.effort),
    };
  }

  function forget(chat) {
    byChat.delete(chat);
  }

  function clear() {
    byChat.clear();
  }

  return {
    modeOf, modelOf, effortOf, setMode, setModel, setEffort, resolve, forget, clear,
  };
}

module.exports = { createChatPrefs };
