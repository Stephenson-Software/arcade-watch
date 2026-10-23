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
async function waitForChange(page, target, { tries = 6, gapMs = 2000, between } = {}) {
  const shot = async () => hash(target ? await target.screenshot({ timeout: 15000 }) : await page.screenshot());
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

async function attempt(browser, game, profile) {
  const touch = !!PROFILES[profile].hasTouch;
  const context = await browser.newContext({ ...PROFILES[profile], ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const errors = [];
  const notes = [];
  const fatal = compile(game.fatal || CONFIG.defaults.fatal);
  const ignore = IGNORE.concat(compile(game.ignore));
  const record = (kind, text) => {
    if (ignore.some((r) => r.test(text))) return;
    errors.push({ kind, text: text.slice(0, 300) });
  };
  page.on('console', (m) => { if (m.type() === 'error') record('console.error', m.text()); else if (fatal.some((r) => r.test(m.text()))) record(`console.${m.type()}`, m.text()); });
  page.on('pageerror', (e) => record('pageerror', String(e && e.message || e)));
  const ctx = {
    touch,
    note: (n) => notes.push(n),
    assertNoFatal() {
      const bad = errors.find((e) => fatal.some((r) => r.test(e.text)));
      if (bad) fail(`${bad.kind}: ${bad.text}`);
    },
  };
  let timer;
  const started = Date.now();
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
    await r.page.screenshot({ path: shot, timeout: 10000 }).catch(() => {});
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
