# Wine-Assembly

x86 Windows 98 PE interpreter in raw WebAssembly Text (WAT). Runs real Win32 executables in the browser via a Forth-style threaded code x86 emulator.

## Build

```bash
bash tools/build.sh
```

Compiles the parts listed in `WAT_FILES` (`lib/compile-wat.js`) with the project's own pure-JS WAT compiler (`tools/build-compile-wat.js`) into `build/wine-assembly.wasm` — **`wat2wasm` is not used**. `build/combined.wat` is written from the same list for grep/`check-parens`/`func-index` and is not itself compiled.

**`WAT_FILES` is the build.** A new `src/*.wat` that isn't listed there lands in `combined.wat` and is silently absent from the shipped wasm; `tools/check-wat-manifest.js` (run first in the build) now fails on that. File numbering still controls order — `WAT_FILES` must stay in the same sorted order as the filenames.

Build gates, in order: manifest ↔ glob equality, `api_table.json` (id == index, append-only), generated dispatch table freshness, API hash table, ordinal data-string offsets, handler-table count, handler ESP epilogues.

**Important:** When adding new handler opcodes to `02-thread-table.wat`, increase `(table $handlers N funcref)` to match the total entry count (0-based index + 1).

## Run

- **Browser:** Open `index.html` (at repo root), select an app, click Launch. Live build deployed at https://wine-assembly.berrry.app via `tools/deploy-berrry.js --update`.
- **CLI:** `node test/run.js --exe=path/to/exe [options]` — headless execution with auto-build. A registered EXE gets that app's explicit file manifest; an arbitrary bare `--exe` mounts only the executable. Add repeatable/comma-separated `--vfs-include='*.dat,plugins/**/*.dll'` patterns (relative to the EXE directory) for ad-hoc companion assets, or prefer `--app=ID`. Key flags: `--verbose`, `--trace`, `--trace-api`, `--trace-gdi`, `--trace-host=fn1,fn2`, `--no-close`, `--break=0xADDR`, `--break-api=Name`, `--watch=0xADDR`, `--dump-gdi=DIR`, `--max-batches=N`, `--batch-size=N`, `--tick-ms-per-batch=N`

  **`--quiet-api` is close to free speed on any API-heavy app, so pass it unless you are reading the API log.** Every Win32 call prints an `[API]` line by default — Diablo emits 96,787 of them by its main menu and 724,015 by the time it reaches gameplay — and that write is blocking I/O on the thread the guest runs on. Measured back to back on the same 1000-batch Diablo command line: 3:53 wall / 25.1s user CPU by default against **1:17 wall / 25.1s user CPU** with the flag. Identical CPU, three times the wall clock — the whole difference is the process waiting on stdout, and on a loaded box it is the difference between a run finishing and a run being SIGKILLed at its timeout. `--trace-api` and friends are unaffected; this only suppresses the unconditional one-liner.

  **`--tick-ms-per-batch=N`** (default 200) sets how much guest time one batch is worth on the headless batch-driven clock. Reach for it whenever a game's engine steps on a `WM_TIMER` and the capture shows the clock already expired: at the default 200ms/batch Chip's Challenge burns its entire 100-second level timer in 500 batches and puts up "Ooops! Out of time!" before any `--input` lands. `--real-ticks` is not the fix — a 16-bit app runs 5000 batches in a third of a second of wall clock, so its 110ms timer fires about three times in a whole run and nothing ever moves. `--tick-ms-per-batch=5` reaches real gameplay.

  **`--batch-size` is a budget of BLOCKS, not steps, and a block is not a fixed amount of work.** `run(N)` spends one `$block_budget` per basic block, and each block gets a quantum of 1000 threaded ops — so one block can be a 3-instruction loop head or an entire folded sprite row. Measured on Diablo (`--batch-stats` + `--handler-hist`): **6.9 ops per block** in its Smacker intro against **282 ops per block** in its menu, a 41x spread inside one app. Ops per second is flat at ~7-9M across both, so the emulator is not "slower" in the menu at all — batches are simply a meaningless unit of work, and any per-batch number (batches/s, ms/batch) silently changes meaning when the guest's code shape changes. Quote ops, or quote wall time for fixed work.

  **This is also why time-paced content stalls.** The headless clock is `batch * TICK_MS_PER_BATCH`, so guest time advances per batch while *work* per batch varies 41x — and it varies the wrong way: an app sitting in a tight polling loop retires tiny blocks, so it is granted the fewest ops per guest-second exactly when it is waiting for time to pass. At the defaults that intro is being run on a machine doing ~35,000 ops per guest-second against ~100M for a real Pentium. Anything pacing itself off `timeGetTime`/`GetTickCount` — an intro video, an animated menu, a timed fade — then renders a fraction of a frame per guest second and looks *stalled*, which reads convincingly as a broken decoder. Diablo's Blizzard North logo is byte-identical for 23,000 batches for exactly this reason (`--trace-sched` has the main thread inside smackw32 working the whole time, and an API census counts 10,068 `timeGetTime` calls against 62 surface Lock/Unlock pairs) and plays straight through at `--batch-size=200000`. When a timed animation appears frozen, raise `--batch-size` before you go looking for a decoder bug.
- **CLI, by app id:** `node test/run.js --app=sol` — takes the exe, its DLLs, its data files and its command line from `lib/apps.js`, the same registry the desktop icons read, so the CLI mounts exactly what the browser mounts. `--app=` with an unknown id prints the full id list. An explicit `--exe`/`--args` overrides the registry.
- **PNG render:** `node test/run.js --exe=path/to/exe --png=output.png`
- **Bound every run with `timeout -s KILL N`, not plain `timeout N`.** `run.js`
  installs SIGTERM/SIGINT handlers so it can print hit counts and the MMX tally
  on the way out, and those handlers only run when the JS event loop gets a
  turn. A guest stuck inside one long WASM batch never yields, so the default
  SIGTERM is queued and never delivered: the run sails past its deadline (a
  `timeout 110` on a Winamp+AVS run was still alive at 14 minutes). SIGKILL is
  not deliverable to a handler and always lands.

## Tracing (reach for this BEFORE editing source to add `console.log`)

Ad-hoc `console.log` / `DBG_*` env vars rot. Use the built-in flags first; extend them when they fall short.

| Flag | What it prints |
|---|---|
| `--trace-api` (`=Name1,Name2`) | Every Win32 API call with args + return; with `=NAMES` filter, only those APIs. Args/returns are typed via `args:[{name,type[,out:true]}]` / `ret` fields in `src/api_table.json` (LPCSTR, HWND, LPMSG, flags:WS, etc.) — untyped entries fall back to an `nargs`-sized hex dump (or 6 dwords if `nargs` is unknown). Args flagged `out:true` are decoded **after** the handler runs (e.g. `LoadStringA buf=`, `GetMessageA msg=`) on a separate `out:` line. |
| `--trace-api-dedup` | Collapse N consecutive identical API trace lines into a `(xN)` summary. |
| `--trace-stack[=DEPTH\|=Name1,Name2\|=Name:DEPTH,...]` | Walk EBP frame chain on each matched API call (default depth 12). `=N` overrides default depth for all; `=Name1,Name2` limits to those APIs; `=Name:N` sets per-API depth. |
| `--trace-gdi` | Every wrapped GDI primitive: CreateBitmap, BitBlt, StretchBlt, FillRect, DrawEdge, DrawText, TextOut, Rectangle, Ellipse, Polygon, MoveTo/LineTo, Arc, SetPixel, SetTextColor, SetBkColor, SetBkMode, SelectObject, DeleteObject, DeleteDC, GetClipBox, LoadBitmap, CreateSolidBrush, GetObject, PatBlt |
| `--trace-dc` | Every `_getDrawTarget` resolution: hdc → resolved hwnd, top-level hwnd, canvas ox/oy, canvas size. Logs NO_CANVAS when resolution fails. Use when a draw call fires but nothing appears — shows which surface each DC lands on. |
| `--trace-ctrl` | Every WAT-native control paint: `[ctrl] paint hwnd=0x… Button at 254,422 75x24 vis=1`, in dispatch order, with the *screen* rect and the effective-visibility bit. **Reach for this first on "these pixels should not be there".** GDI rasterizes inside WAT now, so `--trace-gdi` sees only surface binds and cannot say who drew what; this can. Two entries for one hwnd at different origins = a control repainted after a move and nothing erased the old rect (children own no surface). `vis=0` = a paint that leaked through while the control or an ancestor was hidden — those pixels are a ghost nothing will clean up. |
| `--trace-input` | Which routing branch in `lib/renderer-input.js` consumed each mouse event: the candidate window list for a down, the child it resolved to, and every early return that dropped one (`DROPPED: outside modal …`). **Reach for this first on "the click does nothing".** A swallowed click makes no API call at all, so `--trace-api` shows a healthy message pump and nothing else, and the down and up paths gate differently — a control can accept a press and never see the release. This names the branch that ate it. |
| `--trace-reg` | Every registry op (open/query/create/set/enum/close) with key path, value name, and result ("found"/"not found"/actual data). Use to discover which keys an app probes when storage returns empty. |
| `--trace-fs` | Every VFS op: CreateFile (with decoded access/creation + handle/FAIL), GetFileAttributes, FindFirstFile, FindNextFile — each with path and hit/miss result. Use to see which files an app looks for but can't find in the VFS. |
| `--dx-surfaces` | At exit, one line per live DirectDraw surface: slot, size, bpp, pitch, caps flags, DIB address, the palette actually bound to *that* surface, and a sampled colour count. Reach for this when a DX app "renders nothing": it tells a primary that was never written (`nonZero=0`) apart from an offscreen texture that has content, and it names the slot the `--png=` capture picked. |
| `--trace-net` | Every `vln/1` frame on the virtual LAN wire, decoded: `-> SYN 10.77.0.2:49152 -> 10.77.0.1:8035`. Pair with `--vlan-ip=A.B.C.D` (this process's room address) and `--vlan-wire` (join the segment offered by the parent process over child IPC). |
| `--trace-host=fn1,fn2` | Generic wrap of any host import by name — logs raw args + return. Use when no category fits yet. Example: `--trace-host=gdi_draw_edge,wnd_set_state_ptr` |
| `--host-census[=N]` | Counts every host import and prints a top-12 histogram (plus the top single-int argument values, so `log_i32(0xca00f10f)=9599404` names the exact marker) straight to stdout every N calls, default 1M. **Reach for this first when a run hangs or the harness dies with a JavaScript OOM.** Everything else we log is buffered and drained only *between* batches, so a batch that never returns prints nothing at all no matter how much it is doing — this is the one flag that can see inside one. It wraps the final import table, after `run.js` overrides `lib/host-imports.js`'s versions with its own logging ones — unlike `--profile-host`, which needs the names up front, wraps before those overrides, and reports at exit. |
| `--trace` | Every decoded block's EIP |
| `--trace-sched[=N]` | One compact line each time the *set of thread states* changes, plus a heartbeat every N batches (default 5000). Shows main + every worker as `M:run@0xEIP  T1:sleep  T2:wait(0xHANDLE)`. Reach for this first on any "it hangs" or "it's slow" report with threads involved: a stalled system prints the same line repeatedly, a healthy one churns. Doubles as a cheap sampling profiler — `--trace-sched=50` then histogram the `M:...@0x...` addresses. |
| `--time-scale=N` | Run the guest clock N× the wall clock. Separates "the app is waiting for time to pass" from "the app is doing work": if a slow boot doesn't get faster at `--time-scale=10`, it is not timing-bound. |
| `--max-seconds=N` | Stop the batch loop after N seconds of wall clock (the timer starts at loop entry, so app load is not counted), whatever `--max-batches` says — pass a huge `--max-batches` with it. The exit line then reads `N batches in Ns (M batches/s)`, and that batch count is the throughput number. **This is the axis to benchmark on**, because cost per batch is not constant within a run: Caesar is ~0.1ms/batch through its boot and several times that once a city simulates, so a batch count picked to land near a target duration is per-app guesswork that goes stale as soon as the app gets further in the same budget. Fix the duration, compare how far each build got. |
| `--batch-stats[=FROM_BATCH]` | How many blocks each batch actually retired (p50/p90/p99, share that spent the whole budget) and a histogram of **why** each batch stopped: budget spent, EIP zero, `yield_flag`, blocking wait, debug facility. Reach for this before concluding that a region of a run is "slow per batch" — that phrasing hides two opposite causes. A low p50 with `budget spent` rare means batches keep bailing early and the host pays its per-batch cost for blocks the guest never ran; a p50 at the budget means the batches are full and the blocks themselves are expensive. On Diablo both regions came back full (mean 991 intro, 853 menu), which is what proved the 6x "slowdown" was a unit artifact and not a cliff. Pair with `--handler-hist-thread=0` to divide ops by blocks. |
| `--decode-stats[=FROM_BATCH]` | Per-batch distribution of *block decodes*, plus the guest slice's wall time beside it. Reach for this on any change to how decoded code is stored or invalidated: it is the one series that is both deterministic (identical across runs of one build, so it **is** safe to diff between builds) and pointed at the mechanism. `--frame-stats`'s load-immune `interval batches` cannot see decode cost at all — a batch is a budget of *blocks* and decoding retires none, so a batch that re-decodes a thousand blocks and one that decodes none look identical there. Read the p50, the decode-free share and the storm line, not the mean: a cache that evicts live blocks pays a steady drizzle every batch, while one-time page compilation concentrates ~95% of its work into ~5% of batches. |
| `--trace-loopmatch[=0xEIP]` | At **decode** time, dump every self-loop block the decoder emits (or just the one entered at `0xEIP`): entry, op count, and each `(handler index, operand)` — exactly the input the loop-idiom matcher in `src/07b-loop-match.wat` sees. Pipe the log through `node tools/loopmatch-decode.js <log> [--eip=] [--uniq]` to get handler names. Reach for this when asking "why did this loop not get lowered": the answer is a role the matcher does not recognize, and this shows which op it is. Pairs with `--loopmatch-stats` (self-loop/match/run/byte counts at exit). `LUT_RUN` is **on by default**; `--no-lut-superops` is its narrow A/B partner. `COPY_RUN` remains off because its broad corpus safety has not been re-established; opt in with `--copy-superops`. The legacy `--loop-superops` / `--no-loop-superops` switches control both families. All flags are applied separately to every guest-thread WASM instance. See §§14–16 of [docs/loop-idiom-superops-design.md](docs/loop-idiom-superops-design.md). |
| `--trace-seh` | SEH chain operations |
| `--trace-fpu` | Every x87 exception flag as it is raised (`[fpu] raise ZE at 0x…`), and every FCLEX/FNINIT that takes them down again. The flags are **sticky** — nothing but those two instructions clears them — so a program that reads the status word sees whatever the last few thousand instructions left there, and a "Division by zero" message can be reported an arbitrary distance from the divide that set ZE. Reach for this when an app blames the FPU: zero `[fpu]` lines means the complaint is a software check, not an x87 status read. |
| `--fault-null[=stop]` | Report every guest access no mapping covers — `[fault] unmapped guest access 0xADDR from eip=0xEIP` — instead of letting `$g2w` absorb it into `NULL_SENTINEL` (reads 0, writes go nowhere). `=stop` traps on the first one so the crash dump names the instruction. Reach for it when a symptom appears far from its cause: a pointer that got zeroed reads as plausible data for thousands of instructions before anything notices. Expect a nonzero baseline — notepad's startup alone probes ~266 unmapped addresses legitimately, so read the *addresses and EIPs*, not the count. The check lives in the `$g2w` miss path, after every translation attempt already failed, so an off-run pays nothing. Propagated to worker instances. |
| `--break=0xADDR[,...]` / `--break-api=Name[,...]` | Pause emulator at address / API call |
| `--break-once` | Don't re-arm WASM bp after first hit. Plus prints `bp_first_caller` (sticky `dbg_prev_eip` snapshot from the very first time `$eip == $bp_addr`) — recovers the true caller when the bp lands inside a tight self-loop that would otherwise overwrite `dbg_prev_eip` with the bp address itself. |
| `--trace-at=0xADDR` (`--trace-at-dump=0xADDR:LEN[,...]`) | Log regs + optional hexdump of given regions each time EIP hits addr (no stop). Add `--trace-at-watch` to diff each hexdump vs previous hit (bytes marked `*`). Multi-addr `--trace-at=A,B,C` works but forces BATCH_SIZE=1 (only useful for early-execution probes); for late-code multi-addr fan-out use `--count` instead. |
| `--count=0xADDR[,...]` (max 16) | Native WASM hit-counter per address. Reports `Hit counts:` summary at run end. Full speed (no BATCH_SIZE penalty). Address must be a basic-block entry (call-return landing, branch target, fn entry). Use this for "of N addrs, which fire and how often?" probes. |
| `module+0xVA` syntax | `--trace-at`, `--count`, `--break` accept `module+0xORIG_VA` (e.g. `d3drm+0x647c3905`) — auto-resolved to runtime VA after DLLs load using each DLL's PE-header-declared origBase. Use module name without `.dll`/`.exe`; `exe` is also valid. Eliminates manual `+ delta` arithmetic for cross-DLL probes. |
| `--watch=0xADDR` / `--watch-byte=ADDR` / `--watch-word=ADDR` (`--watch-value=0xVAL`, `--watch-log`) | Break when memory at ADDR changes. Size: dword/byte/word. `--watch-log` logs every change without stopping into debug prompt (essential for non-interactive runs). `--watch-value` filters to a specific target value. |
| `--show-cstring=0xADDR[,...]` | On every `--trace-at` hit and debug prompt, decode 1-byte-refcount + ASCII-at-+1 CString layout. Prints `[CString@ADDR] rc=N len=M "text"` — great for MFC/Borland apps where strings are packed this way. |
| `--skip=0xADDR[,...]` | Simulate `ret` when EIP hits — step past a fn |
| `--dump=0xADDR:LEN`, `--dump-seh`, `--dump-backcanvas` | Post-run memory hexdump / SEH dump / per-window back-canvas PNGs |

**Extending:** the tracing infrastructure lives in `lib/host-imports.js` under `if (trace.has('gdi'))` — it uses a `wrap(name, fn, formatter)` helper. To add a category, duplicate that block for your category and add a matching `if (TRACE_X) traceCategories.add('x')` in `test/run.js`. The generic `--trace-host=` should cover most one-off investigations without needing a new category.

## Measuring jank in the browser (`lib/perf-hud.js`)

The browser run loop is a `setTimeout(step, 0)` chain in `host.js`: each step runs a guest slice, then the worker threads, then a repaint — all on the main thread. So a dropped frame is never "rendering was slow", it is "one step held the thread too long", and the question is always *which phase*.

Turn on **FPS graph** in the `?debug` toolbar (or load `?debug&perf` to start it enabled). The overlay draws, per step, a stacked bar of `guest` / `threads` / `paint` / `other` against 16.7ms and 33ms guides, plus the rAF frame-interval line underneath. A tall bar is literally a step the browser could not interrupt; its color says who to blame.

**`GAME fps` and `page fps` are different numbers and only the first one is what "laggy" means.** The page composites at a steady 60 no matter how slowly the emulated machine runs, so a single fps readout hides the entire problem. `GAME` counts GDI surface flushes with a real dirty rect — frames the guest actually put on screen — and `M steps/s` is x86 throughput. Blobby in its menu: game 59fps at 28M steps/s. Blobby in a match: game 29fps at 10.4M steps/s, page 60fps throughout.

`throttled%` is the share of steps where the worker budget (`maxWallMs` in `host.js`) expired with work still pending. **A high number is not automatically the bug** — measured on Blobby: 100% throttled, but quadrupling the budget *lowered* guest fps from 29 to 17 and produced 240 long tasks. It means the game loop always has work, not that the scheduler is starving it. The ceiling there is interpreter throughput, so look at what costs instructions, not at the budget.

### Streaming a real session

`?debug&perf&perf-stream` posts batched samples to `tools/dev-server.js`, which prints one line per second and can append NDJSON. Use it when someone reports jank *they* experienced — a scripted run is a different session on a different machine load:

```bash
node tools/dev-server.js --perf-log=/tmp/perf.ndjson
# then open http://127.0.0.1:8080/?debug&perf&perf-stream and play
04:24:15 ssnalq game  59fps  page 60  steps 28.0M/s  step p50 2.3 p99 3.6ms  guest 3% thr 94%  throttled 0%    ▁▂▂▁▂▂
04:24:19 ssnalq game  29fps  page 60  steps 10.5M/s  step p50 14.8 p99 21.2ms  guest 0% thr 99%  throttled 100% ▅▅▅▆▆▇
```

`?perf-stream=URL` aims it elsewhere; the sink accepts cross-origin posts so the page can be served from another port.

`host.js` feeds it through `window.WinePerf.{stepBegin,mark,stepEnd}` — four `performance.now()` calls per step, and the seam is null unless the HUD is on. `window.WinePerf.snapshot()` returns the same numbers as JSON, so headless runs get real phase attribution instead of inferring it:

```bash
node tools/profile-web-frames.js --app=blobby_volley --seconds=20 --query='?debug&perf' \
  --report-eval='JSON.stringify(window.WinePerf.snapshot())'
```

**`--headful` when the number will be quoted.** Headless Chrome has no compositor surface and no display refresh to pace rAF against, so its frame intervals describe a browser nobody runs — pass `--headful` for anything presented as what the app feels like, and keep headless for pass/fail checks that only need the page to work. `--cpu-profile` is what answers "what is it spending time on" (V8 self time; resolve the `wasm-function[N]` names with `node tools/func-index.js N`), and `--guest-key=VK@atSec:holdSec` holds a guest key down *during* the sample, which is how you measure a scrolling map rather than an idle one.

**Check `uptime` before trusting any of it.** This box regularly sits at load 20-40 with several agent sessions running sweeps, and at that load the browser numbers measure the machine, not the emulator. `profile-web-frames.js` prints `loadavg` either side of every sample and flags anything above 4 for exactly this reason.

**Rule:** before adding a `console.log` to source, check that none of the above already covers it. If tracing a new primitive that isn't wrapped yet, add a `wrap(...)` entry to the `gdi` block (or the appropriate one) — that investment pays off on every future session. Source stays clean between sessions; tracing is a runtime flag, not an edit.

## Debugging a real iPhone (`tools/ios-selftest-server.js`, `tools/ios-eval.js`, `tools/ios-lab/`)

**Chrome device emulation is not iOS and cannot reproduce the phone-only bugs.** It has no
retractable toolbars, so `vh`, `svh`, `lvh` and `dvh` are all the same number there and nothing
about the scroll-to-collapse mode can be tested in it. Safari Web Inspector over USB needs the
cable and a Mac in front of the device. So the page talks back instead:

```bash
node tools/ios-selftest-server.js --log=/tmp/diag.ndjson   # serves the repo on 0.0.0.0:8099
# on the phone: http://<lan-ip>:8099/?diag=1     (the app, instrumented)
#               http://<lan-ip>:8099/tools/ios-lab/   (the lab, no emulator in it)
node tools/ios-eval.js 'innerHeight'                       # a REPL into whatever page is open
```

- `lib/phone-diag.js` is inert without `?diag`. With it, the page posts a snapshot twice a second
  and the server prints one line per *change* — verdict, plus `AUDIO` (context state, whether the
  clock is moving, analyser RMS, `navigator.audioSession.type`) and `SCROLL` (document vs viewport
  height, scrollY, touchmove count, and an `elementFromPoint` hit test on the swipe strip).
- `tools/ios-lab/` is four one-file pages with no emulator in them, each isolating one hypothesis:
  A plain document, B an invisible `200svh` spacer, C the app's exact shape (fixed full-viewport
  panel that eats touches + a swipe strip), D an inner scroller as the known-negative control.
  C's shape is query-driven (`?spacer=dvh|svh&gutter=N&right=N&autohide=0`) so one page A/Bs two
  layouts on the device without an edit. Each page names itself in the log.
- `tools/ios-eval.js` posts an expression, the page evals it and posts the answer back, and the
  server holds the HTTP response open so the shell command prints what the device said. This is
  how a candidate fix gets tried on the phone before it is written into `index.html`.
- `test/test-web-ios-lab.js` only checks the lab pages *load* — a page that throws halfway through
  its setup still shows a readout and still reports, which is worse than no reading at all.

**The unit matters and is the bug we already hit:** `dvh` is the *dynamic* viewport and tracks the
toolbars as they move, so a `dvh`-sized spacer grows mid-gesture and the scroll target runs away
from the finger. `svh` (bars visible) and `lvh` (bars retracted) are constants. Size overflow in
`svh`; test "are the bars down?" as `innerHeight >= 100lvh - 8`.

## Source Parts (concatenation order)

| File | Purpose |
|------|---------|
| `01-header.wat` | Module declaration, host imports, memory layout, CPU state globals |
| `01b-api-hashes.generated.wat` | **Generated** — FNV-1a hash table for Win32 API name→ID lookup |
| `02-thread-table.wat` | Threaded code function table (opcode → handler mapping) |
| `03-registers.wat` | Register access helpers, lazy flag system (flag_op/flag_res/flag_a/flag_b) |
| `04-cache.wat` | Block cache (decoded x86 → threaded code) |
| `05-alu.wat` | ALU operations (32/16/8-bit), shifts, bit ops, MUL/DIV, SETcc |
| `05b-string-ops.wat` | String operations (movsb/movsd/stosb/stosd/cmps/scas + REP) |
| `06-fpu.wat` | x87 FPU |
| `06b-core-handlers.wat` | Non-FPU threaded handlers: flag ops, LEAVE/BSWAP/XCHG/IMUL, 16-bit ALU/MOV, and every memory-form (`_ro`) handler |
| `07-decoder.wat` | x86 instruction decoder → threaded code emitter |
| `07b-loop-match.wat` | Loop-idiom matcher (Design A): classifies the ops a self-loop block just emitted and, when a pattern holds, replaces the whole body with one super-op |
| `08-pe-loader.wat` | PE executable loader, import table processing |
| `08b-dll-loader.wat` | DLL loader with relocations, export resolution |
| `09a-handlers.wat` | Win32 API handler functions (core: process, memory, encoding, window props) |
| `09a2-handlers-console.wat` | Console API handlers (screen buffer, cursor, read/write) |
| `09a3-handlers-audio.wat` | Audio/wave API handlers (waveOut*, mmio*, mci) |
| `09a4-handlers-gdi.wat` | GDI API handlers (SelectObject, pens, brushes, BitBlt, text) |
| `09a5-handlers-window.wat` | Window creation & message dispatch (CreateWindowExA, GetMessage, etc.) |
| `09a6-handlers-crt.wat` | C runtime/string handlers (strlen, strcmp, _mbschr, etc.) |
| `09a7-handlers-dispatch.wat` | Late-added misc handlers (shell, version, file, key/prop, atoms, setupapi) |
| `09a7b-ole.wat` | OLE/COM: ROT, monikers, bind contexts, IFont, structured storage, IDataObject/clipboard, IOleObject/IOleCache/IViewObject |
| `09a7c-mixer.wat` | WINMM mixer handlers (mixerOpen/GetLineInfo/GetControlDetails and A/W pairs) |
| `09d-winsock.wat` | Virtual LAN Winsock core — socket table, in-process switch, and the `vln/1` frame wire that joins two emulator processes into one room |
| `09b-dispatch.wat` | Manual dispatch helpers |
| `09b2-dispatch-table.generated.wat` | **Generated** — br_table dispatch calling handler functions |
| `09c-help.wat` | WAT-native help system |
| `09c0-window-table.wat` | WND_RECORDS + accessors, per-slot parallel tables, GWL/cbWndExtra, dialog state, class table, `$wat_wndproc_dispatch`, focus |
| `10-helpers.wat` | String/memory helpers, heap allocator, resource walker, window/paint/clipboard helpers |
| `10d-gdi-region-path.wat` | GDI regions (allocator + polygon scan-converter), path engine (record/flatten/widen/stroke), DC clipping, object allocator |
| `10e-gdi-metafile.wat` | GDI palettes, WMF/EMF recorder and player, bitmap objects |
| `10f-gdi-dc.wat` | GDI device-context state: save/restore, selected objects, surface descriptors, text metrics, the `$host_gdi_*` entry points |
| `10g-gdi-raster.wat` | GDI software rasterizer: span fill, clip bands, brush sampling, shape primitives, region combine |
| `11-seh.wat` | Win32 Structured Exception Handling |
| `12-wsprintf.wat` | wsprintf/sprintf implementation |
| `13-exports.wat` | WASM exports (run, get_eip, register accessors, etc.) |

## JS Libraries (`lib/`)

| File | Purpose |
|------|---------|
| `mem-utils.js` | Shared memory utilities (readStrA, readStrW, g2w) |
| `host-imports.js` | Shared WASM host imports (GDI, file I/O, registry, help system) |
| `renderer.js` | Win98 canvas renderer (windows, controls, menus, dialogs, drawing) |
| `renderer-input.js` | Renderer input handling (mouse, keyboard, menu interaction) |
| `dib.js` | DIB → RGBA decoder (1/4/8/24/32 bpp + RLE4/RLE8); used by both guest BITMAP rendering and host icon extraction |
| `resources-icon.js` | Browser-side PE walker that extracts the desktop icon from each app's exe at page load (RT_GROUP_ICON → RT_ICON → DIB → data URL) |
| `dll-loader.js` | DLL loading, relocation, import patching |
| `hlp-parser.js` | Windows HLP file parser (B+tree, Hall phrase decompression) |
| `thread-manager.js` | Multi-thread support via separate WASM instances |
| `storage.js` | localStorage-backed registry and INI file persistence |
| `filesystem.js` | Virtual filesystem for file operations |
| `vfs-host-files.js` | Expands explicit CLI `--vfs-include` globs within their bounded host roots |
| `vlan-wire.js` | Virtual LAN transport: loopback segment (instances in one process) and process wire (emulators in separate OS processes over child IPC). Carries opaque frames only — all routing lives in WAT |
| `compile-wat.js` | Browser-side WAT → WASM compiler (wraps wabt.js) |

### Rendering surfaces

One offscreen **back-canvas** per top-level hwnd (sized to full window), allocated lazily by `renderer.getWindowCanvas`. All guest GDI and all WAT-dispatched child WM_PAINT draws land here via `_getDrawTarget` in `host-imports.js`. `repaint()` blits each back-canvas to the screen in z-order — the screen canvas is a composite target, not a drawing target.

Child controls painted via `_drawWatChildren` use `_activeChildDraw = { canvas, ctx, ox, oy, hwnd }` to short-circuit DC resolution. `ox/oy` are **window-local** (back-canvas coords, not screen coords) so children composite coherently with the guest's own paint output.

Don't add a second drawing surface. If a GDI call needs to hit the screen, route it through the parent window's back-canvas with the right offset.

## Memory Layout

128 MB flat WASM linear memory. Guest memory starts at WASM offset `0x12000` (GUEST_BASE). The PE is loaded at its preferred `image_base` (typically `0x400000`) which maps to `GUEST_BASE + (image_base - image_base)` via `g2w` (guest-to-WASM address translation): `g2w(guest) = guest - image_base + GUEST_BASE`.

Key regions:
- `0x00000100` — String constants (win.ini path, help strings, exe name buffer)
- `0x00004000` — API hash table (12KB, API_HASH_TABLE)
- `0x00007000` — WND_RECORDS, CONTROL_TABLE, CONTROL_GEOM, CLASS_RECORDS, TIMER_TABLE, PAINT_SCRATCH, SCROLL_TABLE, FLASH_TABLE, WND_DLG_RECORDS (all below GUEST_BASE, end at 0xF000)
- `0x00012000` — Guest memory (GUEST_BASE, maps guest addresses)
- `0x03C12000` — Guest stack (1MB, grows down)
- `0x03D12000` — Heap region (1MB)
- `0x03E12000` — API thunk zone (256KB, THUNK_BASE)
- `0x03E52000` — Threaded code cache (4MB, THREAD_BASE)
- `0x04252000` — Block cache index (64KB, CACHE_INDEX)
- `0x04262000` — PE staging buffer (2MB, PE_STAGING)
- `0x04462000` — DLL table (512B)
- `0x07FF0000` — DX_OBJECTS / COM_WRAPPERS (high memory, outside g2w bounds)

See [docs/memory-map.md](docs/memory-map.md) for the full annotated layout, comparison with Windows 98 kernel/user memory model, and analysis of what's emulator-private vs guest-accessible.

## Message / Event Handling

GetMessageA in `09a5-handlers-window.wat` delivers messages in a priority-based phased sequence:

1. **WM_QUIT** — if `$quit_flag` is set
2. **Pending child WM_CREATE** — queued during CreateWindowExA for child controls
3. **Pending child WM_SIZE** — follows child WM_CREATE
4. **Post queue** (`$post_queue_count`, memory at 0x400) — drained FIFO, 64-slot ring of {hwnd, msg, wParam, lParam} 16-byte entries. PostMessageA and TranslateAcceleratorA write here.
5. **Pending main WM_SIZE** (`$pending_wm_size`) — set by CreateWindowExA, consumed after post queue drain
6. **Startup phases** — sequential one-shot messages: WM_ACTIVATEAPP → WM_ACTIVATE → WM_SETFOCUS → WM_ERASEBKGND
7. **Host input poll** — `$host_check_input()` returns packed `(wParam<<16)|(msg&0xFFFF)`, with hwnd/lParam via separate imports
8. **WM_PAINT** — if `$paint_pending` is set for main window
9. **Paint queue** — per-child-hwnd paint queue (`$paint_queue_pop`)
10. **Timers** — `$timer_table` walk, delivers WM_TIMER
11. **WM_NULL** (idle) — returned when nothing is pending

**ShowWindow** delivers WM_SIZE synchronously by redirecting EIP to the wndproc (not via the message queue). This happens inside `$handle_ShowWindow` when the target is `$main_hwnd` and `$pending_wm_size` is non-zero.

**SendMessageA** (`$handle_SendMessageA`) dispatches synchronously: pushes wndproc args on the guest stack, sets EIP to the target wndproc, and uses a CACA0005 continuation thunk to resume the caller when the wndproc returns.

**UpdateWindow** finishes the paint before it returns, via `$wnd_send_message` (WM_ERASEBKGND from the NC_FLAGS bit, then WM_PAINT) — real `UpdateWindow` does not return until the app has painted, and anything the app draws on the next line otherwise gets covered by its own deferred background erase (Taipei's splash screen). Scoped to a visible top-level window with a real x86 wndproc (`< 0xFFFE0000`), `ctrl_class == 0`, not `$code16`, and `$sync_msg_depth == 0`; everything else still queues for the pump.

**Input injection (test harness):** `test/run.js` supports `--input=BATCH:ACTION:ARGS,...` for keydown/keyup/keypress/click/dblclick/post-cmd/png and more. `BATCH:dump-mem:0xADDR[:LEN]` hexdumps guest memory *at that batch* — reach for it instead of `--dump=`, which only fires at exit, by which time a scratch buffer has usually been freed and reissued and its contents are a picture of whatever moved in afterwards (that reads convincingly as corruption). Output format matches `--dump`, so `tools/dump2png.js` parses either. The renderer's `inputQueue` feeds into `check_input()`. See lines 82-159 in run.js for the full list.

## Key Concepts

- **Threaded code:** x86 is decoded into a sequence of (opcode, operand) pairs stored in the thread cache. The `$next` function advances the thread pointer and dispatches via indirect call through the handler table.
- **Lazy flags:** Flags (ZF, SF, CF, OF) are not computed after every instruction. Instead, `flag_op`, `flag_a`, `flag_b`, `flag_res` are stored, and flags are computed on demand by `$get_zf`, `$get_cf`, etc. `flag_sign_shift` is 31 for 32-bit ops, 15 for 16-bit, 7 for 8-bit.
- **g2w / w2g:** Convert between guest (x86) addresses and WASM linear memory addresses. `g2w(guest) = guest - image_base + GUEST_BASE`.
- **API thunks:** Imported Win32 functions are replaced with thunk addresses. When EIP enters the thunk zone, `$win32_dispatch` handles the call.
- **Dispatch handlers:** Each Win32 API has a `$handle_{Name}` function in `09a-handlers.wat` with signature `(param $arg0-4 i32) (param $name_ptr i32)`. The generated `09b2-dispatch-table.generated.wat` contains the br_table that calls these. To add a new API: **append** it to the end of `api_table.json` (ids are array positions and are baked into the compiled hash table — a mid-array insert renumbers everything and `tools/check-api-table.js` fails the build), write `$handle_{Name}` in `09a-handlers.wat`, then run **both** `node tools/gen_dispatch.js` and `node tools/gen_api_table.js` — the second regenerates the name→id hash table, and skipping it leaves the new API unfindable at runtime with no crash to point at it.
- **Fail-fast stubs:** Unimplemented API handlers call `$crash_unimplemented` which traps with `unreachable`. Do NOT replace these with silent stubs that return 0 — silent stubs hide bugs and make them much harder to debug. When an app hits an unimplemented API, the crash log tells you exactly what to implement next. Implement the real behavior or leave the crash.
- **WAT logical operands:** Normalize raw pointers, handles, counts, and other arbitrary integers before combining them with logical `i32.and`: use `(i32.ne value (i32.const 0))` or `i32.eqz`. A raw even value AND a `0/1` predicate has a clear low bit and silently evaluates false. Raw operands are appropriate only when `i32.and` intentionally performs a bit mask; boolean operands should each be explicitly `0/1`.
- **Yield mechanism:** For async operations (DLL loading, help file fetching), WASM sets `$yield_reason` and returns control to JS. The JS event loop handles the async work, clears the yield, and resumes WASM. Yield reasons: 1=waiting, 2=exited, 3=com_load_dll, 4=help_load.
- **WAT-native windows:** Windows with wndproc `0xFFFF0001` are handled entirely in WAT (e.g., help window). `$wat_wndproc_dispatch` routes messages to the appropriate WAT wndproc.

## Tools

### Shared-agent message board

- Use the repository-root `messageboard.txt` to coordinate with other agents sharing the worktree.
- The file is gitignored and strictly append-only: never rewrite, truncate, or
  context-edit existing entries. `messageboard.txt` is the exception to the
  repository's normal `apply_patch` editing workflow—never use `apply_patch`
  on it. Add every update as a new final line with `echo ... >>
  messageboard.txt`; if an earlier entry is wrong, append a dated `CORRECTION`
  entry instead of changing the original text.
- A context patch anchored to the last line you previously read is still a
  middle edit: another agent can append between that read and the patch, and
  may never see the inserted entry while following the tail. Open the board
  with `>>` for each update so the write targets the actual EOF at write time,
  then immediately run `tail` to verify that the entry is visible at the end.
- Before staging, committing, or editing files another agent may own, read recent entries and start a background watcher:

  ```sh
  tail -n 40 messageboard.txt
  tail -f messageboard.txt &
  ```

- Append dated ownership, overlap, release, and commit notes with `echo` and
  the append redirect. Never use a single `>` redirect or any editor/patching
  tool on the board, and never replace another agent's entries:

  ```sh
  echo "$(date -Iseconds) <agent> <status and files/commit>" >> messageboard.txt
  ```

- `tools/gen_dispatch.js` — Generates `09b2-dispatch-table.generated.wat` (br_table + calls + `$init_dx_com_thunks`) from `api_table.json`. COM vtable start IDs are auto-computed from interface prefixes (e.g. `IDirectDraw_*`), so adding a new API never requires manual ID fixups.
- `tools/gen_api_table.js` — Generates the API hash table (`01b-api-hashes.generated.wat`)
- `lib/pe.js` — **the** PE header/section reader (`readPE(fileOrBuffer)` → `{buf, imageBase, sections, va2off, va2offInfo, off2va, sectionForVa, isCodeVa}`). Use it instead of re-deriving `readUInt32LE(0x3c)` + section walk in a new tool. Two rules live here so every tool inherits them: `section.isCode` is true for Borland sections *named* CodeSeg/DataSeg even when flagged as data, and `va2offInfo().hasRaw` is false for BSS addresses that have no bytes on disk (`va2off` returns -1 for those).
- `tools/xrefs.js` — also importable: `require('./xrefs').scanXrefs(file, targetVa, {near, codeOnly})` returns the classified hits, which is what `caller_census.js` uses instead of parsing printed output.
- `tools/disasm.js` — x86 disassembler for debugging (importable module)
- `tools/disasm_fn.js` — disassemble at one or more VAs: `node tools/disasm_fn.js <exe> 0xADDR[,0xADDR,...] [count]`. Warns when the start looks like a mid-instruction desync.
- `tools/xrefs.js` — find all references to a data/code VA: `node tools/xrefs.js <exe> 0xADDR [--near=0xN] [--code]`. Classifies each ref as `load`/`store`/`branch`/`other`; handles Borland-style code-in-data sections (sections named `CodeSeg`/`DataSeg` even when flagged data). Use `--near` to catch branches into any byte of a trampoline region.
- `tools/find-refs.js` — find every 4-byte pointer literal to a VA (vtable slots, fn-pointer tables, dispatch tables): `node tools/find-refs.js <pe> 0xVA [--code-only|--data-only] [--context=N]`. Complements `xrefs.js` (which finds branches) — use this when xrefs returns 0 but you suspect the fn is reached via an indirect call through a stored pointer. Example: 0 data refs ⇒ fn is not in any vtable; investigate fall-through or computed-address paths.
- `tools/find_fn.js` — given an interior VA, locate the enclosing function's entry: `node tools/find_fn.js <exe> 0xADDR[,0xADDR,...]`. Walks back to the nearest `55 8B EC` prologue, `CC`/`90` padding boundary, or `C3`/`C2` ret. Use when a trace hit lands mid-function and you need the entry for `--break=` or a clean `disasm_fn` start.
- `tools/find_field.js` — find all accesses to a struct field `[reg+OFFSET]` by scanning ModRM displacements: `node tools/find_field.js <exe> 0xOFF [--reg=esi,edi] [--op=write,read,lea,cmp,imm,indirect] [--context=N] [--fn]`. Use when REing C++ class layouts to locate setters/getters of a specific member offset.
- `tools/caller_census.js` — count runtime hits per static caller of a callee: `node tools/caller_census.js --exe=PATH --module=NAME --callee=0xORIG_VA [run.js args]`. Uses `--count` (WASM-native, full speed) + module-relative addr resolve. Default probe = callsite+5 (post-call landing of `e8` rel32). Output: per-callsite hit count. Max 16 callers (HIT_COUNT slot limit). When you need to know which of N call sites of a hot fn actually fire and how often, this is the one-shot tool.
- `tools/find_vtable_calls.js` — locate `call dword [reg+disp]` (FF /2) sites in a PE/DLL by vtable slot or raw displacement: `node tools/find_vtable_calls.js <pe> <slot>` (or `--disp=0xNN`, or `--slots` for a per-slot histogram). Filter base reg with `--reg=ecx,edx`. Use to enumerate COM call sites for a specific interface method (e.g. slot 32 = `IDirect3DRMFrame::AddVisual` at disp 0x80). Complements `find_field.js` (data accesses) and `xrefs.js` (data-VA refs), neither of which filter call-indirects by displacement.
- `tools/find_string.js` — find every VA where a string literal occurs in a PE: `node tools/find_string.js <exe> "<literal>" [--utf16] [--all]`. Prints `VA  [section]  raw=0xOFF  "literal"`. Use as the first step of a string-driven xref hunt — feed the printed VA into `tools/xrefs.js`.
- `tools/find_bytes.js` — locate every occurrence of a byte pattern in a PE: `node tools/find_bytes.js <pe> <hex>` or `--push=0xIMM` (push imm32 callsites: `68 ll ll ll ll`) or `--imm32=0xVAL` (any 4-byte LE literal). Filter by `--section=.text`, optional `--context=N`. Use to enumerate all call sites pushing a specific msg id (e.g. `--push=0x3e8` finds every `push 0x3e8` site), or scan for a signature instruction sequence. Reach for this BEFORE writing inline `python3 -c` byte-search scripts.
- `tools/bench-loops.js` — time a synthetic guest loop instead of a whole app: `node tools/bench-loops.js [--list] [--shapes=lut,store_stream] [--bytes=16m] [--reps=N] [--toggle=case_chain|rle_run|rect_run] [--top=N] [--json]`. Injects hand-encoded x86 into a live wasm instance (the `test/test-x86-ops.js` pattern) and runs both A/B arms **in one process, alternating every rep with the order rotated**. Measured noise floor **±1%** against the 24-42% that left every whole-app A/B in [interpreter-dispatch-perf.md](docs/interpreter-dispatch-perf.md) unresolvable — so reach for this before opening another timing worktree. **Read `blocks/iter`, not `ops/iter`**: on its calibration run CASE_CHAIN came out +57% faster while printing 7.7% *more* handler ops (folds 420-424 re-record the ops they replace, and the real variable — block entries — is invisible to the handler histogram). The `nop_chain`/`jmp_chain` shapes price the two primitives with dispatch count held equal by construction: **a dispatch is ~8ns and a block transfer adds ~9ns on top of it**. **Never quote a microbench % as an app %** — multiply by the profile share of the machinery it exercises (that is how the +57% here and the ≤2% on Caesar turn out to agree). It understates dispatch cost by construction (a periodic loop is perfectly BTB-predicted) and says nothing about whether a shape occurs in real code, so pair it with `find-loops.js`/`match-loops.js`. See [docs/loop-microbench-harness.md](docs/loop-microbench-harness.md).
- `tools/find-loops.js` — census of self-contained inner loops in a PE: `node tools/find-loops.js <pe> [--min-body=3] [--max-body=20] [--family=lut,copy] [--skeletons=30] [--json]`. Finds short backward branches landing on an instruction boundary, classifies each body (copy/fill/lut/scan/blend/reduce/load2-store/call/rep) and prints a normalized skeleton so the same loop over different registers collapses to one string. Use it to answer "which loop shapes recur across apps" before writing a superinstruction for one of them — see [docs/loop-idiom-superops-design.md](docs/loop-idiom-superops-design.md). Linear sweep, so data-in-code misdecodes: a skeleton seen once is a lead, one seen in several binaries is signal. Says nothing about how hot a loop is; pair with `--handler-hist`. Its family guess is a loose regex and over-counts badly (stack-counter loops read as `lut`) — it is a candidate finder; use `match-loops.js` for the real answer. Importable as `require('./find-loops').findLoops(file, {minBody, maxBody})`.
- `tools/match-loops.js` — applies the loop-idiom matcher from [docs/loop-idiom-superops-design.md](docs/loop-idiom-superops-design.md) to those bodies and reports what would actually be lowered: `node tools/match-loops.js <pe> [<pe>...] [--list=LUT_RUN] [--why] [--json]`. Builds the design's real summary (roles → induction variables → memory streams → side effects) and applies the COPY_RUN/FILL_RUN/LUT_RUN/SCAN_RUN predicates, so a match means the predicate held, not that a regex fired. `--why` prints the decline histogram — that histogram is the work list for making the matcher more general. Measured across 10 apps: 2.0% of static self-loops match, and `call` + `multi-branch` are 58% of all declines (those are Design B's territory, never A's). Match *rate* is the wrong metric on its own — check whether the matched VAs are the hot ones from `--handler-hist`.
- `tools/find-rle-nests.js` — census of RLE sprite-blit loop *nests*: `node tools/find-rle-nests.js <pe> [<pe>...] [--min-cases=4] [--detail] [--json]`. Finds a `cmp r8,imm8 / jz` ladder whose targets are branch-free load/store bodies that all jump back to one head — the run-length blit Caesar III writes at `0x40f71c`, where a token byte selects a fixed-width literal copy and one token is a transparent skip. `find-loops.js`/`match-loops.js` cannot see this shape at all: they classify a single self-loop *block*, and this is a nest of ~20 blocks reached through a jump ladder. Measured 2026-08-24 over all 287 PEs in `test/binaries` (83 more are 16-bit NE and are rejected): **c3.exe is the only hit**, so a fold for it is a one-app fold, not a reusable primitive. Its body decoder is a deliberate instruction subset — an unknown opcode rejects the body rather than guessing, so it under-reports; the known blind spot is a decoder that dispatches through a jump *table* instead of a compare ladder.
- `tools/loopmatch-decode.js` — turn a `--trace-loopmatch` log back into structure: `node tools/loopmatch-decode.js <run.js log> [--eip=0xVA] [--uniq]`. One entry per self-loop block the decoder emitted, each op named from the `(elem ...)` list in `src/02-thread-table.wat` (so it cannot drift from a renumber). This is the *runtime* companion to `match-loops.js`, which works statically off the PE: use this one when you need the ops the decoder actually emitted, fusions and all, rather than the ones a linear disassembly predicts.
- `tools/file2va.js` — convert PE file offsets ↔ VAs: `node tools/file2va.js <exe> 0xOFFSET[,...]` or `--va=0xVA[,...]`. Use after `strings -t x` / hex-editor finds, or to translate a VA back to a file offset for patching/inspection.
- `tools/dump_va.js` — peek static PE/DLL bytes at one or more VAs: `node tools/dump_va.js <exe> 0xVA[,0xVA,...] [len=32]`. Marks BSS ranges (no raw data) explicitly so a zeroed sentinel doesn't masquerade as initialized data. Use this instead of `--trace-at-dump` when you only need to inspect static `.rdata`/`.data`.
- `tools/vtable_dump.js` — dump function pointers from a vtable in a PE/DLL: `node tools/vtable_dump.js <exe> 0xVTABLE_VA [n_slots=16]`. Per slot, prints slot index, slot address, target VA, and the first instruction at the target — fast way to enumerate COM/C++ vtables and verify each slot points at a real prologue rather than NULL/garbage.
- `tools/data_offsets.js` — print the address of every NUL-terminated string in a WAT `(data ...)` segment: `node tools/data_offsets.js src/01-header.wat 0x11300 [--check=0xADDR,...]`. Ordinal-import tables in `08b-dll-loader.wat` address these strings by absolute offset, so inserting or renaming one silently shifts every later entry. Use this to confirm an offset still names what its comment claims.
- `tools/hlp-dir.js` — list a .hlp's internal files and decode its `|SYSTEM` tagged records (title, contents, config macros, window definitions): `node tools/hlp-dir.js <file.hlp> [--dump=|NAME]`. Works on files the WAT parser refuses, so it answers "what is actually in this file".
- `tools/hlp-wat-check.js` — what the WAT parser makes of a .hlp: `node tools/hlp-wat-check.js <file.hlp> [...] [--topics]`. Prints load result (with the named error code and offset), the topic/context/keyword/phrase inventory, and per-topic decode+layout results including the numbered layout and Hall-decompression failure reasons. Reach for this first on any "this help file does not render" report; pair with `hlp-dir.js` when the file will not even load.
- `tools/png-diff.js` — compare two PNGs: `node tools/png-diff.js a.png b.png [--tolerance=N] [--region=X,Y,W,H] [--out=diff.png]`. Prints changed-pixel count/share, worst channel delta and the changed bounding box; exits 1 when they differ, so it chains in a shell. Importable as `require('./png-diff').diffPng`. Use it for "did this refactor change what the screen shows" instead of copying another private `pixelDiff()` into a test.
- `tools/app-contact-sheet.js` — tile a pile of app screenshots into one labelled sheet: `node tools/app-contact-sheet.js --dir=DIR [--dir=DIR2] [--out=sheet.png] [--cols=N] [--cell=WxH] [--pick=largest|newest] [--ids=a,b] [--list] [--open]`. Recursively finds every PNG, resolves each name back to an app id in `lib/apps.js` (tolerating the `-a`/`-b`, `d_`, `sol2` decorations sweeps produce), picks one capture per app and letterboxes them into a grid with the id under each tile. `--pick=largest` is the default *because* a failed capture is a flat desktop-teal PNG of ~2KB while a real frame is 50-400KB, so file size ranks content. Reach for this after any registry-wide sweep: 156 apps in one image is the only practical way to eyeball "does everything in the dropdown still draw". Pure JS (pngjs + a built-in 5x7 font) — no ImageMagick.
- `tools/startup-modal-sweep.js` — what is behind the message box an app greets you with? `node tools/startup-modal-sweep.js --apps=a,b [--all] [--seconds=N] [--answer=ID] [--shots=DIR] [--json=out.json] [--no-build]`. Two passes per app: run it and collect every `[MessageBox]` line, then re-run it pressing that box's own default button (IDOK for a notice, IDYES for a question) via `--input=N:dlg-cmd:` every couple thousand batches and photograph what is left. The verdict — clean / content / modal-only / stuck / crash — is about the *second* picture, so "shows a box" and "shows a box and nothing else" stop looking alike. Reach for this whenever a launch check scores an app as a pass and the contact-sheet tile is a grey box on teal: About boxes (Four Stones, Funtris, Peaks), a welcome screen (Klotski), a question (HyperTerminal's "You need to install a modem"), or a real complaint naming an emulator gap (Imaging's "The Image Admin control cannot be found").
- `tools/cache-slots.js` — is the block cache too small, or is its index aliasing? `node tools/cache-slots.js <hot-block-dump> [--mask=0x3fff] [--hash=fold12|fold8|mul] [--top=N]`. Feed it `test/run.js --handler-hist --handler-hist-thread=N --hot-block-dump=FILE`, which writes the whole executed-block working set for the window (the printed `top blocks` list is only the top 20). It applies the real `$cache_slot` index — `(ga ^ ga>>12) & CACHE_MASK`, with `CACHE_MASK` read out of `src/01-header.wat` so it cannot drift — and prints occupancy, contested slots, and the cost of each collision as hits into a slot's loser. `--mask` and `--hash` model a resize or a new index **before** any WAT is written. Reach for this before growing the cache: on Caesar III the working set is 1861 blocks in 4096 slots and every alternative index scored the same or worse, so its 129610 decodes are not a cache-size problem.
- `tools/mpq-dir.js` / `tools/mpq-extract.js` — Blizzard MPQ archives (Diablo's `spawn.mpq`). `mpq-dir.js` reads the tables: header, block table, `--pos=0xOFF` (which block a traced read came from), `--table=IDX` (sector offsets), `--name='dir\file.ext'` (hash-table lookup, no listfile needed). `mpq-extract.js` decodes an entry all the way to bytes — decryption plus per-sector PKWARE DCL explode — with `--out=`, `--png=` (8bpp RLE PCX → PNG using the trailing 769-byte palette), `--frame-height=N` (slice a tall multi-frame sprite sheet into one PNG per frame), `--palette` (index histogram, which names the colour key) and `--verify` (decode every block, check each against its `fsize`). Shared code is in `tools/mpq.js`. Reach for this when a guest asset renders wrong: it is the host-side ground truth for what the bytes are supposed to be, with no emulator in the loop.
- `tools/dump2png.js` — render a `--dump` region as a picture: `node tools/dump2png.js <log|bin> --width=320 [--bpp=1|4|8] [--flip] [--mode=gray|mask|index] [--skip=N] [--height=N] [--scale=N] [--grid=N] [--addr=0xADDR] [--nth=N] [--binary]`. Parses run.js's own hexdump output, so any buffer you can `--dump` you can look at. Reach for it the moment a question becomes "is this run of bytes the right picture" — a hexdump cannot answer that, and the `png-*.js` tools all start from a PNG, which is exactly what you do not have while the surface is still inside the emulator. `--mode=mask` (zero black, non-zero white) shows what *guest* code reading "not the paper index = ink" will make of an indexed surface, which is often the finding. **Get `--bpp` and `--flip` right before believing anything**: a 1bpp 320px sheet is a 40-byte stride, and read as 8bpp it looks like 8x-wide glyphs on every eighth scanline over an eighth of the buffer — convincingly like a rasterizer that gave up early. A positive `biHeight` is bottom-up, so `--flip` is the common case, not the exception. `--nth` picks among repeated dumps of one address.
- `tools/hexdump.js` — Memory hexdump utility
- `tools/parse-rsrc.js` — PE resource section parser
- `tools/pe-imports.js` — PE import table dumper (`--all` lists all functions, `--dll=NAME` filters by DLL)
- `tools/ne-dump.js` — 16-bit NE (New Executable) structure dumper: `node tools/ne-dump.js <file.exe> [--segments] [--imports] [--entries] [--relocs=N] [--all]`. Every other tool here assumes a 32-bit image, so this is the only way to read `test/binaries/win98-16bit/`. Prints the segment table with file positions and flags, the module-reference/imported-name tables, the entry table, and per-segment fixups already resolved to `USER.#113` / `seg 1:0x0` form. Start here for anything about the Win16 games or Explorer's QT_Thunk path.
- `tools/pe-sections.js` — PE section header dumper
- `tools/pe-version.js` — dump `VS_VERSION_INFO` from a PE: `node tools/pe-version.js <pe> [<pe>...] [--json]`. Prints the fixed file/product version plus every StringFileInfo pair (FileVersion, ProductName, OriginalFilename…). Use it to answer "which release is this DLL from" — the corpus mixes DirectX/OLE builds and only this resource says which. `parse-rsrc.js` walks menus/dialogs/strings/icons and skips RT_VERSION, and macOS `strings(1)` has no `-e` flag, so the UTF-16 block is invisible to a grep.
- `tools/wasm-native.js` — see the machine code a wasm JIT makes of one of our functions: `node tools/wasm-native.js --func='$next' [--index=N] [--tier=ion|baseline] [--limit=N] [--top=N]`. Every "the JIT probably does X" argument ends here instead. Node's V8 has `--print-wasm-code`/`--print-code` compiled out and macOS refuses a debugger attach, so this goes through SpiderMonkey's `wasmExtractCode`, which hands back the native code plus a segment table naming each function index — no privileges needed. **It is SpiderMonkey Ion, not V8 TurboFan**: read it for structure (how many loads a handler really does, whether a bounds check survived, whether the loop stayed in registers, how big the function is), never for a cycle count attributed to Chrome. `--top` is a size census over the whole module. Needs `npx jsvu@latest --engines=spidermonkey` and `brew install binutils` (GNU objdump; Apple's has no `-b binary`); `$SM`/`$OBJDUMP` override the paths. Measured 2026-08-24: `$next` is 193 instructions and opens every dispatch with a frame setup, a stack-limit check and an interrupt check.
- `tools/render-png.js` — Headless PNG renderer
- `tools/check-parens.js` — WAT parenthesis balance checker (auto-diffs vs git HEAD)
- `tools/build.sh` — Build script (gates + concat + `lib/compile-wat.js`)
- `tools/check-wat-manifest.js` — asserts `WAT_FILES` == `src/*.wat` as a set and as an order
- `tools/concat-wat.js` — writes `build/combined.wat` from `WAT_FILES` (not a shell glob)
- `tools/check-apps-registry.js` — asserts every `lib/apps.js` entry points at files that exist (exe, path-form DLLs, data files). Both hosts read that registry now, so a typo'd path breaks `run.js --app=<id>` as well as the desktop icon.
- `tools/check-api-table.js` — asserts `api_table.json` ids are array positions and the array is append-only vs `HEAD`
- `tools/check-data-strings.js` — asserts every `(i32.const 0xADDR) ;; Name` string-address annotation still names the string at that address
- `tools/gen_dispatch.js --check` — fails if the generated dispatch table is stale rather than regenerating it
- `tools/deploy-berrry.js` — Deploy to berrry.app. `--update` updates an existing app and by default fetches the server's sha256 manifest, then uploads only files whose hash differs (so a no-op redeploy ships zero files). `--full` forces a complete reupload. `--files=a,b,c` uploads an explicit comma-separated list of repo-relative paths and skips diffing. Note: by default `--update` *will* push uncommitted working-tree changes, since the diff is against the live server, not git.

## Test Binaries

Win98/XP executables in `test/binaries/`. Currently tested:

- **Win98 accessories:** notepad.exe, calc.exe, mspaint.exe
- **Entertainment Pack:** SkiFree (ski32.exe), FreeCell, Solitaire, Minesweeper, Reversi, Golf, Pegged, Rattler Race, Taipei, TicTactics
- **NT/XP:** mspaint.exe (NT version, requires msvcrt.dll + mfc42u.dll from `test/binaries/dlls/`), winmine.exe (XP)
- **Other:** Space Cadet Pinball, Winamp extracted app, Winamp 2.91/2.95 NSIS installers
- **Help files:** `test/binaries/help/` — .hlp files for notepad, calc, freecell, solitaire, mspaint

### Reverse-engineering notes

[docs/re-notes/](docs/re-notes/README.md) — one file per guest binary we have dug into: module load bases and the runtime↔original VA arithmetic, asset/container layout, the app's real API profile, every function entry already identified, headless commands that reach a given screen, and the hypotheses already ruled out. **Read the app's file before starting an investigation on it, and add what you learn when you finish one** — otherwise the same disassembly gets redone every session.
