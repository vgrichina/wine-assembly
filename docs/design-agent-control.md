# Agent control channel: live event streams into a running session

Status: phases 1 and 2 IMPLEMENTED, plus **frozen (agent-stepped) mode** and
the **multi-session dashboard** — see those two sections below; the phase-2
`pause`/`run N` line item is what frozen mode became, for the browser (run.js `--control`/`--control-stdin` +
`tools/ctl.js` + dev-server hub + `lib/agent-remote.js` + dev-server
auto-inject, tests `test/test-control-cli.js` and
`test/test-web-agent-remote.js`); phase 3 (subscribe streams, pause/step,
record/replay) remains design. The browser connect path is zero-paste for
pages the dev-server serves: it injects the connect script itself, so the
user hands the agent the tab URL and `ctl.js -s <that URL>` resolves it to
the session. The `?agent` hook in `index.html` is thereby unnecessary for
served pages and stays deferred (the file is held by another lane); pages
served elsewhere still connect by the pasted `import(...).connect()` line
printed at dev-server startup.

## The problem

Every way we drive an emulator session today is decided **before the run starts**.
`--input=BATCH:ACTION:ARGS` is a schedule written at launch time against batch
numbers we have to guess; when the guess is wrong the run "fakes a BLANK"
(dropdown sweep), or the level timer expires before the click lands (Chip's
Challenge), or `--stuck-after` ends the run and silently drops every later
event. There is no way to *look first, then act* — which is exactly the loop an
agent (or a person at a shell) needs: screenshot → decide → click → screenshot.

The browser has the opposite problem. A live page — the local dev-server page,
the deployed berrry.app build, Safari on a real phone — has a running session
an agent cannot reach at all. `tools/ios-eval.js` proved the shape of the
answer (the page polls the server for work, evaluates it, posts the result
back), but it only exists for the ios-lab pages, not the emulator.

This design gives both hosts the same live control channel:

1. **CLI VM** — `test/run.js --control` accepts a continuous stream of events
   while the guest runs, and answers observation requests (PNG, state).
2. **Browser** — any live page connects to the dev-server with one pasted
   line (or a `?agent` URL param), after which the same commands drive it.

One command vocabulary, one client tool, two transports.

## What already exists (and is reused, not duplicated)

| Piece | Where | Role here |
|---|---|---|
| `--input` action vocabulary (`click`, `keydown`, `drag`, `dlg-cmd`, `dump-mem`, `png`, …) | `test/run.js` ~line 966-1350 | The command set. Control commands are the same actions **without the batch prefix** — they fire at the next batch. |
| Scheduled-input drain point | top of the batch loop, `test/run.js` ~4793 | Live commands drain at the same point, through the same per-action code. |
| Event-loop yield inside the batch loop | the vlan-wire pattern, `test/run.js:7759` — `if ((batch & 0x3F) === 0) await setImmediate` | **Load-bearing constraint:** the batch loop is otherwise synchronous and socket callbacks never fire (same reason SIGTERM never lands). `--control` turns this periodic yield on unconditionally. |
| Long-poll eval channel | `tools/ios-selftest-server.js:131-191` + `tools/ios-eval.js` | The browser transport, generalized: page polls `GET`, executes, `POST`s results; the asking HTTP request is held open so the shell prints the answer. |
| `/api/*` routes, CORS-open POST, NDJSON append | `tools/dev-server.js` | The hub lives here as `/api/agent/*`. |
| Inert-without-param page module | `lib/phone-diag.js` (`?diag`) | The pattern for `lib/agent-remote.js` (`?agent`). |
| `--input=B:wait-go` + parent `{t:'go'}` IPC | `test/run.js:282` | Prior art for "hold until told"; superseded by this for interactive use. |

## Protocol

One JSON command shape on both transports:

```json
{ "id": 7, "action": "click", "args": { "x": 120, "y": 88 } }
{ "id": 8, "action": "png" }
{ "id": 9, "action": "eval", "args": { "code": "renderer.windows.length" } }
```

Each command gets exactly one reply: `{ "id": 7, "ok": true, "value": ... }`
(`value` is a base64 data URL for `png`, JSON for everything else; `ok:false`
carries the thrown message). A POST may carry an **array** of commands — that
is the "continuous stream" case (e.g. a mousemove trail for a drag) — and the
replies come back as an array in the same order.

### Command set

Phase 1 (the minimum that closes the agent loop):

- **Input:** `click`, `dblclick`, `mousedown`, `mouseup`, `mousemove`,
  `keydown`, `keyup`, `keypress`, `drag`, `dlg-cmd`, `dlg-click` — same
  names and argument meanings as the `--input` actions, so everything already
  known about them (e.g. *mousedown, gap, mouseup* for per-frame button
  samplers; keydown vs keypress for dialogs) transfers verbatim.
- **`type`** — a string, expanded by ctl.js into the full
  keydown/keypress/keyup triple per character, because every agent otherwise
  re-implements it badly. The triple is load-bearing: dialogs act on
  WM_KEYDOWN while edits take the WM_CHAR that comes from keypress, so
  keypress alone types into Notepad but leaves winmine's high-score name box
  untouched.
- **`launch` / `apps`** — browser sessions only: `apps` lists the app
  registry ids and `{action:'launch', app:'sol'}` selects and launches one
  through the shell's own `launchApp()` path (the same code the Launch
  button runs). A CLI VM chose its app at start; ctl.js says so instead of
  sending it.
- **Observation:** `png` — screen capture. The CLI VM shares a filesystem
  with the agent, so run.js **writes the file itself** through the existing
  `png:PATH` input action and the reply's log line names the path and size —
  no image bytes cross the wire. The browser cannot touch the agent's disk,
  so there the page replies with `canvas.toDataURL` base64 and `ctl.js`
  writes the file; same `ctl.js png out.png` UX either way.
  `snapshot` (structured: batch/step
  count, eip, window list with class/title/rect/visibility, focus hwnd, last
  MessageBox text, quit flag), `dump-mem` (existing action, now on demand).
- **`eval`** — the escape hatch that keeps the command set small. Browser:
  page-context eval (reaches `window.wineShell`, `WinePerf`, the canvas).
  CLI: evaluated with `instance.exports`, `renderer`, `mem`, `g2w` in scope.
- **`ping`** — session liveness + identity.
- **`user-input on|off`** — browser sessions only; see *Sharing input with the
  user* below.

### Sharing input with the user

A browser session has a person sitting in front of it, and their hands do not
stop when an agent starts driving: the mousemove of a hand resting on the desk
edge-scrolled Heroes II's map out from under the agent's path clicks, and every
click landed somewhere else than it was aimed. So the page takes input
exclusively while an agent drives it.

What engages it is the **first input command the agent actually sends** (any
`click`/`key`/`mouse`/`wheel` entry through `execEntry`), never the connect —
the dev-server auto-connects every page it serves and people play on those
normally most of the time. Once engaged, `lib/agent-remote.js`'s window-capture
guard drops trusted mouse, wheel and touch events aimed at the `#screen`
canvas, and `window.__agentInputExclusive` makes `shouldIgnorePageKey()` in
`lib/browser-input.js` drop trusted keys (its listeners are registered at page
load and cannot be out-captured, so keys are cooperative rather than blocked).
The agent's own synthesized events carry `isTrusted=false` and pass; the
`?debug` toolbar is never in the guarded target chain, so its controls stay
clickable.

The **`Agent owns input`** checkbox in the `?debug` toolbar shows and steers
that state. Unchecking it takes the session back *for good* — auto-engage is
retired for the rest of the session, so the next agent click will not silently
take it again. The agent's side of the same switch is
`node tools/ctl.js -s SESSION user-input on` (hand it back) / `off` (take it);
like `launch`, it refuses a direct CLI target with exit 2, since a headless VM
has no user at its canvas.

- **`frozen on|off` / `step N [MS]`** — browser sessions only; see *Frozen
  (agent-stepped) mode* below.

Phase 2:

- **`subscribe`** — `{ classes: ["messagebox", "api", "frame"] }`: the session
  pushes matching events to the hub, which appends NDJSON the agent tails
  (same convention as `--perf-log`). Pull (`png`/`snapshot`) is enough to
  close the loop; push is for *watching* — "tell me when a MessageBox
  appears" without polling screenshots.
- **`pause` / `resume` / `run N`** — batch-level stepping for the CLI VM.
- **Record/replay** — the browser side already routes real user input through
  `lib/renderer-input.js`; recording it as an NDJSON command stream and
  replaying it into `--control` (or compiling it down to a `--input=` schedule)
  turns a manual browser session into a headless regression test. This is the
  payoff for keeping the two hosts on one vocabulary; design it, don't build
  it yet.

## Frozen (agent-stepped) mode — IMPLEMENTED

A live browser session is a *running machine*, and that is a bad thing to
photograph. Between the `png` an agent looks at and the `click` it decides on,
the guest has run tens of thousands of slices: the menu it aimed at animated
away, the dialog closed itself, the timer fired. The headless CLI never had
this problem, because there the agent owns the schedule — nothing happens
between batches unless a batch is asked for. Frozen mode gives the browser the
same property.

**What it is:** while frozen, `host.js`'s drive loop schedules *nothing*. No
slice runs, no frame is presented, and the guest clock does not move. The
picture on the canvas cannot change, so `png` is byte-identical between
commands. Work happens only when the agent asks for a specific amount of it.

**How to turn it on**, three ways, all the same switch (`window.WineFrozen`):

| Where | How |
|---|---|
| URL | `?frozen` — the page is frozen from its first instruction, so `?app=sol&frozen` never even boots until stepped. `?frozen=MS` also sets the tick. |
| `?debug` toolbar | the **Frozen** checkbox, plus a **Step** button (shift-click = 100) and a `FROZEN  step N  guest T` badge |
| agent | `node tools/ctl.js -s ID frozen on` / `off` |

**The loop it exists for:**

```bash
node tools/ctl.js -s ID frozen on
node tools/ctl.js -s ID step 2000          # boot far enough to see something
node tools/ctl.js -s ID png /tmp/a.png     # look — and it will still look like this
node tools/ctl.js -s ID click 231,110      # act (queued, exactly as today)
node tools/ctl.js -s ID step 200           # the guest consumes the click here
node tools/ctl.js -s ID png /tmp/b.png     # look again
node tools/png-diff.js /tmp/a.png /tmp/b.png
```

`click` + `step` is the atomic unit of play. A `POST` carrying the array
`[{cmd:"click:231:110"},{action:"step",n:200},{action:"png"}]` executes the
three in order in one round trip, because `lib/agent-remote.js` awaits each
command before starting the next.

**What a step is.** One step = one iteration of the page's run loop — the same
unit `stepsPerSlice` sizes (100,000 x86 steps by default in the browser, less
under some renderer policies). It is deliberately *not* the CLI's batch: the
two hosts size their slices differently and always have. `step N` returns
`{frozen, ran, steps, ticks, guestMs, tickMs, eip}` so the reply says what
actually happened rather than what was asked for.

**The clock is the part that had to be got right.** `_guestTickMs` derives
guest time from the wall (`now - wallStartMs`). A wall clock that keeps running
while nothing executes is worse than a stopped one: every `WM_TIMER` the app
owns is instantly overdue when it resumes, and a `timeGetTime`-paced animation
sees one enormous delta per step — the exact failure mode
`docs/frame-pacing-census.md` describes from the other direction. So a frozen
host stops reading the wall and charges **`tickMs` of guest time per executed
step** (default 16, `step N MS` or `?frozen=MS` changes it). That is the
browser's answer to `--tick-ms-per-batch`, and the same tuning judgement
applies: an app that paces off `WM_TIMER` wants a small tick, an app you are
trying to fast-forward wants a large one. `lib/batch-clock.js` is the CLI's
implementation of the same idea over a different unit; the two are deliberately
separate objects, and nothing but the idea is shared.

Unfreezing slides `wallStartMs` forward by the interval the guest did not
experience, so the guest never sees a jump — the trick `_resumeFromHidden`
already used for a backgrounded tab.

**Implementation** is one seam. Both drive loops (cooperative and
worker-backed) reach their next slice through `WineAssembly._scheduleStep`, so
frozen mode holds the continuation there instead of posting it, and
`stepFrozen(n)` hands it back exactly `n` times. Consequences worth knowing:

- Freezing takes effect at the end of the slice already in flight; a slice
  merely *sleeping* (the parked-guest case, i.e. most of an idle app) is
  claimed immediately rather than being allowed to land up to 50ms later.
- The hidden-tab pause is skipped while frozen: a frozen guest already costs
  nothing, and pausing would swallow the continuation the next `step` needs.
  This is what lets dashboard tiles be stepped while their tab is not on top.
- A `step` reply is held open by the hub for up to ten minutes rather than the
  usual twenty seconds, because the caller chose the duration. The page-side
  watchdog is on *progress*, not wall time: a step request gives up only if the
  step count stops moving for five seconds.
- `_stepTicks` (in every status reply as `ticks`) counts steps retired in
  **both** modes and is the honest "is anything running at all" counter.
  `_runSliceCount` is not one — it is bumped only on the branch where the
  guest's main thread was runnable, so an app idling in `GetMessage` retires
  slices forever without moving it. Neither is the guest clock: a parked app
  may not call `GetTickCount` for seconds at a time. Both of those were tried
  first and both quietly reported "nothing is running" about a healthy session.

**Live mode is untouched** when nothing turns this on: `_scheduleStep` gains
one counter increment and one boolean test.

## The dashboard: many sessions at once — IMPLEMENTED

`GET /dashboard` (dev-server, `dashboard.html`) is the human half of all this:
one tile per emulator, each showing its live canvas, its app, its hub session
id and its frozen state. It is for *watching* — the agents drive through
`ctl.js`, and the only control on a tile beyond freeze/close is **copy ctl**,
which puts that tile's own `node tools/ctl.js -s <id> …` line on the clipboard.

```
http://127.0.0.1:8080/dashboard                          empty grid, add tiles by hand
http://127.0.0.1:8080/dashboard?apps=sol,winmine         two tiles, live
http://127.0.0.1:8080/dashboard?apps=sol,winmine&frozen  the same two, agent-stepped
```

**Every tile is an ordinary emulator page in an iframe** — same `index.html`,
same boot, its own `WineAssembly` and its own 512MB memory. That is the design
decision, and it is deliberate rather than lazy: the page is singleton-shaped
in ways that would each have to be undone to host two guests in one document —
one `<canvas id="screen">`, one `window.sharedRenderer`, one set of
window-level key listeners in `lib/browser-input.js`, one
`document.fullscreenElement`, one desktop-icon grid. An iframe gives all of
that per tile for free.

It also means **no new protocol at all**. The dev-server injects the agent
auto-connect into every `index.html` it serves, so each tile registers its own
hub session and answers `ctl.js -s <id>` exactly like a full-page session; the
dashboard is a viewport, not a router, and nothing is proxied through it. A
frame-push route was considered and dropped for the same reason: the tiles
*are* the frames.

Two small supports were added for it, both useful on their own:

- **`?app=ID`** in `index.html` launches straight into one app. It goes to the
  shell's registry directly rather than through the `<select>`, because that
  dropdown is filtered down to the desktop set outside `?debug` and a valid
  registry id that simply is not in it should still launch.
- **`?tile=N`** only exists to make each tile's href unique, so that two tiles
  of the same app stay distinguishable to `ctl.js -s <page URL>`, which
  resolves a session by the link the browser shows.

The tile labels are refreshed by one 500ms `setInterval` that reads
`contentWindow.__agentRemote.session` and `contentWindow.WineFrozen.status()`
across the same-origin boundary — it touches no guest, and a frozen tile
changes nothing on its own, so it is the only thing on the page that ticks.
Chrome throttles that timer to nothing in a background tab, which is correct
behaviour for an observer page and is why `test/test-web-agent-frozen.js`
brings the dashboard to the front before reading it.

## Transports

### CLI VM: a control server inside run.js

`node test/run.js --app=sol --control[=PORT]` (default 8123, bind 127.0.0.1):

- A tiny HTTP server (no deps, same style as ios-selftest-server) with:
  - `POST /ctl` — command or command array; the response is held open until
    the command(s) have executed in a batch, so `curl` prints the answer
    (the ios-eval held-response trick). This is the only command route —
    `png` writes its file server-side (same box), so no bytes endpoint
    is needed.
  - `GET /snapshot` — the snapshot JSON, as a curl convenience.
- Received commands land in a `liveInput` queue drained at the top of the
  batch loop, immediately after the `scheduledInput` drain, through the same
  action dispatch (one implementation of `click` etc., not two).
- `--control` forces the periodic `await setImmediate` yield (the
  `(batch & 0x3F) === 0` vlan pattern) so the server's callbacks can fire
  mid-run, and sets `MAX_BATCHES` to unbounded until a `quit` command or
  signal — the schedule is now external, so a batch budget makes no sense.
  `timeout -s KILL` on the *agent's own* commands remains the outer bound.
- `--input=` still works alongside it (scheduled preamble + live control) and
  auto-WM_CLOSE stays disabled exactly as it is for `--input`.
- **`--control-stdin`** — the same command set over stdin, one command per
  line (a JSON object/array or a bare `--input` entry string like
  `keypress:65`); each reply prints on stdout as one `[ctl] {"ok":...}` line.
  For piping a generated stream or driving run.js from a parent process;
  composes with `--control` (both may be on). stdin EOF does *not* end the
  run — `quit` (or the outer timeout) does. Not compatible with the
  interactive debug prompt, which owns stdin. An interactive agent is better
  served by HTTP, where each reply pairs with its own request.

Why a direct server and not "run.js polls the dev-server too": the headless
case is the agent's bread and butter and must not require a second process.
`run.js --control` + `curl` is self-contained. The hub exists only because a
browser page cannot listen.

### Browser: the dev-server as hub

The page cannot accept connections, so it polls — the proven ios-eval shape,
promoted from lab-only to the emulator page and made session-aware:

- **`lib/agent-remote.js`** — inert unless loaded. On start: registers a
  session (`POST /api/agent/hello` → `{sessionId}`; payload names the app id,
  user agent, page URL), then loops `GET /api/agent/poll?s=ID` (long-poll:
  the server holds the GET open ~25s or until a command arrives — *not* the
  ios-lab fast-poll, which burns phone battery), executes each command, and
  `POST /api/agent/result`. Input commands are executed by **synthesizing
  real DOM events on the screen canvas** (PointerEvent/KeyboardEvent with the
  right coordinates), so they exercise `lib/renderer-input.js` routing
  identically to a human — the same reason `--trace-input` exists. `eval`
  runs in page context. `png` is `canvas.toDataURL('image/png')`.
- **The hub explains itself:** `GET /api/agent` (the bare root) returns the
  whole protocol as plain text — ctl.js quick start, raw routes, command
  shapes — readable without a token. The in-page handoff therefore carries
  only the ctl.js line plus `curl <hub>/api/agent`; instructions live on the
  server, not in the copied snippet (the nomcp pattern).
- **dev-server routes** (`/api/agent/*`): `hello`, `poll` (long-poll per
  session), `result` (routes the reply back to the held client request),
  `sessions` (list live sessions: id, kind, app, age, last-seen), and the
  client-facing `POST /api/agent/ctl?s=ID` which enqueues for that session
  and holds the response until `result` arrives (20s timeout with a "is the
  page still open?" message, like ios-eval). CORS-open like `/api/perf`,
  because the page being driven is often served from elsewhere.

### Connecting a page — copy the link

Three ways in, cheapest first:

1. **The page is served by the dev-server (the normal case):** nothing. The
   server appends a `<script type=module>` auto-connect to `index.html` as it
   serves it (localhost binds only; `--no-agent-inject` turns it off), so the
   session is on the hub the moment the page loads. The user's whole handoff
   is the tab URL: `node tools/ctl.js -s 'http://127.0.0.1:8080/?debug' png
   out.png` resolves the link against the hub's session list (sessions record
   their `href`; match order exact href → origin+pathname → only-session;
   ambiguity lists ids and exits 2). This is also the phone path — Safari
   loading the served page connects itself, no console needed. Injection is
   never enabled on a wider bind, because the page would need the agent token
   and serving the token to every viewer is serving control of every session.
2. **Any other page (deployed berrry.app, someone else's tab):** paste one
   line into the console:

   ```js
   import('http://127.0.0.1:8080/lib/agent-remote.js').then(m => m.connect('http://127.0.0.1:8080'))
   ```

   The logic stays in the repo file; the snippet never grows. dev-server
   already serves the repo with CORS headers, and dynamic `import()` from an
   https page to `http://127.0.0.1` is allowed in Chrome (localhost is a
   potentially-trustworthy origin). **Safari blocks that mixed request** —
   the Safari fallback is path 1 against a locally-served page, or a
   `https://` hub (see Security).
3. The same line as a bookmarklet, for repeat use.

`connect(hub)` is exported precisely so the snippet is one call; with no
argument it uses the script's own origin.

## The client: `tools/ctl.js`

`curl` can do everything, but the agent-facing verbs deserve a tool
(build-tools-not-scripts):

```
node tools/ctl.js sessions                      # list live sessions (hub + default CLI port)
node tools/ctl.js [-s ID] click 120,88
node tools/ctl.js [-s ID] type "hello world"
node tools/ctl.js [-s ID] key VK_RETURN         # keydown+keyup pair
node tools/ctl.js [-s ID] frozen on             # stop the world (browser only)
node tools/ctl.js [-s ID] step 400 [16]         # 400 steps of guest work, then stop
node tools/ctl.js [-s ID] png out.png
node tools/ctl.js [-s ID] snapshot              # JSON to stdout
node tools/ctl.js [-s ID] eval 'wineShell.apps.length'
node tools/ctl.js [-s ID] pipe < events.ndjson  # the continuous-stream case
node tools/ctl.js [-s ID] tail                  # phase 2: follow subscribed events
```

With exactly one live session, `-s` is optional. `-s` accepts a bare CLI port
(`-s :8123`), a hub session id, or a **page URL copied from the browser tab**
(`-s 'http://127.0.0.1:8080/?debug'` — the URL's origin is the hub, since the
dev-server serves the page and hosts the hub; an explicit `--hub=` wins).
Exit codes compose in a shell: 0 executed, 1 the command threw
guest/page-side, 2 transport failure — same contract as ios-eval.

The agent loop this enables, verbatim:

```bash
node tools/ctl.js png /tmp/f1.png      # look
node tools/ctl.js click 231,110        # act
node tools/ctl.js png /tmp/f2.png      # look again
node tools/png-diff.js /tmp/f1.png /tmp/f2.png   # did anything happen?
```

## Timing, clocks, and what "now" means

- **CLI:** a live command executes at the top of the next batch. Latency is
  one batch of wall time — irrelevant for an agent loop. The headless clock
  interplay does **not** go away: an app pacing on `WM_TIMER` still needs
  `--tick-ms-per-batch` chosen for it, and an agent free-running batches
  between its own commands advances guest time fast. That is usually what an
  agent wants (no waiting through fades); when it isn't, phase-2
  `pause`/`run N` is the answer, not a new clock mode.
- **Browser:** a command executes on receipt in the page's event loop, i.e.
  between run-loop steps — the same interleaving as real user input. A
  **frozen** session removes the race entirely: nothing runs between commands
  at all, and its clock advances per step rather than per millisecond. That is
  the browser's `--tick-ms-per-batch` conversation, and it is the same one.
- **Ordering:** commands within one POST array execute in order in one batch
  (CLI) / one turn (browser). Across POSTs, arrival order. No batch-number
  addressing on the live channel at all — that is `--input`'s job and the two
  compose (schedule the boot, then drive live).

## Security

Same posture as ios-selftest-server — an unauthenticated debugging server the
user starts by hand — but this one carries `eval`, so the defaults tighten:

- run.js `--control` and the dev-server bind **127.0.0.1 by default**;
  `--host=0.0.0.0` is the explicit opt-in for phone testing (the ios server
  already works this way for the repo-serving half).
- When bound beyond localhost, the dev-server prints a random token at
  startup; `?agent=TOKEN`, the pasted snippet, and `ctl.js` (env
  `WINE_AGENT_TOKEN` or `--token=`) must carry it, and `hello`/`poll`/`ctl`
  reject without it. On pure-localhost binds the token is not required, to
  keep the copy pasta short where the exposure is nil.
- The deployed berrry.app page never gets a hub URL baked in — connecting a
  deployed page is always an explicit local paste.

## Failure modes designed for up front

- **Page closed / run exited:** `poll` sessions expire after 60s without a
  poll; `ctl` against a dead session answers immediately with "session gone"
  instead of the 20s timeout. `ctl.js sessions` shows last-seen age.
- **The batch loop never yields** (guest stuck inside one batch): the control
  server goes quiet exactly like SIGTERM does today. `ctl.js` says "no answer
  in 20s — the VM may be inside a long batch" rather than hanging; the
  outer `timeout -s KILL` remains the guarantee.
- **Two agents, one session:** replies are routed by command id to the asking
  request, so interleaved clients get their own answers; no locking beyond
  that. Coordinating *intent* stays a messageboard problem.
- **Command throws guest-side:** `ok:false` + message, session stays up.
  A crash of the VM itself ends the session; the next `ctl` reports it gone.

## Implementation order

1. **`test/run.js --control`** + `tools/ctl.js` (direct mode): server, live
   queue drained beside `scheduledInput`, forced periodic yield, `png` /
   `snapshot` / `eval` / input actions. This alone retires the
   guess-the-batch-number workflow.
   Test: `test/test-control-cli.js` — spawn `run.js --app=sol --control=PORT`,
   wait for the ready line, `snapshot`, `click` a card, `png` twice,
   assert `png-diff` sees the change; bounded by `timeout -s KILL`.
2. **dev-server hub + `lib/agent-remote.js` + `?agent`**: hello/poll/result/
   ctl/sessions routes, DOM-event synthesis, `ctl.js -s` hub mode.
   Test: `test/test-web-agent-remote.js` in the existing headless-web
   harness — load `?agent` page against a dev-server, drive a click, assert
   via `eval` that the input routed.
3. **Frozen mode + dashboard** (done): `host.js` `_scheduleStep` seam and the
   `window.WineFrozen` page switch, `frozen`/`step` on the channel, the
   `?debug` checkbox and badge, `dashboard.html` + the `/dashboard` alias.
   Test: `test/test-web-agent-frozen.js` — asserts the negative (a `?frozen`
   page retires ZERO steps across a 2.5s sleep), then that `step N` runs
   exactly N and stops, that `png` is byte-identical between commands, that a
   click alone changes nothing but click+step does, that the checkbox freezes
   and unfreezes a running session, and that `/dashboard` boots two emulators
   that each answer `ping` and `png` on their own session.
4. **Streams + record/replay**: `subscribe`, NDJSON event log, `tail`,
   browser input recording. Each is independently shippable.
