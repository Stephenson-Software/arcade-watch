#!/usr/bin/env node
// Offline check of games.json against watch.js: no network, no browser.
// Fails when a game names a check type that watch.js does not define, when a
// required field is missing, or when a per-game option has the wrong shape.
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

const errors = [];
const err = (msg) => errors.push(msg);
let config;
try {
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`${file}: ${e.message}`);
  process.exit(1);
}

if (types.size === 0) err('no check types found in watch.js (did the CHECKS layout change?)');

const isUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

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
  for (const k of ['line', 'expect', 'canvas', 'readySelector', 'errorSelector', 'path', 'ready', 'hook', 'advance']) if (k in g && typeof g[k] !== 'string') err(`${where}: ${k} must be a string`);
  if ('hookExpect' in g && (!g.hookExpect || typeof g.hookExpect !== 'object' || Array.isArray(g.hookExpect))) err(`${where}: hookExpect must be an object of field: value`);
  if (('advance' in g || 'hookExpect' in g) && !('hook' in g)) err(`${where}: advance and hookExpect need a hook`);
}

if (!config.games || typeof config.games !== 'object') err('games: missing');
for (const [slug, g] of Object.entries(config.games || {})) checkGame(`games.${slug}`, g, false);
if (!config.linkouts || typeof config.linkouts !== 'object') err('linkouts: missing');
for (const [slug, g] of Object.entries(config.linkouts || {})) {
  checkGame(`linkouts.${slug}`, g, true);
  if (config.games && slug in config.games) err(`linkouts.${slug}: also listed under games`);
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
const n = Object.keys(config.games).length + Object.keys(config.linkouts).length;
console.log(`games.json OK: ${n} entries, check types used all defined (${[...types].sort().join(', ')})`);
