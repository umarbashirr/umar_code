'use strict';
// Strip OSC sequences, CSI sequences, then the short two-byte escapes.
const ANSI = new RegExp('\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)|\\u001B\\[[0-9;?]*[ -\\/]*[@-~]|\\u001B[@-Z\\\\-_]', 'g');
const URL_RE = /https?:\/\/(?:localhost(?![.a-z0-9-])|127\.0\.0\.1(?![.\d])|0\.0\.0\.0(?![.\d])|\[::1\]|[a-z0-9.-]+\.[a-z]{2,})(?::\d{2,5})?(?:\/[^\s"'`<>]*)?/gi;

function localUrls(text) {
  const found = [];
  for (const m of text.replace(ANSI, '').matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:)\]]+$/, '');
    url = url.replace('0.0.0.0', 'localhost').replace('[::1]', 'localhost');
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) found.push(url);
  }
  return found;
}

module.exports = { ANSI, URL_RE, localUrls };
