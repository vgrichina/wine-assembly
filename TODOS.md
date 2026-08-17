# TODOS

Snapshot of remaining work, written 2026-08-16 by picking up five Claude sessions
that ran the night of 2026-08-15 and stopped mid-flight. Each item names the
session that owns it, the files it touches, and what the *next* concrete step is.

Session transcripts live in
`~/.claude/projects/-Users-vg-Documents-projects-phone-wine-assembly/<id>.jsonl`.
Coordination history is `messageboard.txt` (append-only; entries 1180-1220 cover
this stretch).

Tree state at time of writing: HEAD `209aa00`, working tree clean, build green,
corpus sweep 106 PASS / 0 FAIL.

---

## 0. Blocking question: are the 24 e2e failures real? — ANSWERED 2026-08-16

**Answer: they are real, but they are not new, and the font commits are
exonerated.** A baseline worktree at `eff03cb^` (680db80) produced a
byte-identical fail set to HEAD across all six sampled tests, so neither
`eff03cb`/`45e58ae` nor the `WNDPROC_DIALOG` move caused any of them. Against
the session-start commit `9c49b65`: `spider-messagebox`, `find-cancel`,
`solitaire-resize` and `cwordzap-render` fail identically there too — they
predate the whole night. `mspaint-options` was *worse* at `9c49b65` (the run
did not complete at all); only its margin-gray assert is left. Only
`regedit-deep` truly regressed, bisected to `88c6a72` — seeding `HKLM\System`
gives HKLM a third child, so the tree has 10 visible rows where the test pinned
9. Expectation fixed in `48379a7`; the emulator was correct.

What is left of this item is the individual failures, each of which is now a
plain bug with no shared cause. Note also that `lib/storage.js` seeds both
`HKLM\SOFTWARE` and `HKLM\Software` and key paths compare case-sensitively, so
regedit shows two keys where Windows shows one.

The original writeup follows.

**Priority: highest. Nobody owns this yet.**

`test/run-all.sh` in the shared tree at 23:58 gave **151 passed / 27 failed**:
unit 92/2, e2e 58/24, smoke 1/1. The two unit failures are known and owned
(`test-winhelp-wat-parser`, `test-gdi-public-api-status` 245-vs-244).

**All six sampled failures are now closed** (2026-08-16). Five of the six were
tests pinned to stale geometry or to the retired JS renderer's palette — the
emulator was right and the assert was wrong. Only `test-cwordzap-render` was a
genuine emulator bug. Two reusable lessons for the rest of the 24:

1. Before believing a pixel/click assert, check the *live* geometry
   (`dump-windows`) and the Win98 classic palette (the real Plus! 98 theme
   files in `test/output/wordpad-mixed-format-roundtrip/vfs/screensavers/*.the`
   settle any color question). A coordinate hardcoded months ago is the prime
   suspect.
2. `run.js` now has `close-click:TARGET` and `corner-drag:HWND:DX:DY`, which
   derive their points from the live window rect. Prefer them over magic
   screen coordinates so the next placement change doesn't silently rot the
   test into a no-op.

Also: timing-sensitive tests (`test-mspaint-options` 9s, `test-mspaint-stretch-icons`
10s `execFileSync` timeouts) go red purely from machine load. Check `uptime`
before believing them.

The original sampled table:

| Test | Assert that fails |
|---|---|
| `test-regedit-deep` | `tree displays classic folder glyphs (0 yellow px)` |
| `test-mspaint-options` | `tool-options margin stayed button-face gray` |
| ~~`test-spider-messagebox`~~ | FIXED `dcbc468` — the assert pinned the retired JS renderer's 64,64,64 outer shadow; Win98's COLOR_3DDKSHADOW is black (every Plus! 98 `.the` ships `ButtonDkShadow=0 0 0`). Emulator was correct. Also filled in the missing `GetSysColor` indices 21/23/24. 7/7. |
| ~~`test-find-cancel`~~ | FIXED `35bb495` — the test clicked (390,72), which is inside the dialog's *client* area; the close box is x 379..395, y 45..59. Emulator was correct. New `close-click:TARGET` input action derives the point from the live window rect. 11/11. |
| ~~`test-solitaire-resize`~~ | FIXED `c7efdb6` — the test pressed 19px below the window (it assumed y=20, Solitaire opens at y=0), so it grabbed nothing. Resize itself always worked. Now drags the live corner via a new `corner-drag` input action. 3/3. |
| ~~`test-cwordzap-render`~~ | FIXED `e2503be` — **a real emulator bug**, unlike the others here: `StretchDIBits` rejected BI_RLE4/BI_RLE8 outright (`$gdi_raster_desc_from_bmi` accepts only BI_RGB/BI_BITFIELDS), so the splash drew nothing. Now decoded through the existing `$gdi_bitmap_create_dibitmap` path. 7/7. |

Most plausible sources, both of which landed **without an e2e run**:

- `eff03cb` "Delete the JavaScript text path" + `45e58ae` (fonts session; it said
  outright that the e2e tier was never run against either commit)
- the `WNDPROC_DIALOG 0xFFFE0002 -> 0xFFFF0004` move (board entry 22:30), which
  fits the `find-cancel` dialog-hwnd failures

**Next step:** run `bash test/run-all.sh e2e` at the commit *before* the font-path
deletion, in a worktree, and diff the FAIL name sets against the current run.

**Do not repeat the mistake that wasted the last attempt:** the abandoned worktree
at `~/.claude/jobs/b303255f/tmp/wt5` symlinked only `test/binaries`, so it had no
fonts and failed 83+ tests including every `test-wat-gdi-*`. Its numbers are
meaningless. Delete it. A baseline worktree needs the font assets too.

---

## 1. Win16 / NE — Phase 6: three of the four are playable

Phase 1 (`0c23c78`) loads and links NE images, Phase 2 (`84c98a1`) runs them,
Phase 3 (`ff6f45a`, `9a0f12f`, `3b18812`, `90e548a`) gives them an API layer,
Phase 4 (`919f011`, `5e8a9f3`, `e78ba7f`, `0af03d5`) adds NE DLL loading, and
Phase 5 (`d5a09f7`) gets Hearts running.

Phase 6 (`fd04a70`, `df6b6b5`, `653da1d`, `3716c6f`, `f82cc5d`, `7f464ce`)
makes them look right rather than merely run.

**Minesweeper is complete** — Game/Help menu, red LED counters, yellow smiley,
raised minefield. **Solitaire deals: stock, four foundations and seven tableau
columns of real cards on green baize.** **FreeCell deals a full board out of
CARDS.DLL** — eight columns of card faces, free cells, "FreeCell Game #2574"
in the title (it opens empty by design; Game▸New Game, command 102, deals).
**Hearts creates its frame, its status bar and its buttons, runs its message
loop, initialises DDEML and puts up a real message box.** All four are in the
browser shell under "16-bit (Win16 / NE)" (`8dc244e`), covered by
`test/test-win16-web.js`, which asserts Minesweeper's colour art and that both
card games actually deal.

Most of the bugs behind the previously-empty tables were **not** Win16-only
and are worth knowing about for 32-bit apps too:

- `$handle_AdjustWindowRectEx` ignored `dwExStyle` while
  `$defwndproc_do_nccalcsize` honours it, so any `WS_EX_CLIENTEDGE` window
  sized through it came back four pixels narrower than the app asked for.
- `$handle_PatBlt` reads its width and height back off the stack frame rather
  than from its arguments — the Win16 bridge wrote only the rop there, so
  every 16-bit `PatBlt` filled a garbage rectangle. It is the only handler in
  the bridge that reads past argument 2; the other 97 were audited.
- `GetDeviceCaps(NUMCOLORS)` answered Win32's `-1`, which a 16-bit caller
  compares as a signed word. Minesweeper's `cmp ax,2 / jle` therefore chose
  its monochrome bitmap set and drew the whole board in 1-bit art.
- `$menu_load` and `rsrc_exists` both meant "PE resource", so no 16-bit app
  had a menu bar. An NE menu is the same MENUITEMTEMPLATE with ANSI labels.
- **A DLL's exported prologue was never patched.** `push ds / pop ax / nop` is
  three bytes the linker leaves meaning "AX = the caller's DS", and the loader
  is expected to replace them with `mov ax, DGROUP`. Without it every export
  runs on its caller's data segment and reads the caller's variables as its
  own — nothing faults, it just reads the wrong memory. CARDS.DLL found
  FreeCell's data where its card-bitmap cache should be.
- **A 16-bit task never became the active window.** WM_ACTIVATEAPP,
  WM_ACTIVATE and WM_SETFOCUS are delivered from CreateWindowExA through
  32-bit continuation thunks, which a 16-bit task cannot be resumed on.
- ShowWindow's WM_SIZE arrived *after* whatever WinMain posted, rather than
  before it as on Windows, so Solitaire dealt onto a table with no layout.

The address scheme, because everything else depends on it: every segment base
is 64KB aligned, so the low word of a linear address *is* the offset inside its
segment. `$esp` therefore stays a linear address with SP as its low half, and
the pre-existing 16-bit push/pop handlers needed no changes at all.

- Files: `src/05c-seg16-ops.wat` (handlers 363-387 — segmented EA, far
  transfers, segment-register moves, string ops), `src/09e-win16-api.wat` (the
  API layer, ~70 entry points), `src/07-decoder.wat` (`$code16` inverts the
  66/67 prefixes; `$decode_modrm16`), `src/08c-ne-loader.wat`,
  `src/01-header.wat`
- Tooling: `tools/ne-dump.js`, `tools/ne-exports.js`,
  `tools/gen_win16_ordinals.js` → `src/win16-ordinals.generated.json` (1,468
  names, 10 modules; all 269 ordinals the four apps import resolve).
  **`--trace-win16`** logs every call with the ten stack words nearest the top
  (BitBlt's Pascal frame is exactly ten and its destination DC is the deepest)
  and the AX/DX/EIP/ESP that came back, and decodes the 16-bit MSG behind
  `lpMsg` for the four message-pump entry points — reach for it first on
  anything here. `tools/png-probe.js --at=x,y` reads a dumped surface's alpha,
  which is how you tell "filled black" from "never drawn".
  Two facts worth not rediscovering: a Win16 module name is not its filename
  (SOUND ships as `mmsound.drv`), and not every import is by ordinal.

### The three things that make the layer work

**The handle map** (`$win16_h16`/`$win16_h32`). A Win16 handle is 16 bits and
ours are 32-bit values like `0x00310001`. Rather than narrow every allocator,
the two spaces are joined at the dispatch boundary and nothing on the 32-bit
side learns Win16 exists. The table lives in the one arena slot past the last
usable selector, so no far pointer can name it.

**The bridge into the 32-bit handlers** (`$win16_call32_begin`/`_end`). Most of
Win16 is Win32 with narrower arguments, so the Win16 side widens onto a scratch
stdcall frame and calls `$handle_*` directly. It refuses a handler that moved
EIP (marker `0xCA16A9F7`), because a redirect into guest code carries a 32-bit
frame a 16-bit task cannot survive — ShowWindow and CreateWindow are written
out for that reason.

**The continuation** (`$WIN16_CONT_OFFSET`). An API that must run the window
procedure before returning pushes a far return address into the thunk segment;
`$th_retf16` recognises it and `$win16_dispatch` finishes the API. This is how
CreateWindow delivers WM_CREATE *before* it returns, which matters: Solitaire
never stores the handle CreateWindow gives it, because its WM_CREATE handler
sets the global instead.

### Open

- **Solitaire's animated deal never advances.** The board it opens with is
  right, but ask for another (Game▸Deal, command 1000) and the table clears to
  stock plus foundation outlines and stays there. The engine's animation tick
  — `seg 4:0x13ac`, reached from the TIMERPROC through the dispatcher at
  `seg 4:0x1644` — takes its early-out every single time because the table
  object's `+0x14` is zero. The other three gates pass (`[0x2e]`=1,
  `+0x12`=1, `[0x14]`=0 meaning not iconic), and a watchpoint on `+0x14`
  (`--watch-word=0x1a02ce --watch-log`) shows nothing ever writes it. Find what
  should. Two observations that may or may not be related: after that second
  deal the app's own 250ms timer is delivered on nearly every pump iteration
  (~15000 WM_TIMER in a 2s run, one per idle poll, id and TIMERPROC both
  correct) while `--dump=0xac00:60` shows an empty TIMER_TABLE at run end, so
  where those deliveries come from is not yet explained; and the tableau piles
  draw their cards with a 3px fan, which is right for face-down cards, but
  three of the seven still show a back rather than a turned top card.
- **Hearts goes straight to the client path and finds no dealer.** It gets all
  the way to `DdeConnect`, gets NULL — correctly, nothing else is in the room —
  and puts up "Unable to connect with dealer. Hearts will end." What it should
  do first is show its startup dialog: the resources contain "What is your
  name?", "I want to be &dealer." and "&Computer player names", so the dealer
  path fills the empty seats with computer players and is a complete
  single-player game. `DialogBox` (USER.87) and `DialogBoxIndirect` (USER.218)
  are imported and reached through one MFC `DoModal` at `seg 1:0xaf20`, and
  neither is ever called in a run, so something upstream of the dialog decided
  client mode. Start by finding what picks between the DDE server wrapper near
  `seg 1:0x79ec` (which calls `DdeNameService`) and the client one near
  `seg 1:0x7a80` (which calls `DdeConnect`) — only the second ever runs. Use
  `tools/ne-disasm.js`.
- **DDEML has no conversations.** `src/09f-win16-ddeml.wat` implements the
  twelve entry points Hearts imports, with real interning string handles and
  real data handles, but `DdeConnect` always finds nobody because nothing
  carries a conversation between two emulator instances. Two players in one
  room is the same shape of problem the virtual LAN in `09d-winsock.wat`
  already solves for Winsock, and worth doing that way when there is a second
  player to test against.
- Known execution-core gaps, all of which trap loudly and none of which the
  four apps reach: INT (including the INT 3Fh moveable-segment thunks), 16↔32
  thunking, named resources (`LoadIcon` with a string name returns 0 —
  Solitaire's icon). `tools/ne-dump.js --resources` shows what a module
  actually ships, including named types and ids.
- Structure width is the recurring bug class here, and it is worth stating
  plainly: **a structure that crosses the boundary is a different size in the
  two worlds.** `SystemParametersInfo(SPI_GETWORKAREA)` wrote a 32-bit RECT
  into FreeCell's 8-byte one, four bytes below its own return address, and the
  task returned to zero. A watchpoint on that slot named it in one run. The
  APIs that carry a structure now convert explicitly and stop on one they do
  not know rather than guessing at a width.
- Argument *order* is the second recurring bug class, and it bites in both
  directions: `CreateWindowEx` takes `dwExStyle` as its **first** parameter, so
  Pascal pushes it deepest and no other index shifts, while
  `AdjustWindowRectEx` takes it **last**, where every other index does shift.
- Argument *width* is the third, and it is the nastiest because it is silent
  and delayed. A Win16 `HHOOK`, `HSZ`, `HCONV` and `HDDEDATA` are all **far
  pointers**, not words. Getting one wrong pops two bytes too few, and the
  caller's frame drifts two bytes at a time until some unrelated `RETF` half a
  screen away reads a garbage CS and the trap names a function that has
  nothing to do with it. Do not guess a Win16 signature: `tools/ne-dump.js
  --relocs=N` gives the offset of every import call site and
  `tools/ne-disasm.js` shows what the app actually pushes there.

## 2. Fonts — e2e verification and the original measurement (session `ea1ba02f`)

- Files: `src/10b-gdi-font.wat`, `src/10c-truetype.wat`, `lib/host-imports.js`,
  `lib/font-substitutions.js`, `fonts/substitutions.json`,
  `tools/v86-reference/*`, `test/fixtures/font-metrics.json`,
  `test/test-wat-font-metrics-reference.js`
- Commits `eff03cb`, `45e58ae` have unit coverage and a byte-identical notepad
  render, but **no e2e run** — see item 0, which is largely this.
- Its own stated next step ("#1"): the original measurement question, now that the
  measurement infrastructure exists; item #3 on its list comes free with it.
- Still open and font-shaped: `test-winhelp-reference` fails on
  `WinHelp close glyph differs from Win98`.

## 3. Async I/O demo path (session `410075d6`)

The blocking question is **answered**: the user picked Blobby Volley directly,
so the telnet-first detour is dropped.

- **Blobby Volley single-player is done** (`bd9a56a`) — it plays, with no
  emulator change needed. See `apps/blobby-volley.md`, covered by
  `test/test-blobby-volley.js` (9 checks, e2e tier).
- **The DirectPlay lobby now runs** (`f9e2d25`). `NETZWERKSPIEL` reaches both
  end states: host → `Open` + `CreatePlayer` → "WARTE AUF EINEN GAST…", guest →
  `EnumSessions` → "GEFUNDENE SPIELE: LOCAL SESSION". Covered by
  `test/test-blobby-network.js` (10 checks, e2e tier). Two fixes: the
  `DirectPlayCreate` handler popped 20 bytes for a 3-arg function (which
  quietly killed the game thread), and it was an `E_FAIL` stub even though
  `IDirectPlay3` was already implemented behind `CoCreateInstance`.
- **Still open: traffic between two processes.** `Send` returns `DP_OK` without
  sending, `Receive` returns `DPERR_NOMESSAGES`, and `EnumSessions` fabricates
  its one session — so a host and a guest cannot meet. This is the remaining
  real async I/O, and it pairs with the virtual LAN in item 4:
  `src/09d-winsock.wat` + `lib/vlan-wire.js` already join two emulator
  processes into one room, and the guest screen offers a **Host-IP** field that
  maps straight onto `--vlan-ip`.
- **Telnet** (`apps/telnet.md`) remains available as a cheaper async-I/O proof if
  DirectPlay turns out to be a long haul: 0x0 `WS_POPUP` window, never calls
  `ShowWindow`, pumps forever; the XP console client also needs console
  rendering.

## 4. Virtual LAN / TetriNET (session `b303255f`) — mostly landed

- `ecd3a6b` + `209aa00` now carry the round-trip gate and the prop-atom fix.
  Verified: corpus 106 PASS / 0 FAIL, `test-vlan-tetrinet` 6/6.
- Files: `src/09d-winsock.wat`, `src/09a5-handlers-window.wat`,
  `test/test-vlan-tetrinet.js`, `test/test-wat-winsock-hostname.js`
- Remaining: the browser wiring for the virtual LAN (`lib/vlan-wire.js` currently
  proves loopback + cross-process; the browser side is unbuilt).

## 5. WinHelp (session `351afaf4`) — clean, one open item

- `87a9546` verified: parser 606/7, `test-help` 5/5, `winhelp-dll-macro` 6/6.
- Files: `src/09c6-winhelp-core.wat`, `src/09c7-winhelp-hlp.wat`,
  `src/09c9-winhelp-ui.wat`, `tools/hlp-wat-check.js`
- Open: the close-glyph mismatch above (font work, not parser work).

---

## Cross-cutting, carried over from earlier sessions

- ~~**`CW_USEDEFAULT` ignores only x, not y**~~ — FIXED `7d4d1af`. x and y are a
  pair, so `x=CW_USEDEFAULT` makes the system pick both and ignore the caller's
  y. Solitaire and Notepad now open in the y=20 cascade slot. The 20px shift
  fixed three e2e tests (`solitaire-maximize`, `notepad-find-next-positive`,
  `notepad-find-not-found-msgbox`) and broke exactly one, `notepad-menu`, which
  sampled a fixed desktop point for the File dropdown; its anchor is now derived
  from the live window origin. Verified with a full before/after e2e diff in a
  clean worktree, plus unit 92/2 and corpus 106 PASS / 0 FAIL.
- ~~**mspaint scrollbar travel**~~ — FIXED `2bc5c16`, and it was never an
  emulator bug. `test-mspaint-scrollbar-thumb` (3/5 → 6/6) and
  `test-mspaint-large-scroll` (2/5 → 5/5) were pinned to the geometry of a
  212x283 view; the frame's client inset is now correctly 6px, the view is
  202x274, and Paint's page/4 arrow scroll moved with it. New rot-proof input
  actions in `test/run.js`: `scroll-click`, `scroll-drag`, `dump-scrollbar`,
  `caption-click`, and `assert-standard-scroll` now takes `N%` of the bar's own
  page size. Three mspaint `execFileSync` timeouts also raised to 45s — they are
  hang ceilings, not performance budgets, and were going red on box load alone.
- **Screensaver GDI-bridge regression** — `apps/screensavers.md` Task 0, fixed
  2026-08-15 via the RLE DIB path; re-read before trusting it, since
  `test-cwordzap-render`'s RLE4 asserts are failing again in the current e2e run.
- ~~**d3rm `MeshBuilder::Load` / ProgressiveMesh**~~ — RESOLVED 2026-08-16. The
  `D3DRMERR_NOTFOUND` was correct: our DX SDK extract ships no `camera.x`, and
  the one we had was a ProgressiveMesh copied under that name in April, which a
  MeshBuilder refuses by design. Given a real plain `Mesh` file the viewer loads
  and renders — DX5 D3DIM Viewer `KNOWN_BAD_RENDER` → **PASS**, corpus 106 → 107
  PASS. Retained-mode geometry works; see `apps/screensavers.md` Task 3.
- **CITYSCAP blank screen** (Task 2, MEDIUM), **FOXTROT white silhouettes**
  (Task 1, LOW).
- **CD Player** renders frame and menu but not its transport controls — the only
  other unresolved emulator bug among the sweep WARNs.
- **External-asset WARNs** (not emulator bugs; each names its blocker in
  `test/test-all-exes.js`): Kodak Preview needs OIDIS400+OIADM400, HyperTerminal
  needs HYPERTRM.dll, Welcome98 needs `welcome.dat`, IP Config has no adapter,
  JigSawedME and Rodent2000 need the VB6 runtime, XP EOL is version-gated by
  design.

---

## Hazard worth knowing about

Something in this shared tree rewrites whole `src/` files that other agents have
dirty. A verified `$prop_key` fix was reverted from disk between a read and a
commit; `git commit <path>` then silently committed only the other file, and the
loss was visible only in the `1 file changed` stat. **Check the file count in
commit output — do not assume your hunks landed.**
