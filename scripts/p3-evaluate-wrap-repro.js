'use strict';
// P3.3: browser evaluate() must return an expression's value and still run a
// statement body, without throwing on valid code that has neither `return`
// nor `=>` nor `;`.
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

async function run(wrapped) {
  // eslint-disable-next-line no-eval
  return eval(wrapped);
}

async function checkCase(name, code, matches, wrapFn) {
  let wrapped;
  try {
    wrapped = wrapFn(code);
  } catch (e) {
    fail(name, `wrap threw: ${e.message}`);
    return;
  }
  try {
    const got = await run(wrapped);
    if (matches(got)) pass(name);
    else fail(name, `code=${JSON.stringify(code)} wrapped=${wrapped} got=${JSON.stringify(got)}`);
  } catch (e) {
    fail(name, `code=${JSON.stringify(code)} wrapped=${wrapped} threw ${e.message}`);
  }
}

const is = (want) => (got) => got === want;

(async () => {
  console.log('=== P3.3 evaluate() must not mangle valid code ===');
  let wrapEvaluate;
  try {
    ({ wrapEvaluate } = require(path.join(ROOT, 'src/main/browser.js')));
  } catch (e) {
    fail('load-browser', e.message);
    console.log(`\n${failures.length} FAIL(s)`);
    process.exit(1);
  }

  if (typeof wrapEvaluate !== 'function') {
    fail('browser-exports-wrapEvaluate', 'src/main/browser.js does not export wrapEvaluate; falling back to its inline evaluate() behavior via oldWrap');
    console.log('\n1 FAIL(s)');
    process.exit(1);
  }

  await checkCase('const-decl-runs-no-throw', 'const x = 1', is(undefined), wrapEvaluate);
  await checkCase('arrow-fn-returns-itself', 'x => x + 1', (got) => typeof got === 'function', wrapEvaluate);
  await checkCase('plain-expression-returns-value', '1 + 1', is(2), wrapEvaluate);
  await checkCase('explicit-return-still-works', 'return 5', is(5), wrapEvaluate);
  await checkCase('statement-with-semicolon-preserved', 'let a = 1; a + 1', is(undefined), wrapEvaluate);

  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
