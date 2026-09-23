'use strict';
// P3.4: a dotless internal host with a port or a path must not leak to
// DuckDuckGo. A bare dotless word with neither stays ambiguous and is still
// treated as a search, unchanged from before.
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const { normalizeUrl } = require(path.join(ROOT, 'src/main/url.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function check(name, input, want) {
  let got;
  try {
    got = normalizeUrl(input);
  } catch (e) {
    got = `ERROR:${e.message}`;
  }
  if (got === want) pass(name);
  else fail(name, `normalizeUrl(${JSON.stringify(input)}) => ${got}, want ${want}`);
}

console.log('=== P3.4 host-looking dotless input must not go to a search engine ===');
check('host-with-path-not-searched', 'myinternalhost/admin', 'http://myinternalhost/admin');
check('host-with-port-not-searched', 'myinternalhost:8080', 'http://myinternalhost:8080');
check('host-with-port-and-path-not-searched', 'myinternalhost:8080/admin', 'http://myinternalhost:8080/admin');

// Current behavior, unchanged by this fix.
check('localhost-with-port-still-works', 'localhost:3000', 'http://localhost:3000');
check('ip-with-port-still-works', '192.168.1.5:8080', 'http://192.168.1.5:8080');
check('bare-port-still-works', '3000', 'http://localhost:3000');
check('dotted-host-still-works', 'example.com', 'https://example.com');
check('bare-dotless-word-still-ambiguous', 'myinternalhost', 'https://duckduckgo.com/?q=myinternalhost');
check('words-with-spaces-still-searched', 'how to boil an egg', 'https://duckduckgo.com/?q=how%20to%20boil%20an%20egg');

console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
