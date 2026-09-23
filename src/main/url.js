'use strict';
// Turn whatever the human or the agent typed into something loadable.
const ALLOWED = new Set(['http:', 'https:']);

function schemeOf(url) {
  try {
    return new URL(url).protocol.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (s === 'about:blank' || s.startsWith('about:blank?')) return true;
  const scheme = schemeOf(s);
  return !!scheme && ALLOWED.has(scheme);
}

function assertAllowed(url) {
  if (isAllowedUrl(url)) return url;
  const scheme = schemeOf(url) || 'unknown';
  const err = new Error(`blocked URL scheme: ${scheme}`);
  err.code = 'BLOCKED_SCHEME';
  throw err;
}

// A dotless single label followed by a port or a path reads as an internal
// host ("devbox:8080", "myinternalhost/admin"), not a search term, so it must
// not fall into the DuckDuckGo branch below. A bare label with neither
// ("myinternalhost") stays ambiguous and is still treated as a search, same
// as before this fix. The regex only anchors the start, so on its own it also
// matches the first slash of a search phrase like "c/c++ tutorial"; the
// no-whitespace guard below is what keeps that a search.
const HOST_WITH_PORT_OR_PATH = /^[a-z][a-z0-9-]*(:\d+)?\/|^[a-z][a-z0-9-]*:\d+$/i;

function normalizeUrl(url) {
  const s = String(url).trim();
  let out;
  // Check host-ish shapes before scheme, or "localhost:3000" reads as a scheme.
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) out = 'http://' + s;
  else if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) out = 'http://' + s;
  else if (!/\s/.test(s) && HOST_WITH_PORT_OR_PATH.test(s)) out = 'http://' + s;
  else if (/^:\d+/.test(s)) out = 'http://localhost' + s;
  else if (/^\d{2,5}$/.test(s)) out = 'http://localhost:' + s;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) out = s;
  else if (/\s/.test(s) || !s.includes('.')) out = 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  else out = 'https://' + s;
  return assertAllowed(out);
}

module.exports = { normalizeUrl, isAllowedUrl, assertAllowed };
