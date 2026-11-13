#!/usr/bin/env node
// Offline tests of watch.js's command line, browser profiles, alert diff,
// summary table and blank-canvas pixel helpers: no network beyond 127.0.0.1, no browser. The
// registry is served from a local HTTP server, and the runs below must stop
// before a browser would be launched.
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
const zlib = require('zlib');
const { PROFILES, UsageError, selectGames, parseProfiles, summarize, stepSummary, alertText, decodePng, pixelStats } = require(path.join(root, 'watch.js'));

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

// A PNG as Chromium might write it: every row with the given filter, the
// deflated data split over two IDAT chunks. CRCs are left zero (decodePng
// does not read them). ihdr overrides IHDR bytes for the unsupported cases.
function encodePng(width, height, bpp, pixels, filter, ihdr = {}) {
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const px = (yy, xx) => pixels[yy * stride + xx];
      const a = x >= bpp ? px(y, x - bpp) : 0, b = y ? px(y - 1, x) : 0, c = x >= bpp && y ? px(y - 1, x - bpp) : 0;
      let pred = 0;
      if (filter === 1) pred = a; else if (filter === 2) pred = b; else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      raw[y * (stride + 1) + 1 + x] = (px(y, x) - pred) & 255;
    }
  }
  const chunk = (kind, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(kind, 'ascii'), body, Buffer.alloc(4)]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4);
  head[8] = ihdr.depth || 8; head[9] = ihdr.type || (bpp === 4 ? 6 : 2); head[12] = ihdr.interlace || 0;
  const z = zlib.deflateSync(raw), half = Math.floor(z.length / 2);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head),
    chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('IEND', Buffer.alloc(0))]);
}
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what} is ${actual}, expected ${expected}`);

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

  // The alert diff: what is new, what is still failing, what recovered.
  // A check missing from this run (a --only run) is neither still failing nor recovered.
  await test('summarize: new, still failing and recovered checks against the previous state', () => {
    const results = [
      { id: 'a@desktop', ok: false }, { id: 'b@desktop', ok: false }, { id: 'c@desktop', ok: true },
      { id: 'd@desktop', ok: true }, { id: 'e@iphone', ok: false },
    ];
    const prev = { 'b@desktop': { ok: false }, 'c@desktop': { ok: false }, 'd@desktop': { ok: true }, 'e@iphone': { ok: true }, 'z@iphone': { ok: false } };
    const s = summarize(results, prev, {});
    const ids = (list) => list.map((r) => r.id);
    assert.deepStrictEqual(ids(s.failing), ['a@desktop', 'b@desktop', 'e@iphone']);
    assert.deepStrictEqual(ids(s.newly), ['a@desktop', 'e@iphone'], 'newly: no previous result, or previously passing');
    assert.deepStrictEqual(ids(s.still), ['b@desktop']);
    assert.deepStrictEqual(ids(s.recovered), ['c@desktop']);
  });
  await test('summarize: an all-passing run with no failing history alerts on nothing', () => {
    const s = summarize([{ id: 'a@desktop', ok: true }], { 'a@desktop': { ok: true } }, {});
    assert.strictEqual(s.failing.length + s.newly.length + s.still.length + s.recovered.length, 0);
  });
  await test('alertText: a header with the failing count, then new, still failing and recovered lines', () => {
    const lines = alertText({
      failing: [{}, {}],
      newly: [{ title: 'Tidewater', profile: 'iphone', error: 'boom' }],
      still: [{ title: 'Fishe', profile: 'desktop', error: 'stuck' }],
      recovered: [{ title: 'Roam', profile: 'desktop' }],
    }).split('\n');
    assert.ok(lines[0].startsWith('**arcade-watch: 2 check(s) failing**'), lines[0]);
    assert.deepStrictEqual(lines.slice(1), ['- NEW FAIL Tidewater (iphone): boom', '- still failing Fishe (desktop): stuck', '- recovered Roam (desktop)']);
  });
  await test('alertText: recoveries alone say all games are healthy again', () => {
    const lines = alertText({ failing: [], newly: [], still: [], recovered: [{ title: 'Roam', profile: 'iphone' }] }).split('\n');
    assert.ok(lines[0].startsWith('**arcade-watch: all games healthy again**'), lines[0]);
    assert.deepStrictEqual(lines.slice(1), ['- recovered Roam (iphone)']);
  });

  // The job summary table (summary.md and the Actions step summary).
  const row = (slug, profile, extra) => ({ id: `${slug}@${profile}`, slug, title: slug[0].toUpperCase() + slug.slice(1), type: 'emscripten', url: `https://x/${slug}`, profile, ok: true, ...extra });
  const meta = { ms: 12345, when: '2026-11-12T04:00:00.000Z' };
  await test('stepSummary: a healthy run says so, counts the checks and ends with the screenshots line', () => {
    const results = [row('tidewater', 'desktop'), row('tidewater', 'iphone')];
    const md = stepSummary(results, summarize(results, {}, meta), meta);
    const lines = md.split('\n');
    assert.strictEqual(lines[0], '## arcade-watch: all games healthy');
    assert.strictEqual(lines[2], '2 checks in 12s, 2026-11-12T04:00:00.000Z.');
    assert.deepStrictEqual(lines.slice(4, 7), ['| Game | Type | Desktop | iPhone 13 |', '|---|---|---|---|', '| [Tidewater](https://x/tidewater) | emscripten | PASS | PASS |']);
    assert.ok(md.endsWith('\n\nScreenshots: the `screenshots` artifact of this run.\n'), JSON.stringify(md.slice(-80)));
    assert.doesNotMatch(md, /Recovered|Not in games\.json|<details>/);
  });
  await test('stepSummary: one row per game with retry, FAIL (pipes escaped) and missing-profile cells', () => {
    const results = [
      row('tidewater', 'desktop', { retried: true }), row('tidewater', 'iphone', { ok: false, error: 'a | b' }),
      row('fishe', 'iphone'),
    ];
    const lines = stepSummary(results, summarize(results, {}, meta), meta).split('\n');
    assert.strictEqual(lines[0], '## arcade-watch: 1 failing');
    assert.deepStrictEqual(lines.slice(6, 8), [
      '| [Tidewater](https://x/tidewater) | emscripten | PASS (retry) | **FAIL**: a \\| b |',
      '| [Fishe](https://x/fishe) | emscripten | - | PASS |',
    ]);
  });
  await test('stepSummary: http and portal checks fill the Desktop column only', () => {
    const results = [
      { id: 'api-healthz', slug: 'api-healthz', title: 'api.play healthz', type: 'http', url: 'https://api/healthz', profile: 'http', ok: false, error: 'HTTP 502' },
      { ...row('portal', 'desktop'), type: 'portal', title: 'Portal' },
    ];
    const lines = stepSummary(results, summarize(results, {}, meta), meta).split('\n');
    assert.deepStrictEqual(lines.slice(6, 8), [
      '| [api.play healthz](https://api/healthz) | http | **FAIL**: HTTP 502 | |',
      '| [Portal](https://x/portal) | portal | PASS | |',
    ]);
  });
  await test('stepSummary: recoveries, unconfigured games once each, and console errors on passing checks only', () => {
    const results = [
      row('tidewater', 'desktop', { errors: [{ text: 'use `x`' }, { text: 'y'.repeat(200) }] }),
      row('tidewater', 'iphone', { ok: false, error: 'boom', errors: [{ text: 'hidden' }] }),
      row('roam', 'desktop', { unconfigured: true }), row('roam', 'iphone', { unconfigured: true, errors: [] }),
    ];
    const s = summarize(results, { 'roam@desktop': { ok: false } }, meta);
    const md = stepSummary(results, s, meta);
    assert.match(md, /\n\nRecovered: roam@desktop\n/);
    assert.match(md, /\n\nNot in games\.json \(only a page-load check ran; add them\): roam\n/);
    assert.ok(md.includes(`\n\n<details><summary>Console errors on passing checks (not fatal)</summary>\n\n- tidewater@desktop: \`use 'x'\`, \`${'y'.repeat(120)}\`\n\n</details>\n`), md);
    assert.doesNotMatch(md, /hidden/, 'a failing check\'s console errors are not listed');
  });

  // The strata blank-canvas verdict decodes Chromium's PNG capture itself.
  const w = 5, h = 4;
  const rgb = Buffer.from(Array.from({ length: w * h * 3 }, (_, i) => (i * 37 + (i >> 2) * 11 + (i % 7 === 0 ? 200 : 0)) & 255));
  for (const filter of [0, 1, 2, 3, 4]) {
    await test(`decodePng: RGB rows with filter ${filter} decode to the original pixels`, () => {
      const img = decodePng(encodePng(w, h, 3, rgb, filter));
      assert.deepStrictEqual([img.width, img.height, img.bpp], [w, h, 3]);
      assert.ok(img.data.equals(rgb), `pixels differ: ${img.data.toString('hex')}`);
    });
  }
  await test('decodePng: RGBA (Paeth rows) decodes with 4 bytes per pixel', () => {
    const rgba = Buffer.from(Array.from({ length: w * h * 4 }, (_, i) => (i * 53 + 7) & 255));
    const img = decodePng(encodePng(w, h, 4, rgba, 4));
    assert.strictEqual(img.bpp, 4);
    assert.ok(img.data.equals(rgba), `pixels differ: ${img.data.toString('hex')}`);
  });
  for (const [what, ihdr] of [['16-bit depth', { depth: 16 }], ['a palette', { type: 3 }], ['interlacing', { interlace: 1 }]]) {
    await test(`decodePng: ${what} is rejected as unsupported`, () => {
      assert.throws(() => decodePng(encodePng(2, 2, 3, Buffer.alloc(12), 0, ihdr)), /unsupported PNG/);
    });
  }
  const pic = (bpp, ...px) => ({ width: px.length / bpp, height: 1, bpp, data: Buffer.from(px) });
  await test('pixelStats: one flat colour has no spread and one colour', () => {
    const s = pixelStats(pic(3, 40, 90, 160, 40, 90, 160, 40, 90, 160));
    near(s.stddev, 0, 'stddev');
    assert.strictEqual(s.colours, 1);
  });
  await test('pixelStats: half black, half white has a luma stddev of 127.5 and two colours', () => {
    const s = pixelStats(pic(3, 0, 0, 0, 255, 255, 255));
    near(s.stddev, 127.5, 'stddev');
    assert.strictEqual(s.colours, 2);
  });
  await test('pixelStats: luma weighs green over red (Rec. 709), and ignores alpha', () => {
    near(pixelStats(pic(3, 0, 0, 0, 0, 255, 0)).stddev, 0.7152 * 255 / 2, 'green stddev');
    near(pixelStats(pic(4, 0, 0, 0, 0, 255, 0, 0, 255)).stddev, 0.2126 * 255 / 2, 'red stddev (RGBA)');
  });
  await test('pixelStats: colours within the same 8-level step count as one', () => {
    assert.strictEqual(pixelStats(pic(3, 0, 0, 0, 7, 7, 7)).colours, 1);
    assert.strictEqual(pixelStats(pic(3, 0, 0, 0, 8, 0, 0)).colours, 2);
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
