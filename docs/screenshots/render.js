'use strict';
// Rebuilds the README images from one real scheduled run of watch.yml:
// its `screenshots` artifact (results.json + the last screenshot of every
// check) and its log. Nothing is drawn by hand: the grids are the run's own
// screenshots, the job summary is stepSummary() applied to the run's
// results.json, and the log excerpt is the run's own PASS/FAIL lines.
//
// Usage (needs gh, signed in): node docs/screenshots/render.js <run-id>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { summarize, stepSummary } = require('../../watch.js');

const RUN = process.argv[2];
if (!/^\d+$/.test(RUN || '')) { console.error('usage: node docs/screenshots/render.js <run-id>'); process.exit(2); }
const REPO = 'Stephenson-Software/arcade-watch';
const OUT = __dirname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-watch-shots-'));
execFileSync('gh', ['run', 'download', RUN, '-R', REPO, '-n', 'screenshots', '-D', work], { stdio: 'inherit' });
const log = execFileSync('gh', ['run', 'view', RUN, '-R', REPO, '--log'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const { results, ms, when } = JSON.parse(fs.readFileSync(path.join(work, 'results.json'), 'utf8'));
const passed = results.filter((r) => r.ok).length;
const day = when.slice(0, 10);

const DESKTOP = ['tidewater', 'guess-my-word', 'simplefight', 'tic-tac-toe-java', 'frog-hopper', 'orrery', 'second-helping', 'steading'];
const IPHONE = ['night-ferry', 'kreatures', 'frog-hopper', 'tic-tac-toe-sdl', 'pumpkin', 'replay-player'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const CARD_CSS = `*{box-sizing:border-box}body{margin:0;background:#0f1419;color:#e6e6e6;font:14px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:20px}
.grid{display:grid;gap:14px}.t{background:#1a2129;border:1px solid #2b3540;border-radius:8px;overflow:hidden}.t img{display:block;width:100%}
.c{padding:7px 10px;display:flex;justify-content:space-between;gap:8px;font-size:13px}.c b{color:#fff}.ty{color:#8fa3b5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.p{font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:nowrap}.ok{color:#3fb950}.bad{color:#f85149}
h1{font-size:16px;margin:0 0 14px;color:#c9d1d9;font-weight:600}h1 span{color:#8fa3b5;font-weight:400}`;

function tiles(slugs, profile) {
  return slugs.map((slug) => {
    const r = results.find((x) => x.id === `${slug}@${profile}`);
    if (!r) throw new Error(`no ${slug}@${profile} in run ${RUN}`);
    const img = 'file://' + path.join(work, r.screenshot);
    const verdict = r.ok ? `<span class="p ok">PASS ${(r.ms / 1000).toFixed(1)}s</span>` : '<span class="p bad">FAIL</span>';
    return `<div class="t"><img src="${img}"><div class="c"><span><b>${esc(r.title)}</b> <span class="ty">${r.type}</span></span>${verdict}</div></div>`;
  }).join('');
}

function summaryHtml(md) {
  const inl = (s) => esc(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a>$1</a>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  let h = '';
  let inTable = false;
  for (const l of md.split('\n')) {
    if (l.startsWith('|')) {
      const cells = l.slice(1, -1).split('|').map((s) => s.trim());
      if (cells[0].startsWith('---')) continue;
      const tag = inTable ? 'td' : 'th';
      if (!inTable) { h += '<table>'; inTable = true; }
      h += '<tr>' + cells.map((c) => `<${tag} class="${c.startsWith('PASS') ? 'ok' : ''}">${inl(c)}</${tag}>`).join('') + '</tr>';
      continue;
    }
    if (inTable) { h += '</table>'; inTable = false; }
    if (l.startsWith('## ')) h += `<h2>${inl(l.slice(3))}</h2>`;
    else if (l.trim()) h += `<p>${inl(l)}</p>`;
  }
  return `<style>body{margin:0;background:#fff;color:#1f2328;font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:20px 24px}h2{font-size:20px;margin:0 0 8px;border-bottom:1px solid #d1d9e0;padding-bottom:6px}table{border-collapse:collapse;font-size:13px}th,td{border:1px solid #d1d9e0;padding:3px 10px;text-align:left}th{background:#f6f8fa}tr:nth-child(even) td{background:#f6f8fa}a{color:#0969da}td.ok{color:#1a7f37;font-weight:600}code{background:#eff1f3;padding:1px 4px;border-radius:4px;font-size:12px}</style>${h}`;
}

function logHtml() {
  // The watcher's own lines, with the Actions log prefix (job, step, timestamp) removed.
  const lines = log.split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+ /, '')).filter((l) => /^(PASS |FAIL |  retry |\d+\/\d+ checks passed)/.test(l));
  const pick = lines.length > 26 ? [...lines.slice(0, 18), null, ...lines.slice(-6)] : lines;
  const line = (l) => l === null
    ? `<span class="g">  … ${lines.length - 24} more check lines …</span>`
    : esc(l).replace(/^PASS/, '<span class="ok">PASS</span>').replace(/^FAIL/, '<span class="bad">FAIL</span>')
      .replace(/(\([\d.]+s\))/, '<span class="g">$1</span>').replace(/^(\d+\/\d+ checks passed.*)$/, '<b>$1</b>');
  return `<style>body{margin:0;background:#0d1117;padding:18px 22px;color:#c9d1d9;font:13px/1.5 ui-monospace,DejaVu Sans Mono,Menlo,Consolas,monospace}pre{margin:0}.ok{color:#3fb950}.bad{color:#f85149}.g{color:#7d8590}b{color:#fff}</style><pre><span class="g">$ node watch.js</span>\n${pick.map(line).join('\n')}</pre>`;
}

const pages = [
  ['checks-desktop.jpg', 1240, `<style>${CARD_CSS}.grid{grid-template-columns:repeat(4,1fr)}</style><h1>Last screenshot of each check, Desktop Chrome profile <span>· scheduled run ${day} · ${passed}/${results.length} checks passed</span></h1><div class="grid">${tiles(DESKTOP, 'desktop')}</div>`],
  ['checks-iphone.jpg', 1240, `<style>${CARD_CSS}.grid{grid-template-columns:repeat(6,1fr)}.t img{aspect-ratio:390/664;object-fit:cover;object-position:top}.c{flex-direction:column;gap:2px}</style><h1>Same run, iPhone 13 profile <span>· Mobile Safari UA, touch, 390 px viewport</span></h1><div class="grid">${tiles(IPHONE, 'iphone')}</div>`],
  ['job-summary.png', 820, summaryHtml(stepSummary(results, summarize(results, {}), { ms, when }))],
  ['run-log.png', 760, logHtml()],
];

(async () => {
  const browser = await chromium.launch();
  for (const [name, width, html] of pages) {
    const file = path.join(work, name + '.html');
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8">${html}`);
    const page = await browser.newPage({ viewport: { width, height: 400 } });
    await page.goto('file://' + file);
    const jpeg = name.endsWith('.jpg');
    await page.screenshot({ path: path.join(OUT, name), fullPage: true, type: jpeg ? 'jpeg' : 'png', quality: jpeg ? 84 : undefined });
    console.log(`wrote docs/screenshots/${name}`);
  }
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
