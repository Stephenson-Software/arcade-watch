# CLAUDE.md

## Project overview

arcade-watch is a daily health check for every game on <https://danielstephenson.dev/play>. A scheduled GitHub Actions workflow loads each game in headless Chromium on two profiles (Desktop Chrome and Playwright's iPhone 13), checks that the game starts and responds to input, and posts new failures and recoveries to Discord. See `README.md` for the full description of each check type.

## Technology stack

- Node.js (>= 20 per `package.json` `engines`; CI uses Node 22), CommonJS (`'use strict'`, `require`)
- Playwright `1.61.1` (pinned exactly in `package.json`), Chromium only
- GitHub Actions (`.github/workflows/watch.yml`) for scheduling, state artifacts and the job summary
- No build step, no database, no test framework, no linter config (`npm test` is a plain-Node offline check)

## Build and run commands

```bash
# Install dependencies and the browser
npm ci
npx playwright install chromium

# Check one game on both profiles against the live site
node watch.js --only tidewater

# Check one game on one profile
node watch.js --only tidewater --profiles desktop

# Full run (every registry game + link-outs + portal/API/alias checks)
node watch.js            # same as: npm run watch

# Offline check: syntax + games.json validated against watch.js (no network, no browser)
npm test
```

Results, screenshots, `state.json` and `summary.md` are written to `./out` (gitignored).

Environment variables read by `watch.js` (all optional locally):

| Variable | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | Post failures/recoveries here. Unset: the message is printed to the log instead. |
| `PREV_STATE` | Path to the previous run's `state.json`, used to tell new failures from ongoing ones. |
| `OUT_DIR` | Output directory (default `./out`). |
| `CONCURRENCY` | Parallel checks (default 4). |
| `RUN_URL` | Link to the run, included in alerts. |
| `GAMES_FILE` | Alternative to `games.json`. |
| `GITHUB_STEP_SUMMARY` | Set by Actions; the results table is appended here. |

Leave `DISCORD_WEBHOOK_URL` unset when running locally so nothing is posted to the real channel.

## Test commands

There is no unit test suite. `npm test` is the offline check (what PR CI runs): `node --check` on `watch.js` and `scripts/check-config.js`, then `node scripts/check-config.js`, which fails if a game in `games.json` names a check type that `watch.js` does not define or has a malformed field. Behaviour is verified by a real run against the live arcade:

```bash
node watch.js --only <slug> [--profiles desktop,iphone]
```

A failing check exits non-zero; a watcher that cannot run at all exits 2.

## CI

`.github/workflows/test.yml` (job `test`) runs on every pull request and on pushes to `main`: `npm ci` (lockfile must match `package.json`) then `npm test`. It is offline: no browser, no live games, no secrets. This `test` check is the merge gate.

`.github/workflows/watch.yml` runs on a daily cron (`0 4 * * *`; nothing may run 10:00-18:00 Denver, and GitHub starts scheduled runs hours late) and on `workflow_dispatch` (optional `only` input). It does **not** run on pushes or pull requests. Only runs on `main` get `DISCORD_WEBHOOK_URL`, so a branch dispatch can be used to try a change without alerting. Only a full run on `main` uploads the `state` artifact; a partial `--only` run must never record state, or it would hide a failure from the next daily run.

## Repository layout

```
watch.js        The whole watcher: profiles, CHECKS per game type, retry, portal/API/alias checks, state diff, Discord post, summary
games.json      Portal/registry/health URLs, defaults (timeoutMs, ignore, fatal), per-game check config, link-out games
scripts/check-config.js       Offline validation of games.json against the check types in watch.js (npm test)
.github/workflows/watch.yml   Daily schedule, previous-state download, artifact uploads
.github/workflows/test.yml    PR/push check: npm ci + npm test
package.json    Single dependency (playwright)
LICENSE         Stephenson-NC
```

## Coding conventions

- Plain CommonJS JavaScript, 2-space indent, single quotes, semicolons, `camelCase` functions, `UPPER_CASE` module-level constants.
- A check type is a function in the `CHECKS` object in `watch.js` with signature `(page, game, ctx)`. It signals failure with `fail("what went wrong")` (throws `CheckError`).
- Use `tap(ctx, locator)` rather than `locator.click()` so the iPhone profile taps.
- Strata (WebGL 2) pages use the `strata` check: open with `waitUntil: 'commit'`, count frames with the init-script probe and capture with `cdpShot` (CDP `Page.captureScreenshot`). Never assert a frame rate: CI draws with SwiftShader at 1-3 fps.
- Use the `until(...)` / `waitForChange(...)` helpers for polling instead of fixed sleeps where possible.
- Per-game options live in `games.json`, not in code. The game list itself comes live from the registry (`/api/games`); `games.json` only adds check config and link-outs.

## Do / Don't

**Do:**
- When a game is added to the arcade, add its slug to `games` in `games.json` with a check type (otherwise it only gets a `page` load check and is listed under "Not in games.json").
- Verify any change with `node watch.js --only <slug>` against the live site before opening a PR, and say which slugs/profiles were run.
- Keep the `UA_SUFFIX` monitor token: the arcade's play counter uses it to exclude these loads from public play counts.
- When adding a check type or a new per-game option, extend `scripts/check-config.js` if it needs validating.
- Keep messages in `defaults.ignore` narrow; only known-benign console lines belong there.

**Don't:**
- Don't set a real `DISCORD_WEBHOOK_URL` locally or commit any webhook URL.
- Don't make the state upload step run for partial (`only`) runs or for branches other than `main`.
- Don't add a database or external state store; state is carried between runs as the `state` workflow artifact by design.
- Don't commit `out/` or `node_modules/`.
- Don't bump Playwright with a range; it is pinned to an exact version.
