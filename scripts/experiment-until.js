// EXPERIMENT, do not merge: runs the real until() from watch.js, offline.
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'watch.js'), 'utf8');
const piece = (re) => { const m = src.match(re); assert(m, `not found in watch.js: ${re}`); return m[0]; };
const code = [
  piece(/^const sleep = .*$/m),
  piece(/^class CheckError .*$/m),
  piece(/^function fail\(msg\) .*$/m),
  piece(/^async function until\([\s\S]*?^}$/m),
  'return { until, fail, CheckError };',
].join('\n');
const { until, fail, CheckError } = new Function(code)();

(async () => {
  // A CheckError from the polling function ends the wait with its own message.
  let calls = 0;
  const t0 = Date.now();
  const verdict = await until(() => { calls++; fail('game error: boom'); }, 1500, 'never became ready', 50).catch((e) => e);
  assert(verdict instanceof CheckError, 'expected a CheckError');
  assert.strictEqual(verdict.message, 'game error: boom', `until reported "${verdict.message}", not the polling function's verdict`);
  assert.strictEqual(calls, 1, `polled ${calls} times after a verdict`);
  assert(Date.now() - t0 < 1000, 'waited out the budget');

  // Any other error still means "not yet".
  let n = 0;
  const v = await until(() => { if (++n < 3) throw new Error('mid-navigation'); return 'ok'; }, 1500, 'never', 10);
  assert.strictEqual(v, 'ok');
  assert.strictEqual(n, 3);

  // A timeout still fails with msg.
  const late = await until(() => false, 100, 'never became ready', 10).catch((e) => e);
  assert.strictEqual(late.message, 'never became ready');

  console.log('PASS experiment-until: a CheckError ends the wait; other errors are retried; the timeout message holds');
})().catch((e) => { console.error(`FAIL experiment-until: ${e.message}`); process.exit(1); });
