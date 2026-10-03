// Tiny zero-dependency test harness + entry point: `node src/ai-engine/test/run.js`.
// engine.test.js registers assertions against this harness and calls finish().

'use strict';

const results = { passed: 0, failed: 0, failures: [] };
let current = '';

function group(name) {
  current = name;
}

function ok(cond, label) {
  if (cond) {
    results.passed++;
  } else {
    results.failed++;
    results.failures.push(current + ' › ' + label);
  }
}

function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    results.passed++;
  } else {
    results.failed++;
    results.failures.push(
      current + ' › ' + label + '\n      expected: ' + JSON.stringify(expected) +
      '\n      actual:   ' + JSON.stringify(actual)
    );
  }
}

function throws(fn, label) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(threw, label);
}

/** Print the summary and set the process exit code. Idempotent. */
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const passed = summary();
  process.exitCode = passed ? 0 : 1;
}

function summary() {
  const lines = [];
  lines.push('');
  if (results.failures.length) {
    lines.push('FAILURES:');
    for (const f of results.failures) lines.push('  ✗ ' + f);
    lines.push('');
  }
  lines.push(
    results.failed
      ? `${results.failed} failed, ${results.passed} passed`
      : `All ${results.passed} assertions passed.`
  );
  process.stdout.write(lines.join('\n') + '\n');
  return results.failed === 0;
}

module.exports = { group, ok, eq, throws, summary, finish, results };

// The suite is required last: it registers and runs every assertion, then calls finish().
require('./engine.test.js');