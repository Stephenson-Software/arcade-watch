#!/usr/bin/env node
// Offline tests of watch.js's command line and browser profiles: no network
// beyond 127.0.0.1, no browser. The registry is served from a local HTTP
// server, and the runs below must stop before a browser would be launched.
// Usage: node scripts/test-cli.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { devices } = require('playwright');

const root = path.join(__dirname, '..');
const { PROFILES, UsageError, selectGames, parseProfiles } = require(path.join(root, 'watch.js'));

const failures = [];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}

const games = [{ slug: 'tidewater' }, { slug: 'fishe' }];
const throwsUsage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && re.test(e.message));

// A local registry and a games.json that points at it.
const registry = { games: [{ slug: 'tidewater', title: 'Tidewater', url: 'http://127.0.0.1:9/' }] };
const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(registry)); });

function runWatch(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'watch.js'), ...args], { env, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

(async () => {
  await test('selectGames: no --only selects every game', () => assert.strictEqual(selectGames(games, null).length, 2));
  await test('selectGames: known slugs select those games', () => assert.deepStrictEqual(selectGames(games, ['fishe']).map((g) => g.slug), ['fishe']));
  await test('selectGames: an unknown slug is rejected and named', () => throwsUsage(() => selectGames(games, ['tidewatr']), /"tidewatr"/));
  await test('selectGames: a partly matching list is rejected', () => throwsUsage(() => selectGames(games, ['tidewater', 'tidewatr']), /no game with slug "tidewatr"/));
  await test('selectGames: an empty list is rejected', () => throwsUsage(() => selectGames(games, []), /no slugs/));
  await test('parseProfiles: default is desktop and iphone', () => assert.deepStrictEqual(parseProfiles(undefined), ['desktop', 'iphone']));
  await test('parseProfiles: an unknown profile is rejected', () => throwsUsage(() => parseProfiles('desktop,ipone'), /"ipone"/));

  // Play-count hygiene: every context's UA is the device's own, unchanged,
  // with the arcade-watch token appended (the arcade does not count it).
  const device = { desktop: 'Desktop Chrome', iphone: 'iPhone 13' };
  for (const [name, profile] of Object.entries(PROFILES)) {
    await test(`profile ${name}: UA is the device UA plus the arcade-watch token`, () => {
      const base = devices[device[name]].userAgent;
      assert.ok(profile.userAgent.startsWith(base + ' '), `UA does not start with the ${device[name]} UA: ${profile.userAgent}`);
      assert.ok(profile.userAgent.slice(base.length).includes('arcade-watch'), `no arcade-watch token: ${profile.userAgent}`);
    });
  }
  await test('profile iphone: Mobile Safari tokens intact', () => {
    assert.match(PROFILES.iphone.userAgent, /iPhone; CPU iPhone OS [\d_]+ like Mac OS X\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Version\/[\d.]+ Mobile\/\w+ Safari\/[\d.]+ /);
    assert.doesNotMatch(PROFILES.iphone.userAgent, /chrome|android/i, 'Safari sniffers rule out chrome/android');
  });

  // End to end: the real CLI exits non-zero, names the slug, posts nothing.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-watch-test-'));
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'games.json'), 'utf8'));
  conf.registry = `http://127.0.0.1:${server.address().port}/api/games`;
  fs.writeFileSync(path.join(tmp, 'games.json'), JSON.stringify(conf));
  const env = { ...process.env, GAMES_FILE: path.join(tmp, 'games.json'), OUT_DIR: path.join(tmp, 'out'), DISCORD_WEBHOOK_URL: '' };
  for (const [args, re] of [
    [['--only', 'tidewatr'], /no game with slug "tidewatr"/],
    [['--only', 'tidewater,tidewatr'], /no game with slug "tidewatr"/],
    [['--only'], /--only needs/],
    [['--only', 'tidewater', '--profiles', 'ipone'], /unknown profile "ipone"/],
  ]) {
    await test(`watch.js ${args.join(' ')} exits 2 with a clear message`, async () => {
      const r = await runWatch(args, env);
      assert.strictEqual(r.code, 2, `exit ${r.code}; stdout: ${r.stdout.slice(0, 200)} stderr: ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stdout + r.stderr, /checks passed|not posting/);
    });
  }
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`cli tests: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
