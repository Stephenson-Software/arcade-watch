# arcade-watch

A daily health check for every game on [danielstephenson.dev/play](https://danielstephenson.dev/play).

Every day at 04:00 UTC, a GitHub Actions workflow opens each game in headless Chromium, twice: once as a desktop browser and once with Playwright's **iPhone 13** profile. The iPhone profile sends a Mobile Safari user agent and uses touch, so games that sniff the UA (Pyodide does) take their iOS code path. The workflow checks that each game actually **starts** and **responds to input**. Loading the page is not enough to pass. When a check fails, or recovers after failing, it posts to Discord.

## What is checked

The game list is read live from the arcade registry, <https://play.danielstephenson.dev/api/games>. The portal's link-out games (Roam and Barony) are added from `games.json`. If a link-out's slug also appears in the registry, it is counted once: its `linkouts` entry (including its `url`) configures that registry game, and the log notes that the entry should move under `games`. Each game has a check type:

| Type | Games | Passes when |
|---|---|---|
| `tak` | FishE, Tidewater, Overwinter, Night Ferry | `#app button` appears; the first enabled button is tapped 3 times and the screen changes each time; no `SuspendError`/`fatal`/`Traceback`/`PythonError` in the console |
| `tak-console` | Guess My Word, Kreatures, Cave, Simple Dice Throw | `.tak-console-input` becomes enabled; after one line (`line`) is submitted, new output appears |
| `pygbag` | Rock Paper Scissors, Ophidian, Apex, Tic Tac Toe (pygame) | after a tap on the "Ready to start" overlay, the game sizes its canvas; the canvas picture changes after clicks/keys (screenshot hashes differ) |
| `emscripten` / `canvas` | Frog Hopper, Tic Tac Toe (SDL), Microbiome, SDL Sketches (bouncing rectangle), Roam | a sized canvas is visible; its picture changes over time or after input (`keys`, `clickCanvas`); optional `readySelector`/`errorSelector` |
| `cheerpj` | Tic Tac Toe (Java), Interakt | Java enables the input (`input`); one command (`line`) produces output matching `expect` |
| `react-ttt` | Tic Tac Toe (Web) | clicking squares 0,3,1,4,2 shows "Winner: X" |
| `page` | Barony (needs an account) | the page loads with HTTP < 400 and shows `expect` (without `expect`, any text) |

These checks run on every run as well:

- **Portal**: <https://danielstephenson.dev/play> shows exactly as many tiles (`#games [data-testid=catalogue-tile]`) as there are registry games plus the link-outs that are not in the registry.
- **API**: <https://api.play.danielstephenson.dev/healthz> returns 200.
- **Aliases**: every `aliases` host in the registry (e.g. `fishe.danielstephenson.dev`) returns 200.

Across all games:

- **Console errors.** A console message or page error that matches `defaults.fatal` fails the check. Messages that match `defaults.ignore` are dropped; these are the known-benign pygbag `BrowserFS not found`, `blanker` and `MEDIA USER ACTION REQUIRED` lines, WebGL driver notes, and iframe permission-policy notes (`Unrecognized feature`, `allowfullscreen`). A game's own `ignore` list is added to `defaults.ignore`; a game's own `fatal` list replaces `defaults.fatal`. Other console errors on a passing check are listed in the run summary but do not fail it.
- **One retry.** A check that fails is retried once in a fresh browser context. If it passes on the retry, the summary marks it `PASS (retry)`, which points to flakiness.
- **Time budget.** Each attempt has a budget (`timeoutMs`; 90 s by default, 150 s for pygbag, CheerpJ and Roam, 180 s for Microbiome). The checks run 4 at a time, and the workflow is capped at 20 minutes. A full run takes about 2 minutes.
- **Unknown games.** A registry game that is not in `games.json` still gets a `page` load check. The summary lists it under "Not in games.json", so it gets noticed and given a real check.

## Alerting

There is no database. State is carried from run to run as a workflow artifact:

1. Every full run on `main` uploads `out/state.json` as the `state` artifact (kept 30 days). The file records pass/fail for each check and when each failure started.
2. The next run downloads the newest `state` artifact with `gh run download`, using the job's own `GITHUB_TOKEN` (`actions: read`).
3. `watch.js` compares the two runs. If anything is failing or has just recovered, it posts **one** Discord message. The message lists each `NEW FAIL`, each check `still failing`, and each check `recovered`, with the game, the profile and what failed. It links to the run and attaches up to 4 failure screenshots. A broken game is therefore reported once a day until it is fixed, and once more when it recovers.

The webhook comes from the repository secret `DISCORD_WEBHOOK_URL`:

- **Secret not set:** nothing is posted and the message is printed to the log. A healthy run is still green. A run with failures is red either way, because **any failing check fails the job**. The red run is the fallback alert.
- **Watcher cannot run** (registry down, browser fails to start): it posts "arcade-watch could not run" and exits 2.

Every run writes a table to the job summary (`$GITHUB_STEP_SUMMARY`) with each game, its type, and its desktop and iPhone results. It uploads the `screenshots` artifact: the last screenshot of every check, plus `results.json`.

## Adding a game

1. Deploy it to the arcade so it appears in `/api/games`. A link-out game goes on the portal instead.
2. Add its slug to `games` in `games.json` with a check type and any options:

   ```json
   "my-game": { "type": "tak-console", "line": "HELLO" }
   ```

   A link-out game goes under `linkouts` and needs a `title` and `url` as well.
3. Run it locally against the live site:

   ```sh
   npm ci && npx playwright install chromium
   node watch.js --only my-game            # both profiles
   node watch.js --only my-game --profiles iphone
   ```

   Results, screenshots and `summary.md` are written to `./out`. `npm test` checks `games.json` against the check types in `watch.js` without a browser or network; it is the check that runs on every pull request.
4. If none of the check types fits, add a function to `CHECKS` in `watch.js`. It receives `(page, game, ctx)` and throws (via `fail("what went wrong")`) on failure. Use `tap(ctx, locator)` so the iPhone profile taps instead of clicking.

Options by type: `timeoutMs`, `ignore` and `fatal` (any type); `line` (tak-console, cheerpj); `input`, `expect` and `terminal` (cheerpj); `path`, `canvas`, `keys`, `holdMs`, `clickCanvas`, `readySelector`, `errorSelector`, `settleMs` and `shotTimeoutMs` (emscripten/canvas; how long one canvas screenshot may wait for a frame, default 15000, raise it for a game whose software-WebGL frames take seconds in CI); `expect` (page).

A run can also be started by hand from the Actions tab (**Run workflow**), optionally limited to some slugs. A limited run does not record state.

## Licence

[Stephenson-NC](LICENSE).
