# Blobby Volley 1.7.4

Beach-volleyball arcade game, 2001, Delphi/VCL front end over DirectDraw.
**Status: playable.** Boots to the animated menu, and clicking SPIEL STARTEN
starts a live single-player match — court, net, both blobbies, ball physics and
scoring all run. No emulator changes were needed to get here.

## Binary Info

- **File:** `test/binaries/candidates/blobby-volley/volley.exe` (361,472 bytes, 2001-06-07)
- **Image base:** 0x400000, sizeOfImage 0x5d000
- **Sections:** CODE (0x4b5c0), DATA, BSS, .idata, .tls, .rdata, .reloc, .rsrc
  — Borland section naming, i.e. Delphi
- **Provenance:** `.candidate-source.json` — archive.org `volley.zip`, sha1
  `8d22d891…`
- **Assets beside the exe:** `graph.pak` (619KB, all backdrops and sprites),
  `sound.pak` (20KB), `text.pak` (2.6KB)

## Imports

Static: kernel32, user32, gdi32, advapi32, oleaut32, ole32, comctl32, version,
winmm. **No ddraw/dplay in the import table** — both are `LoadLibraryA`'d at
runtime:

| DLL | Loaded from | Used for |
|---|---|---|
| `DPlayX.dll` | 0x440598 | DirectPlay, network match only |
| `DDraw.dll` | 0x441b48 | the entire game display |

## Startup shape (this is the part worth knowing)

It is a stock VCL app, so the window layout is not what a hand-written Win32
game would produce:

| hwnd | class | Notes |
|---|---|---|
| 0x10001 | `TApplication` | created **first**, 0x0 at (320,240) — becomes `$main_hwnd` |
| 0x10002 | `TForm1` | the real UI window, 800x600 at (0,0), owned by TApplication |
| 0x10003 | `TThreadWindow` | VCL's cross-thread `Synchronize` sink |

The game runs on a worker thread (T1) while the main thread sits in a VCL idle
loop — `PeekMessageA` / `WaitMessage` / `GetCursorPos` / `WindowFromPoint`,
thousands of iterations. Two consequences:

1. **It never calls `GetMessageA`.** All injected input has to survive
   `$handle_PeekMessageA`'s hardware-input path in
   `src/09a5-handlers-window.wat`.
2. **Keyboard focus is not automatic.** With nothing focused, `check_input_hwnd`
   falls back to `$main_hwnd`, which is the 0x0 `TApplication` window, so keys
   go nowhere. A click on the form sets focus to 0x10002 first. (Any Delphi app
   will show this shape; it is worth remembering before blaming an app's input
   handling.)

The 87 `LoadStringA` calls at startup — "Gleitkommaüberlauf", "Zugriffsverletzung
bei Adresse %p" and friends — are Delphi's standard exception-message resources
being cached. They are not errors.

## Driving it from the harness

The menu is mouse-driven (the manual says "Clicking this menu option starts a
new game"), and **a click alone does nothing**: the game tracks the pointer from
`WM_MOUSEMOVE` and hit-tests menu entries against its own cursor, ignoring the
click's lParam. Move first, then click:

```
--input=500:mousemove:400:222,520:mousemove:401:223,560:mousedown:401:223,600:mouseup:401:223
```

The second mousemove matters — the game only redraws its cursor on a delta.
It boots in German; the entries in the 640x480 frame sit at x≈300-510, 36px
apart. y=222 and y=366 are verified by clicking them; the rest follow the same
spacing.

| y | Entry | After ENGLISH PLEASE |
|---|---|---|
| 222 | SPIEL STARTEN | START GAME |
| 258 | NETZWERKSPIEL | NETWORK MATCH |
| 294 | STATISTIK | STATISTICS |
| 330 | EINSTELLUNGEN | SETTINGS |
| 366 | ENGLISH PLEASE | DEUTSCH |
| 402 | ENDE | QUIT |

Clicking y=366 does swap the whole menu to English, which is a cheap way to
confirm both the click path and `text.pak` (all three `.pak` files are opened
at startup).

Timing at `--batch-size=200000`: menu art is up by batch ~480, the match starts
within ~100 batches of the click. `test/test-blobby-volley.js` reaches a live
match in 700 batches, about 16s wall on an idle box.

Frame colors, for pixel asserts: sand 167,154,83 · daylight sky ~60,98,235 ·
player-1 blobby 192,0,0 · player-2 blobby 0,192,0 · menu logo outline 54,44,247.
The menu backdrop is a night beach (mean luminance ~26), the court is daylight
(~115) — that difference alone distinguishes the two screens.

## Controls

There is no fixed control scheme — every player's device is chosen in the
settings screen, and the manuals never name a default key. Settings live in
`settings.dat`, which **this candidate folder does not ship**, so the game boots
on its built-ins. Read off the settings screen:

| | Player 1 (left, red) | Player 2 (right, green) |
|---|---|---|
| Name | ADAM | SPIELER 2 |
| Control | **COMP. (EASY)** | **MOUSE** |

That is why a freshly started match plays itself: player 1 is the computer, and
player 2 follows whatever the mouse does. Both halves of the mouse scheme are
verified against the running game:

- **Move** — the blobby tracks the pointer horizontally, clamped to its own half
  of the court. Pointer at x=601 puts its bounding box at x=588..637; pointer at
  x=381 (across the net) clamps it to x=482..532.
- **Left button** — jump. Bounding box goes from y=329..399 on the sand to
  y=258..313 in the air on mousedown, and back on landing.
- There is no separate hit control; the ball is played by touching it.

Other devices, from the settings screen: `CONTROL:` cycles mouse / keyboard /
computer (three difficulties), and `DEFINE KEYS...` holds the keyboard layout.
`SOUND: ON` is the third toggle. The `.pak` files also probe for a user-supplied
`bvbg.bmp` (800x600 custom backdrop, manual §4); it is absent here, as expected.

**`DEFINE KEYS...` hangs the emulator.** Clicking it (settings screen, y≈325)
sends T1 to 0x4159fc and the batch never returns. Reproduces every time with:

```
--input=500:mousemove:400:330,520:mousemove:401:331,560:mousedown:401:331,\
600:mouseup:401:331,800:mousemove:400:325,820:mousemove:401:326,\
860:mousedown:401:326,900:mouseup:401:326
```

What is established about it, so nobody re-derives it:

- **It is the worker, not the main thread.** With `--trace`, the main
  instance keeps stepping for ~5 more batches (861..865, all at 0x43d3ac, the
  VCL idle pump) and then everything stops. The main loop is blocked inside
  the worker's slice call.
- **It is stuck inside ONE WASM function, not executing guest code.** A native
  `sample` of the hung process puts 100% of samples in a tight loop whose leaf
  spans ~170 bytes of JIT code under a stable parent chain. Threaded dispatch
  executing guest instructions would show many different leaves.
- **It makes no host calls.** `--host-census=200000` prints nothing after the
  click, which is also why every other trace flag is blind here — they buffer
  and drain between batches.
- **It is NOT an oversized REP string op.** Instrumenting `th_rep_movsb`,
  `movsd`, `stosb`, `stosd`, `scasb` and `cmpsb` to log any `ECX > 0x1000000`
  showed exactly 7 hits, all `REPNE SCASB` with `ECX=0xFFFFFFFF`, all during
  startup, all completing normally — that is the ordinary `strlen` idiom
  (`mov ecx,-1; repne scasb`), not a runaway. None fire at the click.
- 0x4159fc itself is not the loop: it sits in a 6-byte fragment ending
  `call [ebx+0x30]; ret`, i.e. an indirect (VMT / event handler) call. The
  loop is downstream of that call.
- The last block EIPs flushed before the stall are varied ordinary Delphi RTL
  code ending at 0x402174, so the guest was running normally right up to it.
  Note the log buffer drains between batches, so these belong to the last
  *completed* batch, not to the hung one.

Next step: the remaining candidates are unbounded loops inside WAT helpers
reachable from a draw or dispatch path. The marker technique above is the way
to bisect them — `(if (i32.gt_u ...) (then (call $host_log_i32 ...)))` at the
top of a suspect loop, since `$host_log_i32` output does escape a hung batch
once the buffer fills.

## Regression coverage

`test/test-blobby-volley.js` (in `test/run-all.sh`, e2e tier), 9 checks: clean
exit, no unimplemented API, the VCL two-window startup, the decoded menu art and
logo, and — after the scripted click — daylight sky + sand shares and both
blobbies on court.

## Network match (NETZWERKSPIEL)

The whole DirectPlay lobby flow runs. `DPlayX.dll` is `LoadLibraryA`'d at
startup and `DirectPlayCreate` resolved from it by name, so nothing about this
path is visible in the import table.

Both branches of the menu reach their end state:

| Click path | Result |
|---|---|
| NETZWERKSPIEL → EIN SPIEL HOSTEN… → SPIEL BEGINNEN! | **WARTE AUF EINEN GAST…** — session open, host waiting |
| NETZWERKSPIEL → ALS GAST SPIELEN… → SPIELE SUCHEN | **GEFUNDENE SPIELE: LOCAL SESSION** — discovery lists a session |

Menu geometry, same 640x480 frame as the main menu:

| Screen | Entries (y) |
|---|---|
| MULTIPLAYER-OPTIONEN | host 290 · guest 322 · back 350 |
| HOST-EINSTELLUNGEN | name 268 · control 305 · **SPIEL BEGINNEN! 348** · back 390 |
| GAST-EINSTELLUNGEN | Host-IP 268 · control 305 · **SPIELE SUCHEN 350** · back 390 |

The COM sequence, read off `--trace-api` (worker-thread lines decode via the
`0xC0DE0000|api_id` marker):

- **Host:** `DirectPlayCreate` → `QueryInterface` → `InitializeConnection` →
  `Open` → `CreatePlayer`
- **Guest:** `DirectPlayCreate` → `QueryInterface` → `InitializeConnection` →
  `EnumSessions`

Two emulator fixes were needed, both in `src/09a7-handlers-dispatch.wat`:

1. **`DirectPlayCreate` popped 20 bytes for a 3-argument function.**
   `api_table.json` carried `nargs: 4`, and the real signature is
   `(lpGUIDSP, lplpDP, pUnk)`. Every call left the caller's stack 4 bytes
   short, which is why the app appeared to call it *seven times in a row* and
   then killed its own game thread (`T1 state=exited`) instead of showing an
   error. The seven calls were a retry loop plus stack drift, not a service-
   provider sweep. `nargs` lives in `tools/gen_api_table.js`, which **rewrites
   `src/api_table.json`** — editing the JSON alone is silently undone by the
   next generator run, and `tools/check-handler-esp.js` fails the build on the
   mismatch.
2. **`DirectPlayCreate` was a stub returning `E_FAIL`.** It now returns the
   same `DX_VTBL_DPLAY3` object that `CoCreateInstance(CLSID_DirectPlay)`
   already built, which is what unlocked everything above — `IDirectPlay3` was
   already implemented, the app just never got handed one.

`EnumSessions` fabricates a single session named "Local Session" and the guest
screen renders it, so discovery is cosmetic rather than real.

## Open

- **No traffic crosses between two processes yet.** `Open`/`CreatePlayer`
  succeed locally, `Send` returns `DP_OK` without sending, and `Receive`
  returns `DPERR_NOMESSAGES` — so a host and a guest cannot actually meet.
  Making them meet means carrying DirectPlay messages over the virtual LAN in
  `src/09d-winsock.wat` / `lib/vlan-wire.js` (TODOS item 4), which already
  joins two emulator processes into one room. The guest screen even offers a
  **Host-IP** field, which maps straight onto `--vlan-ip`.
- **Promotion out of `candidates/`.** `index.html` already launches it (option
  `blobby_volley`, with the three `.pak` files mounted) but the comment there
  keeps it "local and debug-only… until Blobby is ready for promotion". On the
  evidence above it is ready; the move needs an asset-layout decision, so it is
  left for whoever owns that.
- **Sound is unverified.** `sound.pak` is opened at startup but nothing checks
  that a sample ever reaches `waveOut*`.
- **The `DEFINE KEYS...` hang** described under Controls — a batch that never
  returns, entered from 0x4159fc. Unclaimed.
