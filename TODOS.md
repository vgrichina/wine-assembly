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

## 1. Win16 / NE — Phase 6: three of the four are playable, one is complete

Phase 1 (`0c23c78`) loads and links NE images, Phase 2 (`84c98a1`) runs them,
Phase 3 (`ff6f45a`, `9a0f12f`, `3b18812`, `90e548a`) gives them an API layer,
Phase 4 (`919f011`, `5e8a9f3`, `e78ba7f`, `0af03d5`) adds NE DLL loading, and
Phase 5 (`d5a09f7`) gets Hearts running.

Phase 6 (`fd04a70`, `df6b6b5`, `653da1d`, `3716c6f`, `f82cc5d`, `7f464ce`,
`72b3ba8`) makes them look right rather than merely run.

**Minesweeper is complete** — Game/Help menu, red LED counters, yellow smiley,
raised minefield. **Solitaire deals a full hand, and keeps dealing** — stock,
four foundations, seven tableau columns each with its face-up top card over a
face-down fan, hand after hand. **FreeCell deals a full board out of
CARDS.DLL** — eight columns of card faces, free cells, "FreeCell Game #2574"
in the title (it opens empty by design; Game▸New Game, command 102, deals).
**Hearts creates its frame, its status bar and its buttons, runs its message
loop, initialises DDEML and puts up a real message box.** All four are in the
browser shell under "16-bit (Win16 / NE)" (`8dc244e`), covered by
`test/test-win16-web.js`, which asserts Minesweeper's colour art, that both
card games actually deal, and that Solitaire's *second* hand is as full as its
first.

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
- **The local heap never reused a freed block.** `LocalFree` was a no-op and
  `LocalAlloc` a bump pointer. An app that churns — Solitaire allocates a node
  per card and frees all 28 on the next deal — exhausts a 4KB heap in two
  hands. A NULL from LocalAlloc is rarely reported by the caller, so this
  reads as a feature quietly not working rather than as an error.

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
  `tools/ne-disasm.js --all` sweeps a whole segment linearly rather than
  following one function to its first `ret`, which is how you grep a module for
  every write to a struct field — none of the `find_*` tools read NE images or
  16-bit ModRM.
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

- ~~**Solitaire's deal stops part way.**~~ FIXED `72b3ba8`, and the diagnosis
  in the previous version of this item was wrong in an instructive way — the
  animation tick at `seg 4:0x13ac` is a *drag* tick, `+0x14` means "a card is
  in hand", and it is correctly zero. The deal is synchronous: the loop at
  `seg 4:0xdd3` places all 28 cards every time. What failed was drawing them.
  `$win16_LocalAlloc` was a bump pointer and `LocalFree` a no-op, as its own
  comment admitted; Solitaire allocates one 26-byte node per card and frees all
  28 on the next deal, so a 4KB heap runs dry mid-way through the second hand
  and entirely by the third. A NULL from LocalAlloc is not an error the game
  reports — the pile just declines the card — so it looked like an animation
  that stalled. The heap now has a first-fit free list.
  The two "unexplained" observations were both artifacts of the harness, worth
  writing down so nobody chases them again: `test/run.js` gives the guest a
  synthetic clock of **200ms per batch**, so a 250ms timer is due on nearly
  every pump iteration and thousands of WM_TIMER in a short run are expected
  (the browser uses real time); and `--dump` runs its address through `g2w`, so
  `--dump=0xac00` never reads TIMER_TABLE at all — that address is a raw WASM
  offset below GUEST_BASE, not a guest address.
- ~~**Menu commands crash or draw nothing.**~~ FIXED. Every menu command of
  FreeCell, Solitaire and Minesweeper now runs — `test/test-win16-menus.js`
  drives all of them from each app's own `RT_MENU` via `tools/menu-sweep.js`,
  which is worth reaching for on any app, 16- or 32-bit: "it launches" says
  nothing about the twenty-seven things its menus do. Five causes, and only two
  of them were Win16 plumbing:
  - `SetWindowPos` (USER.232) was missing. Four of FreeCell's five commands go
    through one centre-the-dialog routine that calls it.
  - `ShellAbout` was missing, and reached two different ways: Solitaire and
    Minesweeper import SHELL.22, FreeCell imports the name. A built-in module
    called by name never reached module dispatch at all — `$win16_dispatch`
    trapped first — so there is now a name path beside the ordinal one.
  - `DispatchMessage` entered any non-zero window procedure as a far pointer.
    SendMessage had always checked; nothing had posted to a window of *ours*
    until ShellAbout put one up, and then CS took 0xFFFF.
  - `SetDlgItemText`/`SetDlgItemInt`/`GetDlgItemInt` (USER.92/94/95).
  - **A 16-bit MOVSD copied two bytes and advanced four.** `$th_string16` read
    its packed element size as "byte or word", so the 0x66-prefixed forms —
    which is how a compiler copies a RECT in one instruction pair — moved half
    the data and left every other word stale. This is an execution-core bug,
    not a Win16-layer one, and it is the reason Solitaire's Deck dialog drew
    twelve unreadable smears while opening perfectly well. Also fixed: the
    DRAWITEMSTRUCT behind WM_DRAWITEM is 48 bytes in Win32 and 26 in Win16, and
    a 16-bit procedure `les`-es the pointer it is handed, so it is now rebuilt
    in the task's own DGROUP (`$win16_msg_lparam16`, scratch reserved at the
    bottom of DGROUP by the NE loader).
- ~~**Hearts goes straight to the client path and finds no dealer.**~~ FIXED,
  and it was five bugs in five different layers, none of them the DDE guess the
  previous version of this item made. Hearts now puts up its own startup dialog
  ("What is your name?" / "I want to be dealer"), OK closes it, and it goes on
  to ask for the dealer's computer name — `test/test-win16-hearts-startup.js`
  pins the whole sequence.
  - **The command line was `"\r"`, not `""`.** InitTask handed back the DOS
    command tail, carriage-return-terminated. That pointer *is* WinMain's
    lpCmdLine, which is documented null-terminated, so MFC compared the first
    byte, saw 0x0D, and concluded it had been given a command line telling it
    to join a game. One byte.
  - **Every Win16 dialog-item API read the wrong argument.** `$win16_arg16` is
    ESP-relative and `$win16_call32_begin` moves ESP to the 32-bit scratch
    stack, so an argument read after the bridge opens comes off that frame
    instead — index 0 being the zero written there as a return address. Ten
    functions did it, so GetDlgItem asked for control 0 whatever it was passed.
    `$win16_arg16` now traps if called while the bridge is open.
  - **One posted message was delivered twice.** `$handle_PostMessageA` decided
    "is this window another instance's?" with `i32.and`, which evaluates both
    operands — so the host call that queues the message on the owning instance
    ran for our own windows too, and then this side queued it again. Not a
    Win16 bug: any app posting to itself got the message twice.
  - **Creating a dialog never ran the WH_CALLWNDPROC filter.** CreateWindow
    always had; DialogBox did not. MFC attaches its C++ object to the HWND from
    inside that call, and its dialog procedure's first act is to look the object
    back up — it called a virtual through the null it got.
  - **DefDlgProc's share was missing.** MFC subclasses the dialog and passes
    IDOK down the chain expecting the dialog to close, so the procedure our
    window hands back on subclassing has to end the dialog, and the pump has to
    route to the *window* procedure once one is installed rather than to the
    DLGPROC.

  Three more things stood between that and a game, all now fixed:
  - **NDDEAPI.DLL would not load**, and Hearts greys out the whole "How do you
    want to play?" group when it cannot ask `NDdeGetWindow` whether network DDE
    is there. NDDEAPI is now a module the emulator implements, and its one
    entry point answers with a window of ours: DDEML is implemented in WAT
    rather than by a separate agent process, so that is the truthful answer
    rather than a zero. A module we implement has no export table for
    GetProcAddress to read, so the entry point gets a fixed thunk-segment slot
    the way the pumps do.
  - **Control messages are numbered per class from WM_USER in Win16** and in
    distinct ranges in Win32 — BM_, EM_, LB_, CB_, SBM_ and STM_ all start at
    0x400 — so which block a number belongs to can only be decided from the
    class of the window being addressed. `BM_GETCHECK` arriving as 0x400 meant
    every radio button answered "not me".
  - **PeekMessage cannot be bridged the ordinary way.** It is the one handler
    that ends by setting EIP from its own stack frame, so an idle PM_NOREMOVE
    loop yields; across the bridge that address is the scratch frame's zero.

  Hearts now deals: `test/test-win16-hearts-startup.js` drives name, dealer, OK
  and New Game and checks a green table with cards on it.

  **Its menu commands are covered now too** —
  `test/test-win16-hearts-menus.js`, 18 checks, every command on both menus.
  The sweep never reached them because it drives a freshly launched app, and
  Hearts at that moment is inside its modal startup dialog; answering the
  dialog first is what makes the menu bar live. Two commands were broken and
  neither fault was Hearts-specific:

  - **`ClientToScreen` and `ScreenToClient` (USER.28/29) did not exist.** MFC
    centres every dialog with GetParent/GetClientRect/ClientToScreen, so this
    was on the path of any 16-bit MFC dialog. Game > Score died there.
  - **A dialog was never seeded its own first paint.** `$win16_dlg_run` marked
    every *control* dirty and never the dialog window, which no dialog built
    only from controls can notice. Template 502 (the Score Sheet) holds one OK
    button and the task draws the whole score grid from WM_PAINT, so the sheet
    came up as an empty grey box. Painting it then wanted `GDI.56 CreateFont`,
    also missing.

  **CORRECTION to what this file used to say here:** it claimed the DDE server
  wrapper near `seg 1:0x79ec` is never reached and "only the client one ever
  runs", so something upstream had already chosen client mode. That is no
  longer true, and it stopped being true when the startup dialog started
  working. Choosing "I want to be dealer" now takes the server path: a traced
  dealer run calls `DdeInitialize`, eight `DdeCreateStringHandle`,
  `DdeNameService` and three `DdePostAdvise`, and **never** `DdeConnect`. There
  is nothing left to find upstream of the dialog.
- **DDEML conversations: established, but not yet carrying transactions.**
  `src/09f-win16-ddeml.wat` now joins two instances in one room. A registered
  service name is *kept* (it never was — a registration nobody recorded is a
  server no client can find), `DdeConnect` puts a CONNECT on the wire and
  waits, the instance holding that service answers, and both sides record who
  they are talking to. `DdeDisconnect` tells the peer rather than forgetting
  it locally, since a conversation the other side still believes in is a
  server holding a seat for a player who has gone.
  `test/test-win16-dde-room.js` is the gate: two instances, separate memories,
  separate DDE tables, on one loopback segment — 14 checks including that
  nobody answers for a service that was never registered.

  Two things worth knowing before extending it:

  - **The room is one queue with one reader.** `$vsock_pump` owns it and used
    to *discard* any frame whose magic it did not recognise, so a DDE frame was
    eaten before DDEML saw it. It now hands `DDE1` frames to
    `$win16_dde_deliver`. Leaving them queued is not an option either: nothing
    else drains, so the socket stream would stall behind them. Any third
    protocol on this wire has to be demultiplexed in the same place.
  - **`DdeConnect` parks by not returning.** A Win16 API is entered with its
    arguments still on the task's stack and nothing popped until
    `$win16_api_return`, so declining to return re-enters the same call with
    the same arguments next pass. No continuation slot, nothing to unwind.
    This is why it is native rather than bridged — across the Win16 bridge the
    frame it would park on belongs to a scratch stack about to be discarded,
    which is the same reason `PeekMessage` cannot be bridged.

  **What is still missing**, in the order Hearts needs it: `XTYP_CONNECT` is
  not offered to the server's own callback, so a connect is accepted on the
  service name alone and an app that would refuse cannot; `DdeClientTransaction`
  still fails, so no `XTYP_REQUEST`/`XTYP_POKE` crosses; and `DdePostAdvise`
  has no advise loops to feed, which is how Hearts actually distributes play.
  The callback is the next piece and the shape is known — the far pointer is
  already stored by `DdeInitialize`, and calling into 16-bit guest code
  asynchronously is what `$win16_dlg_send` already does for a dialog.
- ~~**Named resources returned 0.**~~ FIXED. A NAMEINFO id with bit 15 clear
  is not an id: it is an offset from the start of the resource table to a
  Pascal string, and the walker matched integer ids only, so every `Load*`
  handed a string failed outright. That is not a rare corner — Solitaire's
  group icon is stored as `"SOL"`, which is why it had no icon.
  `$win16_find_resource_ex` takes a name to match instead of an id, comparing
  without case the way USER does, and `$win16_res_lookup` picks between the two
  from the argument's selector. `LoadIcon` and `LoadBitmap` go through it.
  `LoadMenu` and `LoadAccelerators` deliberately do **not** yet: they bridge to
  the 32-bit `$handle_Load*A`, which take an integer id and walk the PE tree,
  so accepting a name there means teaching those handlers a second grammar.
  Nothing in the four apps needs it — Hearts' named `HEARTSMENU` arrives by
  another path — so it is left rather than half-done.
- Known execution-core gaps, all of which trap loudly and none of which the
  four apps reach: INT (including the INT 3Fh moveable-segment thunks), 16↔32
  thunking. `tools/ne-dump.js --resources` shows what a module
  actually ships, including named types and ids; `--menus` and `--dialogs`
  decode the RT_MENU and RT_DIALOG templates, which are the two resources whose
  16-bit layout shares nothing with the 32-bit one and so cannot be read with
  `tools/parse-rsrc.js`. `--menus-json=` is what `tools/menu-sweep.js` falls
  back to when the PE walker finds nothing, and `--seg-bytes=N:OFF[:LEN]` reads
  raw segment bytes, which is the only way to look at the DGROUP string a
  disassembly names as `push 0x1e8`.
- Tracing for message-queue problems, added while chasing the Hearts duplicate:
  `--trace-win16` now prints `post ->` for every message going into the posted
  queue and `task-loop ->` / `dlg-pump ->` for every one coming out, each with
  the queue depth. A message delivered twice is either pushed twice or popped
  twice, and only both halves together say which. `--input=N:dump-msgq` prints
  the queue itself, which `--dump` cannot: it lives at WASM 0x400, below
  GUEST_BASE, so that address goes through `g2w` and lands somewhere else.
- ~~**Solitaire showed an empty table, and cards could not be dragged.**~~
  FIXED, and neither was a Solitaire bug.
  - **The initial erase arrived too late.** It was left to the non-client flag,
    which GetMessage drains *after* the post queue — so it landed behind
    whatever the app had posted for itself. Solitaire posts its deal from
    WM_CREATE and draws each card as it deals rather than from WM_PAINT, so the
    erase painted the table green over a hand already laid out and nothing
    asked for it back. The cards appearing "only when you touch a menu" was the
    menu invalidating the window. `$win16_ShowWindow` now posts the erase with
    its own WM_SIZE/activation group, ahead of the app's, which is the order
    Windows gives it: there the erase happens inside ShowWindow before the
    task's message loop runs at all.
    Worth recording what did *not* work, since both look right: invalidating
    the window when the erase is delivered fixes Solitaire but costs a full
    repaint per erase per window, which timed mspaint's tool sweep out; and
    invalidating at ShowWindow is dropped on the floor, because the window has
    no size yet and the paint phase silently discards an empty update rect.
  - **PtInRect had x and y the wrong way round.** Its POINT is one argument
    passed *by value*, so a doubleword push puts x nearest the top of the stack
    — the opposite of the separate x and y of InflateRect beside it. The test
    asked whether (y, x) was in the rectangle, which is false for every card, so
    the button-down that starts a drag found nothing under the cursor. Any
    future Win16 API taking a POINT by value has the same trap: `ChildWindowFromPoint`
    and `WindowFromPoint` are the two that are not implemented yet.
  - `GDI.103 PtVisible` was missing; Solitaire asks it while drawing the stack
    it has picked up. `test/test-win16-solitaire-play.js` covers both the
    untouched deal and a drag that empties the column it came from.
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
