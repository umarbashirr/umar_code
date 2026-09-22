'use strict';
// Turn whatever the human or the agent typed into something loadable.
// Only http(s) and about:blank may leave this boundary.
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

function normalizeUrl(url) {
  const s = String(url).trim();
  let out;
  // Check host-ish shapes before scheme, or "localhost:3000" reads as a scheme.
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) out = 'http://' + s;
  else if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) out = 'http://' + s;
  else if (/^:\d+/.test(s)) out = 'http://localhost' + s;
  else if (/^\d{2,5}$/.test(s)) out = 'http://localhost:' + s;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) out = s;
  else if (/\s/.test(s) || !s.includes('.')) out = 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  else out = 'https://' + s;
  return assertAllowed(out);
}

module.exports = { normalizeUrl, isAllowedUrl, assertAllowed };
