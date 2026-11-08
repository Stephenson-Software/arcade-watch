#!/usr/bin/env node
// Offline check of games.json against watch.js: no network, no browser.
// Fails when a game names a check type that watch.js does not define, when a
// required field is missing, or when a per-game option has the wrong shape.
// It then runs the same rules on known-bad copies of the config and fails if
// any of them is accepted, so a rule that stops working cannot stay green.
// Usage: node scripts/check-config.js [games.json]
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const file = process.argv[2] || path.join(root, 'games.json');
const src = fs.readFileSync(path.join(root, 'watch.js'), 'utf8');

// Check types: the methods of `const CHECKS = { ... }` plus `CHECKS.x = ...`.
// `portal` is assigned inside portalCheck and is not a type games.json may use.
const types = new Set();
for (const m of src.matchAll(/^ {2}async (?:'([^']+)'|(\w+))\(page, game, ctx\)/gm)) types.add(m[1] || m[2]);
for (const m of src.matchAll(/^CHECKS\.(\w+) = /gm)) types.add(m[1]);

let config;
try {
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`${file}: ${e.message}`);
  process.exit(1);
}

const isUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const REQUIRED = { 'tak-console': ['line'], cheerpj: ['input', 'line', 'expect'] };

// Returns the list of problems in `config`; empty means valid.
function validate(config) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (types.size === 0) err('no check types found in watch.js (did the CHECKS layout change?)');

  for (const key of ['registry', 'health']) if (!isUrl(config[key])) err(`${key}: not an http(s) URL`);
  if (!config.portal || !isUrl(config.portal.url)) err('portal.url: not an http(s) URL');
  if (!config.portal || typeof config.portal.tileSelector !== 'string') err('portal.tileSelector: missing');

  const d = config.defaults || {};
  if (!Number.isFinite(d.timeoutMs) || d.timeoutMs <= 5000) err('defaults.timeoutMs: must be a number above 5000');
  if (!isStrList(d.ignore)) err('defaults.ignore: must be a list of strings');
  if (!isStrList(d.fatal)) err('defaults.fatal: must be a list of strings');

  function checkGame(where, g, isLinkout) {
    if (!g || typeof g !== 'object') return err(`${where}: not an object`);
    if (!types.has(g.type)) err(`${where}: type "${g.type}" is not a check in watch.js (known: ${[...types].sort().join(', ')})`);
    if (isLinkout) {
      if (typeof g.title !== 'string' || !g.title) err(`${where}: link-out needs a title`);
      if (!isUrl(g.url)) err(`${where}: link-out needs an http(s) url`);
    }
    if ('timeoutMs' in g && (!Number.isFinite(g.timeoutMs) || g.timeoutMs <= 5000)) err(`${where}: timeoutMs must be a number above 5000`);
    for (const k of ['settleMs', 'holdMs', 'shotTimeoutMs', 'minFrames', 'framesWithinMs', 'minStddev']) if (k in g && !Number.isFinite(g[k])) err(`${where}: ${k} must be a number`);
    for (const k of ['keys', 'ignore', 'fatal']) if (k in g && !isStrList(g[k])) err(`${where}: ${k} must be a list of strings`);
    for (const k of ['line', 'expect', 'input', 'terminal', 'canvas', 'readySelector', 'errorSelector', 'path', 'ready', 'hook', 'advance']) if (k in g && typeof g[k] !== 'string') err(`${where}: ${k} must be a string`);
    // watch.js reads `game.terminal || '#terminal'`, so a blank value would watch
    // the default element instead of failing.
    if ('hookExpect' in g && (!g.hookExpect || typeof g.hookExpect !== 'object' || Array.isArray(g.hookExpect))) err(`${where}: hookExpect must be an object of field: value`);
    if (('advance' in g || 'hookExpect' in g) && !('hook' in g)) err(`${where}: advance and hookExpect need a hook`);
    if ('clickCanvas' in g && typeof g.clickCanvas !== 'boolean') err(`${where}: clickCanvas must be true or false`);
    // Fields a check cannot run without. A cheerpj check with no `expect`, or an
    // empty one, builds a RegExp that matches anything and passes at once; an
    // empty `input` makes the locator `:enabled`, the first enabled element.
    for (const k of REQUIRED[g.type] || []) if (!(k in g) || (typeof g[k] === 'string' && !g[k].trim())) err(`${where}: a ${g.type} check needs a non-empty ${k}`);
    if (g.type === 'cheerpj' && typeof g.expect === 'string') {
      try { new RegExp(g.expect); } catch (e) { err(`${where}: expect is not a valid regular expression (${e.message})`); }
    }
  }

  if (!config.games || typeof config.games !== 'object') err('games: missing');
  for (const [slug, g] of Object.entries(config.games || {})) checkGame(`games.${slug}`, g, false);
  if (!config.linkouts || typeof config.linkouts !== 'object') err('linkouts: missing');
  for (const [slug, g] of Object.entries(config.linkouts || {})) {
    checkGame(`linkouts.${slug}`, g, true);
    if (config.games && slug in config.games) err(`linkouts.${slug}: also listed under games`);
  }
  return errors;
}

// Known-bad configs: each case adds or changes one entry of a copy of the
// config and must be rejected with an error containing `expect`. The entries
// are written out in full so the cases do not depend on which games are in
// games.json today.
const BAD = [
  ['unknown type', { games: { x: { type: 'no-such-check' } } }, 'games.x: type "no-such-check" is not a check'],
  ['tak-console without line', { games: { x: { type: 'tak-console' } } }, 'games.x: a tak-console check needs a non-empty line'],
  ['cheerpj with blank input', { games: { x: { type: 'cheerpj', input: ' ', line: 'a', expect: 'a' } } }, 'games.x: a cheerpj check needs a non-empty input'],
  ['cheerpj without line', { games: { x: { type: 'cheerpj', input: '#in', expect: 'a' } } }, 'games.x: a cheerpj check needs a non-empty line'],
  ['cheerpj with empty expect', { games: { x: { type: 'cheerpj', input: '#in', line: 'a', expect: '' } } }, 'games.x: a cheerpj check needs a non-empty expect'],
  ['cheerpj with bad expect', { games: { x: { type: 'cheerpj', input: '#in', line: 'a', expect: '[' } } }, 'games.x: expect is not a valid regular expression'],
  ['blank terminal', { games: { x: { type: 'tak-console', line: 'a', terminal: '' } } }, 'games.x: terminal must not be blank'],
  ['advance without hook', { games: { x: { type: 'strata', advance: 'tick' } } }, 'games.x: advance and hookExpect need a hook'],
  ['hookExpect as a list', { games: { x: { type: 'strata', hook: 'h()', hookExpect: [] } } }, 'games.x: hookExpect must be an object'],
  ['timeoutMs too low', { games: { x: { type: 'tak', timeoutMs: 5000 } } }, 'games.x: timeoutMs must be a number above 5000'],
  ['keys not a list', { games: { x: { type: 'emscripten', keys: 'ArrowUp' } } }, 'games.x: keys must be a list of strings'],
  ['clickCanvas as a string', { games: { x: { type: 'emscripten', clickCanvas: 'true' } } }, 'games.x: clickCanvas must be true or false'],
  ['link-out without url', { linkouts: { x: { type: 'page', title: 'X' } } }, 'linkouts.x: link-out needs an http(s) url'],
  ['defaults.ignore not a list', { defaults: { ignore: 'blanker' } }, 'defaults.ignore: must be a list of strings'],
];

function withChange(change) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const [section, entries] of Object.entries(change)) copy[section] = { ...copy[section], ...entries };
  return copy;
}

const errors = validate(config);
if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
const selfTest = [];
for (const [name, change, expect] of BAD) {
  const got = validate(withChange(change));
  if (!got.some((e) => e.includes(expect))) selfTest.push(`self-test "${name}": expected an error containing "${expect}", got ${got.length ? got.map((e) => `"${e}"`).join(', ') : 'none'}`);
}
if (selfTest.length) {
  for (const e of selfTest) console.error(`FAIL ${e}`);
  process.exit(1);
}
const n = Object.keys(config.games).length + Object.keys(config.linkouts).length;
console.log(`games.json OK: ${n} entries, check types used all defined (${[...types].sort().join(', ')})`);
console.log(`self-test OK: all ${BAD.length} known-bad configs rejected`);
