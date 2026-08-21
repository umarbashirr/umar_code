'use strict';
// Turn whatever the human or the agent typed into something loadable.
function normalizeUrl(url) {
  const s = String(url).trim();
  // Check host-ish shapes before scheme, or "localhost:3000" reads as a scheme.
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (/^:\d+/.test(s)) return 'http://localhost' + s;
  if (/^\d{2,5}$/.test(s)) return 'http://localhost:' + s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/\s/.test(s) || !s.includes('.')) return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  return 'https://' + s;
}


module.exports = { normalizeUrl };
