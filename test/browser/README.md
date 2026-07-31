# Browser assertions for the dashboard

Run them:

```bash
./test/browser/run.sh                # all three suites
./test/browser/run.sh verify.mjs     # one suite
CHROME_PATH=/path/to/chrome ./test/browser/run.sh
```

Everything is disposable — a scratch database, a core-api on port 8101, a headless
Chrome with a throwaway profile — so this is safe to run while the dev and prod
stacks are up. The runner drops the database and kills the API on exit, including
after a failed assertion.

## Why a real browser, when there is already a jsdom suite

`test/unit/dashboardModules.test.ts` runs the two ES-module views under jsdom, and
that is the right tool for *logic*. It cannot see anything about **visibility**,
because jsdom does not implement cascade origin precedence: it reports
`display: none` for a `hidden` element that Chrome, Firefox and Safari all still
paint.

That is not a theoretical gap. These suites caught five defects that jsdom passed:

| Defect | Why jsdom missed it |
| --- | --- |
| The login layer stayed visible after signing in | Author-origin `.login { display: grid }` beats the UA sheet's `[hidden] { display: none }`. jsdom has no origin precedence, so the element read as hidden. |
| `.pill` painted an empty pill before stats arrived | Same cascade bug, same blind spot. |
| The sidebar stole keyboard focus every 10s | `nav.replaceChildren()` drops focus to `body`. Needs a real focus model and a real timer. |
| `#/overview` was not the canonical hash | Needs real `history` and `hashchange` behaviour. |
| A `row` shadowing bug rendered the whole untracked detail as dashes | Only visible in what was actually painted. |

The fix for the first two is the `[hidden] { display: none !important }` reset in
`style.css`. It looks like a sledgehammer; it is there because the specific,
correct-looking alternative silently does nothing in every real browser.

So: **jsdom for behaviour, this for what the operator can see.** A change to
`style.css` that only jsdom has vetted has not been vetted.

## Layout

| File | What it is |
| --- | --- |
| `cdp.mjs` | Dependency-free Chrome DevTools Protocol driver, ~230 lines. Launches headless Chrome and talks to it over a WebSocket using Node's built-in client — no puppeteer, no playwright, nothing to keep up to date. |
| `seed.mjs` | Fills the scratch database with enough to render every view. |
| `seed-accounts.mjs` | Sets the owner password and creates a contributor, over HTTP — the API hashes passwords, so a direct column write would store something no login can match. |
| `verify.mjs` | The main suite: login, routing, every sidebar destination, tabs, focus. |
| `verify-untracked.mjs` | The untracked queue and its detail/edit view. |
| `verify-modules.mjs` | The two dynamically-imported destinations, Maintenance and Docs. |
| `verify-features.mjs` | Worker→extension assignment, queue management, the tracked catalogue column and repoint, and the typed config editor. |

## Not covered

`verify-modules.mjs` asserts that Maintenance and Docs **render**, not that their
buttons work. GitHub sync, service restart and extension install all mutate the
platform, so they are deliberately not fired here — exercise those against the dev
stack by hand, or against `test/integration/sysops.test.ts`, which drives the
endpoints behind them.

These suites are not wired into `vitest run`: they need Chrome and a free port,
which is a heavier contract than the rest of the suite assumes. Run them before
shipping anything that touches `app.js`, `style.css` or `index.html`.
