#!/usr/bin/env node
// arcade-watch: load every game on danielstephenson.dev/play in a real browser,
// on desktop and on the iPhone 13 profile, and check that it starts and responds.
//
// Usage: node watch.js [--only slug,slug] [--profiles desktop,iphone]
// Env:   DISCORD_WEBHOOK_URL  post failures/recoveries here (optional)
//        PREV_STATE           path to the previous run's state.json (optional)
//        OUT_DIR              where results, state and screenshots go (default ./out)
//        CONCURRENCY          parallel checks (default 4)
//        RUN_URL              link to this run, used in alerts
//        GAMES_FILE           alternative to games.json (optional)
//        GITHUB_STEP_SUMMARY  set by Actions; the results table is appended here
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, devices } = require('playwright');

const CONFIG = JSON.parse(fs.readFileSync(process.env.GAMES_FILE || path.join(__dirname, 'games.json'), 'utf8'));
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'out');
const SHOTS = path.join(OUT_DIR, 'screenshots');
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const RUN_URL = process.env.RUN_URL || '';

// The UA keeps the device's real one (games sniff it) and appends a token the
// arcade's play counter treats as "not a person" (it matches /monitor/), so
// these daily loads do not inflate the play counts shown on the portal.
const UA_SUFFIX = ' arcade-watch-monitor (+https://github.com/Stephenson-Software/arcade-watch)';
function strip(dev) {
  const { defaultBrowserType, ...rest } = dev; // eslint-disable-line no-unused-vars
  return { ...rest, userAgent: rest.userAgent + UA_SUFFIX };
}
const PROFILES = {
  desktop: strip(devices['Desktop Chrome']),
  // Sets a Mobile Safari UA, touch and a phone viewport: games that sniff the
  // UA (Pyodide does) take their iOS path here.
  iphone: strip(devices['iPhone 13']),
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class CheckError extends Error {}
function fail(msg) { throw new CheckError(msg); }

// ---------------------------------------------------------------- helpers

async function tap(ctx, locator) {
  if (ctx.touch) await locator.tap();
  else await locator.click();
}

// Waits until fn() returns truthy, polling; fails with msg on timeout.
async function until(fn, ms, msg, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = undefined; }
    if (v) return v;
    if (Date.now() > end) fail(msg);
    await sleep(every);
  }
}

// Hashes of an element (or the viewport) over time until two differ.
// shotMs: a screenshot waits for the page's next frame, and a game drawn with
// software WebGL (CI has no GPU) can take seconds per frame (microbiome, 2026-10-23).
async function waitForChange(page, target, { tries = 6, gapMs = 2000, between, shotMs = 15000 } = {}) {
  const shot = async () => hash(target ? await target.screenshot({ timeout: shotMs }) : await page.screenshot());
  const first = await shot();
  for (let i = 0; i < tries; i++) {
    if (between) await between(i);
    await sleep(gapMs);
    if ((await shot()) !== first) return true;
  }
  return false;
}

async function goto(page, url) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!res) fail(`no response from ${url}`);
  if (res.status() >= 400) fail(`HTTP ${res.status()} from ${url}`);
  return res;
}

// ---------------------------------------------------------------- strata helpers

// Runs in the page before any of its scripts (strata check only): counts wasm
// instantiations, WebGL 2 contexts, animation frames and WebGL 2 draw calls.
function strataProbe() {
  const st = window.__arcadeWatchStrata = { wasm: 0, webgl2: 0, webgl2Failed: 0, raf: 0, draws: 0 };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    const c = getContext.call(this, type, opts);
    if (type === 'webgl2') { if (c) st.webgl2++; else st.webgl2Failed++; }
    return c;
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { st.raf++; return cb(t); });
  const gl = window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype;
  for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
    const f = gl && gl[m];
    if (f) gl[m] = function () { st.draws++; return f.apply(this, arguments); };
  }
  for (const m of ['instantiate', 'instantiateStreaming']) {
    const f = WebAssembly[m];
    if (f) WebAssembly[m] = function () { const p = f.apply(this, arguments); p.then(() => { st.wasm++; }, () => {}); return p; };
  }
}

// A screenshot straight from CDP: unlike page.screenshot it does not wait for
// a "stable" frame, which a SwiftShader-drawn page can take seconds to give.
async function cdpShot(page, clip) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    return Buffer.from(data, 'base64');
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// A game's test hook: a JS expression that returns an object or a JSON string.
async function readHook(page, game) {
  let v;
  try { v = await page.evaluate(game.hook); } catch (e) { fail(`hook ${game.hook} threw: ${String(e.message || e).split('\n')[0]}`); }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { fail(`hook ${game.hook} returned a string that is not JSON`); } }
  if (!v || typeof v !== 'object') fail(`hook ${game.hook} returned ${JSON.stringify(v)}`);
  return v;
}

// Minimal PNG decoder for Chromium's captures (8-bit RGB/RGBA, not interlaced).
function decodePng(buf) {
  const zlib = require('zlib');
  let pos = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || (type !== 2 && type !== 6) || body[12] !== 0) throw new Error(`unsupported PNG (depth ${body[8]}, type ${type}, interlace ${body[12]})`);
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[row - stride + x] : 0, c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[row + x] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

// Luma standard deviation and a count of distinct (coarsened) colours.
function pixelStats({ width, height, bpp, data }) {
  let sum = 0, sq = 0;
  const colours = new Set();
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const r = data[i * bpp], g = data[i * bpp + 1], b = data[i * bpp + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y; sq += y * y;
    if (colours.size < 4096) colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }
  const mean = sum / n;
  return { stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)), colours: colours.size };
}

// ---------------------------------------------------------------- checks
// Each check gets (page, game, ctx) and throws CheckError (or anything) on failure.

const CHECKS = {
  // tak choice games: buttons in #app; tap the first enabled one three times
  // and see the screen change each time.
  async tak(page, game, ctx) {
    await goto(page, game.url);
    await page.waitForSelector('#app button', { timeout: game.timeoutMs - 5000 }).catch(() => fail('no #app button appeared (game never started)'));
    for (let i = 1; i <= 3; i++) {
      const btn = page.locator('#app button:enabled').first();
      await btn.waitFor({ timeout: 20000 }).catch(() => fail(`tap ${i}: no enabled button in #app`));
      const label = (await btn.innerText()).trim();
      const before = await page.$eval('#app', (e) => e.innerText);
      await tap(ctx, btn);
      await until(async () => (await page.$eval('#app', (e) => e.innerText)) !== before, 20000,
        `tap ${i} ("${label}") did not change the screen`);
      ctx.note(`tap ${i}: ${label}`);
      ctx.assertNoFatal();
    }
  },

  // tak console games: one line into .tak-console-input, then new output.
  async 'tak-console'(page, game, ctx) {
    await goto(page, game.url);
    const input = page.locator('.tak-console-input:enabled');
    await input.waitFor({ timeout: game.timeoutMs - 5000 }).catch(() => fail('console input never became enabled'));
    const screen = page.locator('.tak-console-screen');
    const before = await screen.innerText();
    await input.fill(game.line);
    await input.press('Enter');
    await until(async () => {
      const now = await screen.innerText();
      const added = now.startsWith(before) ? now.slice(before.length) : now;
      return added.split(game.line).join('').replace(/[>\s]/g, '').length >= 3;
    }, 20000, `no output after entering "${game.line}"`);
    ctx.assertNoFatal();
  },

  // pygbag (pygame-ce in the browser): past the "click/touch page" overlay the
  // canvas must be sized by the game and its picture must change.
  async pygbag(page, game, ctx) {
    await goto(page, game.url);
    await until(() => page.evaluate(() => /Ready to start|click\/touch/i.test(document.body.innerText)
      || (document.querySelector('#canvas')?.width || 0) > 1), game.timeoutMs / 2, 'start overlay never appeared');
    const box = page.locator('body');
    await tap(ctx, box);
    const canvas = page.locator('#canvas');
    await until(() => page.evaluate(() => (document.querySelector('#canvas')?.width || 0) > 1), 60000,
      'the game never set up its canvas after the start tap');
    await sleep(3000);
    ctx.assertNoFatal();
    const changed = await waitForChange(page, canvas, {
      tries: 8,
      between: async (i) => {
        const b = await canvas.boundingBox();
        if (b) {
          // Menus put their Start button near, not at, the middle; on a phone the
          // canvas is scaled, so walk a few points around the centre.
          const [fx, fy] = [[0.5, 0.5], [0.5, 0.55], [0.5, 0.45], [0.5, 0.62], [0.5, 0.38], [0.33, 0.5], [0.66, 0.5], [0.5, 0.7]][i % 8];
          const x = b.x + b.width * fx, y = b.y + b.height * fy;
          if (ctx.touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
        }
        await page.keyboard.press(['Space', 'Enter', 'ArrowDown', 'ArrowRight', 'w', 'Escape'][i % 6]).catch(() => {});
      },
    });
    if (!changed) fail('canvas did not change after clicks/keys (frozen or blank)');
    ctx.assertNoFatal();
  },

  // Emscripten/plain canvas games: canvas present, and its picture changes over
  // time or after input.
  async emscripten(page, game, ctx) {
    const url = game.path ? new URL(game.path, game.url).href : game.url;
    await goto(page, url);
    const canvas = page.locator(game.canvas || 'canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: game.timeoutMs / 2 }).catch(() => fail('no visible canvas'));
    await until(() => canvas.evaluate((c) => c.width > 1 && c.height > 1), 30000, 'canvas never got a size');
    if (game.readySelector) {
      // Fail fast if the page shows its own error while we wait for "ready".
      await until(async () => {
        if (game.errorSelector && await page.locator(game.errorSelector).count()) {
          fail(`game error: ${(await page.locator(game.errorSelector).first().innerText()).slice(0, 200)}`);
        }
        return page.locator(game.readySelector).count();
      }, game.timeoutMs - 20000, `never became ready (${game.readySelector})`);
    }
    await sleep(game.settleMs || 3000);
    ctx.assertNoFatal();
    const changed = await waitForChange(page, canvas, {
      tries: 6,
      shotMs: game.shotTimeoutMs,
      between: async (i) => {
        if (game.clickCanvas) {
          const b = await canvas.boundingBox();
          // walk the 3x3 grid's cells so a taken cell does not stall us
          const cx = [0.5, 0.17, 0.83, 0.17, 0.83, 0.5][i % 6], cy = [0.5, 0.17, 0.17, 0.83, 0.83, 0.17][i % 6];
          if (b) {
            const x = b.x + b.width * cx, y = b.y + b.height * cy;
            if (ctx.touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
          }
        }
        for (const k of game.keys || []) {
          // Some games read a tap (Roam's menu ignores a held key), others a
          // hold (Frog Hopper hops while an arrow is down): holdMs picks.
          if (game.holdMs) { await page.keyboard.down(k); await sleep(game.holdMs); await page.keyboard.up(k); } else await page.keyboard.press(k);
          await sleep(150);
        }
      },
    });
    if (!changed) fail('canvas did not change over time or after input (frozen or blank)');
    ctx.assertNoFatal();
  },

  // CheerpJ (Java in the browser): wait for Java to enable the input, send one
  // command, expect matching output.
  async cheerpj(page, game, ctx) {
    await goto(page, game.url);
    const input = page.locator(`${game.input}:enabled`);
    await input.waitFor({ timeout: game.timeoutMs - 10000 }).catch(() => fail('Java never became ready (input stayed disabled)'));
    const term = page.locator(game.terminal || '#terminal');
    const before = await term.innerText();
    await input.fill(game.line);
    await input.press('Enter');
    const re = new RegExp(game.expect);
    await until(async () => {
      const now = await term.innerText();
      return re.test(now.startsWith(before) ? now.slice(before.length) : now);
    }, 30000, `no output matching /${game.expect}/ after "${game.line}"`);
    ctx.assertNoFatal();
  },

  // The React tic-tac-toe: X takes the top row, O plays the middle; X must win.
  async 'react-ttt'(page, game, ctx) {
    await goto(page, game.url);
    const squares = page.locator('button.square');
    await squares.first().waitFor({ timeout: 30000 }).catch(() => fail('board never rendered'));
    for (const i of [0, 3, 1, 4, 2]) await tap(ctx, squares.nth(i));
    await until(() => page.evaluate(() => /winner:?\s*X/i.test(document.body.innerText)), 10000, 'no "Winner: X" after a winning line');
    ctx.assertNoFatal();
  },

  // Strata (WebGL 2 + wasm) pages. CI draws with SwiftShader at 1-3 fps, so
  // this counts frames and reads pixels instead of timing anything: the page
  // must instantiate wasm, get a WebGL 2 context, keep drawing, show a canvas
  // that is not one flat colour, log no Strata error and answer its test hook.
  async strata(page, game, ctx) {
    const url = game.path ? new URL(game.path, game.url).href : game.url;
    // 'commit', not 'domcontentloaded': an Emscripten main loop can hold up
    // the load events for as long as the page runs.
    const res = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    if (!res) fail(`no response from ${url}`);
    if (res.status() >= 400) fail(`HTTP ${res.status()} from ${url}`);
    const probe = () => page.evaluate(() => window.__arcadeWatchStrata);
    const p0 = await until(async () => {
      ctx.assertNoFatal();
      const p = await probe();
      return p && p.wasm > 0 && p.webgl2 > 0 && p.draws > 0 && p;
    }, game.timeoutMs * 0.6, 'never instantiated wasm, made a WebGL 2 context and drew', 1000)
      .catch(async (e) => {
        if (!(e instanceof CheckError) || !/^never/.test(e.message)) throw e;
        const bad = ctx.badResponses.length ? `; failed requests: ${ctx.badResponses.join(', ')}` : '';
        fail(`${e.message} in ${(game.timeoutMs * 0.6 / 1000).toFixed(0)}s (probe ${JSON.stringify(await probe().catch(() => null))}${bad})`);
      });
    if (p0.webgl2Failed) ctx.note(`a WebGL 2 context request returned null ${p0.webgl2Failed} time(s)`);
    ctx.note(`first frame after ${((Date.now() - ctx.started) / 1000).toFixed(1)}s`);
    if (game.ready) {
      await until(() => page.evaluate(game.ready), 30000, `never became ready (${game.ready})`, 1000);
    }

    // Frames advancing: rAF callbacks and WebGL 2 draw calls both keep coming.
    const minFrames = game.minFrames || 3;
    const a = await probe();
    const hook0 = game.hook ? await until(() => readHook(page, game), 30000, `hook ${game.hook} never answered with an object`, 1000) : undefined;
    const b = await until(async () => {
      ctx.assertNoFatal();
      const p = await probe();
      return p.raf - a.raf >= minFrames && p.draws > a.draws && p;
    }, game.framesWithinMs || 30000, `fewer than ${minFrames} frames drawn in ${(game.framesWithinMs || 30000) / 1000}s (frozen)`, 1000);
    ctx.note(`${b.raf - a.raf} frames, ${b.draws - a.draws} draws`);

    // Not blank: a CDP capture of the canvas, decoded here. A Playwright
    // screenshot waits for a stable frame, which a busy WebGL page may never give.
    const canvas = page.locator(game.canvas || 'canvas').first();
    const box = await until(() => canvas.boundingBox(), 10000, 'no visible canvas');
    if (box.width < 2 || box.height < 2) fail(`canvas is ${box.width}x${box.height}`);
    const px = pixelStats(decodePng(await cdpShot(page, { ...box, scale: Math.min(1, 320 / box.width) })));
    ctx.note(`canvas ${Math.round(box.width)}x${Math.round(box.height)}: stddev ${px.stddev.toFixed(1)}, ${px.colours} colours`);
    const minStddev = game.minStddev || 6;
    if (px.stddev < minStddev) fail(`canvas looks blank (luma stddev ${px.stddev.toFixed(1)} < ${minStddev}, ${px.colours} colours)`);

    // The test hook answers, and any counter it names has moved on.
    if (game.hook) {
      const h = await readHook(page, game);
      for (const [k, v] of Object.entries(game.hookExpect || {})) {
        if (JSON.stringify(h[k]) !== JSON.stringify(v)) fail(`hook ${k} is ${JSON.stringify(h[k])}, expected ${JSON.stringify(v)}`);
      }
      if (game.advance) {
        const before = hook0[game.advance], after = h[game.advance];
        if (!(typeof after === 'number' && after > before)) fail(`hook ${game.advance} did not advance (${before} -> ${after})`);
        ctx.note(`${game.advance} ${before} -> ${after}`);
      }
    }
    ctx.assertNoFatal();
  },

  // Just the page: it loads and shows the expected text.
  async page(page, game, ctx) {
    await goto(page, game.url);
    if (game.expect) {
      await until(() => page.evaluate((t) => document.body.innerText.includes(t), game.expect), 30000, `page never showed "${game.expect}"`);
    } else {
      await until(() => page.evaluate(() => document.body.innerText.trim().length > 0), 30000, 'page is blank');
    }
    ctx.assertNoFatal();
  },
};
CHECKS.canvas = CHECKS.emscripten;

// ---------------------------------------------------------------- runner

function compile(list) {
  return (list || []).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}
const IGNORE = compile(CONFIG.defaults.ignore);
// Strata logs through stderr, which Emscripten sends to console.warn, so these
// fail a strata check whatever the console level: Strata's own error lines,
// its error codes, and a failed strata_* call reported by the page.
const STRATA_FATAL = [/\bstrata error:/i, /\bSTRATA_ERROR_\w+/, /\bstrata_\w+\b.*\b(fail(ed|s)?|error)\b/i];

async function attempt(browser, game, profile) {
  const touch = !!PROFILES[profile].hasTouch;
  const context = await browser.newContext({ ...PROFILES[profile], ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const errors = [];
  const notes = [];
  const fatal = compile(game.fatal || CONFIG.defaults.fatal).concat(game.type === 'strata' ? STRATA_FATAL : []);
  const badResponses = [];
  if (game.type === 'strata') {
    await page.addInitScript(strataProbe);
    // A stalled load is easier to read with the requests that went wrong.
    page.on('response', (r) => { if (r.status() >= 400 && badResponses.length < 5) badResponses.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
    page.on('requestfailed', (r) => { if (badResponses.length < 5) badResponses.push(`${(r.failure() || {}).errorText} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  }
  const ignore = IGNORE.concat(compile(game.ignore));
  const record = (kind, text) => {
    if (ignore.some((r) => r.test(text))) return;
    errors.push({ kind, text: text.slice(0, 300) });
  };
  page.on('console', (m) => { if (m.type() === 'error') record('console.error', m.text()); else if (fatal.some((r) => r.test(m.text()))) record(`console.${m.type()}`, m.text()); });
  page.on('pageerror', (e) => record('pageerror', String(e && e.message || e)));
  const started = Date.now();
  const ctx = {
    touch,
    started,
    badResponses,
    note: (n) => notes.push(n),
    assertNoFatal() {
      const bad = errors.find((e) => fatal.some((r) => r.test(e.text)));
      if (bad) fail(`${bad.kind}: ${bad.text}`);
    },
  };
  let timer;
  try {
    await Promise.race([
      CHECKS[game.type](page, game, ctx),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new CheckError(`timed out after ${game.timeoutMs / 1000}s`)), game.timeoutMs); }),
    ]);
    return { ok: true, ms: Date.now() - started, notes, errors, page, context };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e && e.message || e).split('\n')[0].slice(0, 300), notes, errors, page, context };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(browser, game, profile) {
  const id = `${game.slug}@${profile}`;
  const shot = path.join(SHOTS, `${game.slug}-${profile}.png`);
  let r;
  const tries = [];
  for (let n = 1; n <= 2; n++) {
    r = await attempt(browser, game, profile);
    if (game.type === 'strata') {
      await Promise.race([cdpShot(r.page).then((b) => fs.writeFileSync(shot, b)), sleep(15000)]).catch(() => {});
    } else await r.page.screenshot({ path: shot, timeout: 10000 }).catch(() => {});
    await r.context.close().catch(() => {});
    tries.push(r.ok ? 'pass' : r.error);
    if (r.ok) break;
    console.log(`  retry ${id}: ${r.error}`);
  }
  const res = {
    id, slug: game.slug, title: game.title, profile, type: game.type, url: game.url,
    ok: r.ok, error: r.ok ? undefined : r.error, retried: tries.length > 1, tries,
    ms: r.ms, notes: r.notes, errors: r.errors.slice(0, 5),
    screenshot: path.relative(OUT_DIR, shot),
    unconfigured: !!game.unconfigured,
  };
  console.log(`${res.ok ? 'PASS' : 'FAIL'} ${id} (${(r.ms / 1000).toFixed(1)}s)${res.retried ? ' [retried]' : ''}${res.ok ? '' : ' - ' + res.error}`);
  return res;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'arcade-watch (+https://github.com/Stephenson-Software/arcade-watch)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

// Cheap HTTP checks: the API health endpoint and every alias host.
async function httpCheck(id, title, url) {
  let lastErr;
  for (let n = 1; n <= 2; n++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'arcade-watch-monitor' } });
      if (r.ok) { console.log(`PASS ${id}`); return { id, slug: id, title, profile: 'http', type: 'http', url, ok: true, retried: n > 1 }; }
      lastErr = `HTTP ${r.status}`;
    } catch (e) { lastErr = String(e.message || e); }
    await sleep(3000);
  }
  console.log(`FAIL ${id} - ${lastErr}`);
  return { id, slug: id, title, profile: 'http', type: 'http', url, ok: false, error: `${url}: ${lastErr}`, retried: true };
}

async function portalCheck(browser, expected) {
  const game = { slug: 'portal', title: 'danielstephenson.dev/play', url: CONFIG.portal.url, type: 'portal', timeoutMs: 60000 };
  CHECKS.portal = async (page) => {
    await goto(page, CONFIG.portal.url);
    const tiles = page.locator(CONFIG.portal.tileSelector);
    await tiles.first().waitFor({ timeout: 30000 }).catch(() => fail('no game tiles rendered'));
    await sleep(1000);
    const n = await tiles.count();
    if (n !== expected) fail(`${n} tiles shown, expected ${expected} (registry games + link-outs)`);
  };
  return runCheck(browser, game, 'desktop');
}

// ---------------------------------------------------------------- alerting

function loadPrev() {
  const p = process.env.PREV_STATE;
  if (!p || !fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).checks || {}; } catch { return {}; }
}

async function postDiscord(text, files) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) { console.log('DISCORD_WEBHOOK_URL not set; not posting:\n' + text); return false; }
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: text.slice(0, 1990), allowed_mentions: { parse: [] } }));
  files.slice(0, 4).forEach((f, i) => {
    if (fs.existsSync(f)) form.append(`files[${i}]`, new Blob([fs.readFileSync(f)], { type: 'image/png' }), path.basename(f));
  });
  // Discord rejects some default user agents; name ourselves.
  const r = await fetch(hook, { method: 'POST', body: form, headers: { 'user-agent': 'arcade-watch (https://github.com/Stephenson-Software/arcade-watch, 0.1)' } });
  if (!r.ok) { console.log(`Discord post failed: HTTP ${r.status} ${await r.text()}`); return false; }
  return true;
}

function summarize(results, prev, meta) {
  const failing = results.filter((r) => !r.ok);
  const newly = failing.filter((r) => !prev[r.id] || prev[r.id].ok);
  const still = failing.filter((r) => prev[r.id] && !prev[r.id].ok);
  const recovered = results.filter((r) => r.ok && prev[r.id] && !prev[r.id].ok);
  return { failing, newly, still, recovered };
}

function stepSummary(results, s, meta) {
  const byGame = new Map();
  for (const r of results) {
    if (!byGame.has(r.slug)) byGame.set(r.slug, { title: r.title, type: r.type, url: r.url, cells: {} });
    byGame.get(r.slug).cells[r.profile] = r;
  }
  const cell = (r) => !r ? '-' : (r.ok ? (r.retried ? 'PASS (retry)' : 'PASS') : `**FAIL**: ${r.error.replace(/\|/g, '\\|')}`);
  const lines = [
    `## arcade-watch: ${s.failing.length ? `${s.failing.length} failing` : 'all games healthy'}`,
    '',
    `${results.length} checks in ${(meta.ms / 1000).toFixed(0)}s, ${meta.when}.`,
    '',
    '| Game | Type | Desktop | iPhone 13 |',
    '|---|---|---|---|',
  ];
  for (const [slug, g] of byGame) {
    const one = g.cells.http || g.cells.desktop;
    if (g.type === 'http' || g.type === 'portal') lines.push(`| [${g.title}](${g.url}) | ${g.type} | ${cell(one)} | |`);
    else lines.push(`| [${g.title}](${g.url}) | ${g.type} | ${cell(g.cells.desktop)} | ${cell(g.cells.iphone)} |`);
  }
  if (s.recovered.length) lines.push('', `Recovered: ${s.recovered.map((r) => r.id).join(', ')}`);
  const unconf = [...new Set(results.filter((r) => r.unconfigured).map((r) => r.slug))];
  if (unconf.length) lines.push('', `Not in games.json (only a page-load check ran; add them): ${unconf.join(', ')}`);
  const noisy = results.filter((r) => r.ok && r.errors && r.errors.length);
  if (noisy.length) {
    lines.push('', '<details><summary>Console errors on passing checks (not fatal)</summary>', '');
    for (const r of noisy) lines.push(`- ${r.id}: ${r.errors.map((e) => '`' + e.text.replace(/`/g, "'").slice(0, 120) + '`').join(', ')}`);
    lines.push('', '</details>');
  }
  lines.push('', 'Screenshots: the `screenshots` artifact of this run.');
  return lines.join('\n') + '\n';
}

function alertText(s) {
  const L = [];
  const link = RUN_URL ? ` - run + screenshots: ${RUN_URL}` : '';
  if (s.failing.length) L.push(`**arcade-watch: ${s.failing.length} check(s) failing**${link}`);
  else L.push(`**arcade-watch: all games healthy again**${link}`);
  for (const r of s.newly) L.push(`- NEW FAIL ${r.title} (${r.profile}): ${r.error}`);
  for (const r of s.still) L.push(`- still failing ${r.title} (${r.profile}): ${r.error}`);
  for (const r of s.recovered) L.push(`- recovered ${r.title} (${r.profile})`);
  return L.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(SHOTS, { recursive: true });
  const only = arg('only') ? arg('only').split(',') : null;
  const profiles = (arg('profiles') || 'desktop,iphone').split(',');

  const registry = (await fetchJson(CONFIG.registry)).games;
  // A link-out that has since joined the registry is one tile and one game:
  // its entry configures the registry game instead of adding a second one.
  const linkouts = Object.entries(CONFIG.linkouts).filter(([slug]) => !registry.some((g) => g.slug === slug));
  const promoted = Object.keys(CONFIG.linkouts).filter((s) => registry.some((g) => g.slug === s));
  if (promoted.length) console.log(`note: link-outs now in the registry (move them under games): ${promoted.join(', ')}`);
  const games = [];
  for (const g of registry) {
    const conf = CONFIG.games[g.slug] || CONFIG.linkouts[g.slug];
    games.push({
      slug: g.slug, title: g.title, url: g.url, aliases: g.aliases || [],
      ...CONFIG.defaults, ...(conf || { type: 'page', unconfigured: true }),
    });
  }
  for (const [slug, l] of linkouts) games.push({ slug, aliases: [], ...CONFIG.defaults, ...l });
  for (const g of games) g.timeoutMs = g.timeoutMs || CONFIG.defaults.timeoutMs;
  const expectedTiles = registry.length + linkouts.length;
  const stale = Object.keys(CONFIG.games).filter((s) => !registry.some((g) => g.slug === s));
  if (stale.length) console.log(`note: in games.json but not in the registry: ${stale.join(', ')}`);

  const selected = only ? games.filter((g) => only.includes(g.slug)) : games;
  const jobs = [];
  for (const g of selected) for (const p of profiles) jobs.push([g, p]);
  // Heaviest first so the slow ones do not trail at the end.
  jobs.sort((a, b) => b[0].timeoutMs - a[0].timeoutMs);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const results = [];
  if (!only) {
    results.push(await httpCheck('api-healthz', 'api.play healthz', CONFIG.health));
    results.push(await portalCheck(browser, expectedTiles));
    for (const g of selected) for (const a of g.aliases) results.push(await httpCheck(`alias:${a}`, `${g.title} alias ${a}`, `https://${a}/`));
  }
  results.push(...await pool(jobs, CONCURRENCY, ([g, p]) => runCheck(browser, g, p)));
  await browser.close();

  const meta = { ms: Date.now() - t0, when: new Date().toISOString() };
  const prev = loadPrev();
  const s = summarize(results, prev, meta);

  // state.json carries forward results for checks that did not run this time
  // (e.g. a --only run), so a partial run does not fake a recovery.
  const checks = { ...prev };
  for (const r of results) checks[r.id] = { ok: r.ok, error: r.error, since: r.ok ? undefined : (prev[r.id] && !prev[r.id].ok ? prev[r.id].since : meta.when) };
  fs.writeFileSync(path.join(OUT_DIR, 'state.json'), JSON.stringify({ when: meta.when, checks }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ ...meta, results }, null, 2));
  const md = stepSummary(results, s, meta);
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

  if (s.newly.length || s.still.length || s.recovered.length) {
    const shots = s.failing.map((r) => r.screenshot && path.join(OUT_DIR, r.screenshot)).filter(Boolean);
    await postDiscord(alertText(s), shots);
  }
  console.log(`\n${results.length - s.failing.length}/${results.length} checks passed in ${(meta.ms / 1000).toFixed(0)}s`);
  process.exitCode = s.failing.length ? 1 : 0;
}

main().catch(async (e) => {
  // The watcher itself broke (registry unreachable, browser would not start...):
  // that is worth an alert too, or a dead registry would go unnoticed.
  console.error(e);
  process.exitCode = 2;
  await postDiscord(`**arcade-watch could not run**: ${String(e && e.message || e).slice(0, 300)}${RUN_URL ? ` - ${RUN_URL}` : ''}`, []).catch(() => {});
});
