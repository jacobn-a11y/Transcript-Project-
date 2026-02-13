/**
 * Lightweight test runner — no external dependencies.
 * Run: node tests/run.js
 */
const path = require('path');

let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;
const suiteResults = [];

function describe(name, fn) {
  const suite = { name, tests: [], pass: 0, fail: 0 };
  const it = (desc, testFn) => suite.tests.push({ desc, fn: testFn });
  const skip = (desc) => { suite.tests.push({ desc, fn: null, skipped: true }); };
  it.skip = skip;
  fn(it);
  suiteResults.push(suite);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
assert.equal = (a, b, msg) => assert(a === b, msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
assert.deepEqual = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), msg || `Deep equal failed`);
assert.throws = (fn, msg) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg || 'Expected function to throw');
};
assert.rejects = async (fn, msg) => {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert(threw, msg || 'Expected async function to reject');
};
assert.ok = (val, msg) => assert(!!val, msg || `Expected truthy, got ${val}`);
assert.includes = (str, sub, msg) => assert(String(str).includes(sub), msg || `Expected "${str}" to include "${sub}"`);
assert.gt = (a, b, msg) => assert(a > b, msg || `Expected ${a} > ${b}`);
assert.lt = (a, b, msg) => assert(a < b, msg || `Expected ${a} < ${b}`);

async function runAll() {
  for (const suite of suiteResults) {
    console.log(`\n  ${suite.name}`);
    for (const test of suite.tests) {
      if (test.skipped) {
        console.log(`    - ${test.desc} (skipped)`);
        totalSkip++;
        continue;
      }
      try {
        await test.fn();
        console.log(`    \x1b[32m✓\x1b[0m ${test.desc}`);
        suite.pass++;
        totalPass++;
      } catch (e) {
        console.log(`    \x1b[31m✗\x1b[0m ${test.desc}`);
        console.log(`      ${e.message}`);
        suite.fail++;
        totalFail++;
      }
    }
  }

  console.log(`\n  \x1b[32m${totalPass} passing\x1b[0m`);
  if (totalFail > 0) console.log(`  \x1b[31m${totalFail} failing\x1b[0m`);
  if (totalSkip > 0) console.log(`  \x1b[33m${totalSkip} skipped\x1b[0m`);
  process.exit(totalFail > 0 ? 1 : 0);
}

// ─── Load test files ───
require('./session.test')(describe, assert);
require('./merger.test')(describe, assert);
require('./rate-limiter.test')(describe, assert);
require('./custom-provider.test')(describe, assert);
require('./gong-provider.test')(describe, assert);
require('./server.test')(describe, assert);

runAll();
