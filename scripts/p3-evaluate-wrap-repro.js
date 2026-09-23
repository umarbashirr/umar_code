'use strict';
// P3.3: browser evaluate() must return an expression's value and still run a
// statement body, without throwing on valid code that has neither `return`
// nor `=>` nor `;`.
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

// browser.js's evaluate() before this fix, kept here verbatim so this script
// can prove the defect even on a checkout that doesn't export wrapEvaluate.
function mainWrap(code) {
  return `(async () => { ${/return|=>|;/.test(code) ? code : `return (${code})`} })()`;
}

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
  }
  const wrapFn = typeof wrapEvaluate === 'function' ? wrapEvaluate : mainWrap;
  console.log(wrapFn === mainWrap
    ? 'src/main/browser.js does not export wrapEvaluate; using the pre-fix wrap verbatim'
    : 'using src/main/browser.js\'s own wrapEvaluate');

  await checkCase('const-decl-runs-no-throw', 'const x = 1', is(undefined), wrapFn);
  await checkCase('arrow-fn-returns-itself', 'x => x + 1', (got) => typeof got === 'function', wrapFn);
  await checkCase('plain-expression-returns-value', '1 + 1', is(2), wrapFn);
  await checkCase('explicit-return-still-works', 'return 5', is(5), wrapFn);
  await checkCase('statement-with-semicolon-preserved', 'let a = 1; a + 1', is(undefined), wrapFn);

  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
