# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Game initializes fully, renders table correctly, enters active PeekMessage game loop via proper WM_SETFOCUS delivery. Physics tick runs with flag poke for game-active/commands-enabled (attract mode state machine doesn't advance yet — callback slots at `[game_obj+0xf4..0x134]` stay empty). Ball deploys, flippers animate, score advances, missions trigger. Press Y for New Game, Space to plunge.

## Fix (2026-04-10): DestroyWindow focus transfer + remove pinball flag poke

**Problem:** Pinball creates a 1x1 splash window (hwnd 0x10001), calls `SetFocus(splash)`, then `DestroyWindow(splash)`. The main game window (0x10002) never received `WM_SETFOCUS` because:
1. `SetFocus` only delivered WM_SETFOCUS to WAT-native wndprocs, not x86 ones
2. `DestroyWindow` cleared `focus_hwnd` but didn't transfer focus to the promoted `main_hwnd`

**Fix (2 parts):**
- `SetFocus`: now delivers WM_SETFOCUS synchronously to x86 wndprocs via EIP redirect (same technique as ShowWindow → WM_SIZE)
- `DestroyWindow`: when the focused window is destroyed and `main_hwnd` is promoted to a different window, delivers WM_SETFOCUS to the new `main_hwnd` via EIP redirect

This sets `game_running=1` BEFORE the message pump function (`0x10082a9`) is entered, so it takes the PeekMessage path naturally. Removed the pinball-specific flag poke hack from PeekMessageA that hardcoded `wndproc_addr == 0x01055db1`.

**Remaining:** The `game-active` and `commands-enabled` flags still need the attract mode state machine to advance. The idle callback slots at `[game_obj+0xf4..0x134]` are all 0/-1 because the function that populates them (`0x0101df3d`, called via vtable from `0x01006c26`) is never reached. The WM_USER (0x400) PostMessage that would trigger it requires these callbacks to be non-null — chicken and egg. See "Attract Mode" section below.

**Also added:** `tools/find-refs.js` — cross-reference finder for PE binaries (call/jmp/jcc + data refs).

## Fix (2026-04-09): WM_SETFOCUS phase added to GetMessageA startup sequence

Found by reading the game wndproc dispatch (`0x01007a3e`):

- `01007ac7..01007ae3`: when `uMsg == WM_SETFOCUS (0x07)`, the game writes `[0x1024fec] = 1` and `[0x1024ff4] = 1` and runs three init calls.
- `01007bdf..01007bf0`: when `uMsg == WM_KILLFOCUS (0x08)`, it clears `[0x1024fec]`.

The outer game loop (`0x01008940`) checks `[0x1024fec]` and `[0x1024fd8]` to decide between two message-loop functions:
- `0x010082a9` — modal `GetMessageA`-only loop (used when `[0x1024fec] == 0`)
- inline peek loop at `0x010087c0..0x010087f3` — `PeekMessageA(PM_REMOVE)` polled with a 2-second `timeGetTime` budget (used when `[0x1024fec] != 0`)

Without ever receiving `WM_SETFOCUS`, the game stayed in the modal `GetMessageA` branch forever and the active gameplay code paths (`0x01004beb`+ inner functions, sprite blits, ball physics) were never reached.

Fix in `src/09a5-handlers-window.wat`: bumped the `$msg_phase` state machine from a 3-step (WM_ACTIVATE → WM_ERASEBKGND → WM_PAINT) startup sequence to a 4-step one with `WM_SETFOCUS (0x07)` inserted as phase 1. Phase indices renumbered 0..4. This matches what real Windows does: when a top-level window is shown and activated, it gets a focus message before its first paint.

### Verification

Before the fix (`--max-batches=10000`):
- 733 PeekMessageA calls (early attract burst), then 7637 GetMessageA calls (modal idle).
- ~61K API calls total.
- Final EIP `0x0100830f` — sitting in the modal message-loop function.

After the fix:
- 3026 PeekMessageA calls, only 2 GetMessageA calls.
- 8944 StretchDIBits calls (sprites animating continuously).
- ~76K API calls total.
- Final EIP `0x01004c02` — inside the inner game tick code (not the message loop).
- Watchpoint on `0x01024fec` confirms the flag flips 0→1 at batch 2372 (when WM_SETFOCUS gets dispatched).

Regression-checked notepad, calc, freecell, ski32 — all still reach clean exit.

## Flipper input chain works — render is the only failure (2026-04-09)

User reported flippers don't move. End-to-end trace with breakpoints + watchpoints proved every stage of the input → flipper-update path works:

| Stage | Verification |
|---|---|
| `check_input` returns Z | trace shows `msg=0x100 wParam=0x5a` |
| `PeekMessageA` yields it | `DispatchMessageA` API call with msg=0x100 wParam=0x5a |
| Wndproc `0x01007a3e` reached | `--break=0x01007d1a` (WM_KEYDOWN case) fires for Z |
| `process_key` `0x01015072` called | break fires for Z |
| Three early-exit gates pass | `[0x1024fd8]` and `[0x1025570]` watchpoints never fire (stay 0); `[0x1025568]` set to 1 at batch 292 by `set_game_state(1)` and never reverts |
| Flipper-key cmp at `0x010150bf` | hit with `esi=0x5a` |
| Match body at `0x010150c7` | reached — Z matches `[0x1028238]` (left-flipper key var, set to `0x5a` at batch 1759) |
| Vtable call `[0x1025658]->vtable[0](float, 1000)` at `0x010150de` | executes — game state advances (score 2000 → 3000 from bumper hits while ball is in play) |

So pinball receives the keypress, dispatches it, accepts it, calls the flipper method, and the ball physics responds. **The flipper sprite renders as missing/erased instead of rotated.** Confirmed by Gemini visual analysis of the snapshots in `scratch/f_*.png` / `scratch/run*.png`: every Z-held frame shows `flipper=missing/erased`. This is the same StretchDIBits sub-rect bug below — when pinball blits the rotated flipper sprite, the destination at the flipper coords gets overwritten but the source pixels read are stale, so the at-rest flipper is erased instead of being replaced with the rotated sprite.

### Test gotcha: ball must be plunged for flippers to react

`test/test-pinball-flipper.js` originally only sent F2 then Z. F2 starts a *game* but the table sits in "Awaiting Deployment" until the user holds Space to plunge the ball. The flipper game-state object's update path silently no-ops while there is no ball in play, so the test was indistinguishable from a broken input chain. Fixed: the test now sends `keydown:32 ... keyup:32` (VK_SPACE = plunger) between F2 and the Z press.

### Test gotcha: `test/run.js` `get_ticks` was wall-clock and non-deterministic

While debugging the plunger, three back-to-back runs of the same input sequence produced API counts 50561 / 48911 / 48311 / 50543 — the plunger sometimes deployed the ball, sometimes didn't, and `pinball.md`'s "rand loop ~30K iterations" termination drifted between runs. Root cause: `test/run.js` had

```js
const tickStart = Date.now();
h.get_ticks = () => ((tickStart + (Date.now() - tickStart) * 200) & 0x7FFFFFFF);
```

so simulated time was tied to host wall-clock through `Date.now()`. Each batch took a jittery amount of wall-time (GC, FS I/O, system load), so the simulated ms between API calls varied per run. A 500-batch Space hold gave pinball anywhere from a few hundred ms to several seconds of perceived plunger duration.

**Fix** (`test/run.js:340-345`): drive `get_ticks` from the batch counter, `tick = batch * 200`. Three back-to-back runs now produce identical 50543-API-call traces. Anything that uses `timeGetTime` / `GetTickCount` in CLI tests is now reproducible. (The browser/`lib/host-imports.js` path still uses `Date.now()`, which is fine — interactive sessions don't need determinism.)

## RESOLVED (2026-04-09): StretchDIBits sub-rect blits now work

Sub-rect blits produce identical output to SDB_FULL_BLIT. The rendering is correct.

## Fix (2026-04-10): Auto-set game flags in PeekMessageA startup

### Root cause: three-level chicken-and-egg

The game's main loop at `0x01008940` has a physics-tick path gated by `[0x1024fe0]` (game-active) and a WM_COMMAND path gated by `[0x1024ff8]` (commands-enabled). Detailed analysis found:

1. **Init state machine unreachable**: The handler at `0x0100e1b0` (which sets `[0x1025050]` → eventually sets `[0x1024ff8]`) is only called from `process_key` at `0x010150ba`. Without keyboard input, it never fires and the state stays at 0 (needs 30).

2. **Per-frame tick runs only once**: The tick at `0x010153ae` is throttled by a 300-iteration counter at `[ebp-0xf8]`. The counter decrement at `0x01008a78` is only reached through the physics tick path (`0x01008a2d`), which requires `[0x1024fe0]=1`. After the first tick, counter=300 and never decrements.

3. **New Game via 'Y' key, not F2**: The game-active toggle at `0x01007e03` (`cmp [0x1024fe0], esi; setz al`) requires `esi=0`. This is set in the WM_KEYDOWN handler at `0x01007d2d`. The cmd check at `0x01007dbd` matches `ebx=0x59` (VK_Y='Y'). F2 (`0x71`) goes to the per-frame tick wrapper at `0x01007976` instead.

4. **`strstr("-demo")` guards per-frame tick**: At `0x010087f3`, `strstr(cmd_line, "-demo")` determines whether to call the per-frame tick or a demo function. The variable at `[ebp-0xfc]` used as the haystack gets overwritten with a time delta at `0x0100885c`, but this only matters if the physics path runs.

### Fix

In `src/09a5-handlers-window.wat`, PeekMessageA's phase 1 (after WM_ACTIVATE delivery), when `$wndproc_addr == 0x01055db1` (pinball), write both flags:
- `[0x1024ff8] = 1` (commands-enabled) — allows Y key to toggle game-active
- `[0x1024fe0] = 1` (game-active) — enables per-frame tick counter decrement and physics

This replaces the previous `--input poke` workaround. CLI to start a game:
```
node test/run.js --exe=test/binaries/pinball/pinball.exe --stuck-after=5000
```
Then press Y to toggle New Game, Space to plunge ball.

### timeGetTime fix for physics tick timing

The physics tick at `0x01008a2a` compares two `timeGetTime()` results: one stored from the previous iteration and one fresh. If they're equal, it sleeps instead of ticking. Our deterministic `get_ticks = batch * 200` returned the same value for all calls within a batch. Fixed by adding a per-call counter: `get_ticks = batch * 200 + callsInBatch++`. This ensures consecutive timeGetTime calls within the same batch return different values.

### Flipper rendering chain (verified working)

The full flipper animation chain works when flags are set:

| Stage | Function | Status |
|---|---|---|
| Key input → flipper object | vtable[0] at 0x10159a9 | ✓ Works |
| Per-frame tick → table Message(0x3F6) | vtable[0] at 0x10187d6 | ✓ Works (with flag poke) |
| Physics tick → collision engine | 0x1014bf9 → 0x1014a68 | ✓ Works (with flag poke) |
| Flipper angle update → bitmap index | 0x10175aa → 0x01013c89 | ✓ Works |
| Sprite group render → CopyBits8 | 0x01013d2d → 0x01004870 | ✓ Works |
| StretchDIBits → screen | Sub-rect blits | ✓ Works |

### Key addresses

| Address | Purpose |
|---|---|
| `[0x1024fe0]` | Game-active flag (gates physics tick in main loop) |
| `[0x1024fec]` | Game-running flag (set by WM_SETFOCUS, gates PeekMessageA vs GetMessageA) |
| `[0x1024ff8]` | Commands-enabled flag (gates WM_COMMAND processing in wndproc) |
| `[0x1025050]` | Init state machine (needs to reach 30 to set 0x1024ff8) |
| `[0x1025658]` | Game table object (TPinballTable, vtable 0x01002790) |
| `0x01007a3e` | Game wndproc |
| `0x010082a9` | Inner PeekMessageA message pump |
| `0x01014bf9` | Physics tick function (takes time delta) |
| `0x10153ae` | Per-frame game tick (sends msg 0x3F6) |
| `0x01007dbd` | WM_COMMAND handler: cmd 0x59 (89) = New Game toggle |

## Previous investigation: StretchDIBits sub-rect blits (resolved)

After the WM_SETFOCUS fix above, pinball reaches active gameplay and issues ~8900 `StretchDIBits` calls per 10K batches. Investigation proved blits now work correctly:

### What we proved correct
- **Single source bitmap.** All 8934 calls use the same `bits=0x63020c`, `bmi=0x62fde4`, `biW=600 biH=416` (bottom-up), `bpp=8`, `colorUse=DIB_PAL_COLORS`, `pal2`. Same `rop=SRCCOPY`. Same window DC `hdc=0x50002`. No `BitBlt`/`CreateDIBSection`/secondary DC anywhere.
- **Source decode is correct.** When we re-decode the entire 600×416 source DIB from WASM memory, the resulting image is recognizable: at startup it's the bare table backdrop; later snapshots show pinball CPU-composing extra content into it ("Player 1", "Awaiting Deployment", score digits, ball graphics) at their visible screen positions. So the source pointer is right, the bottom-up Y handling is right, the palette (mirrored at WASM 0x6020 by `SelectPalette`) is right.
- **The pixel buffer that the per-blit code generates is correct.** Dumping the per-call `pixels` array for the first 30 sub-rect blits gives recognizable sprites: "BALL 1" at 165×44, the "3D Pinball Space Cadet" header at 165×88, individual purple/orange/blue bumper sprites at 21×21, etc.
- **Forcing every blit to copy the entire 600×416 buffer renders correctly.** Added `SDB_FULL_BLIT=1` env override in `lib/host-imports.js` (gdi_stretch_dib_bits) that, after the normal sub-rect draw, additionally re-blits the whole back-buffer to the window canvas. With this on, the screen looks correct end-to-end (table + score panel text + sprites). With it off, only the table backdrop is right and everything else is mangled.

### Diagnostic infrastructure added
- `test/run.js --dump-sdb=DIR` (new flag) — writes one PNG per call's source sub-rect (`sdb_subrect_NNN_srcXxY_WxH_dstXxY.png`), full-DIB snapshots at call indices `[0, 1, 5, 6, 100, 1000, 5000]` (`sdb_*_at<N>.png`), and a `calls.log` with every blit's parameters. Implemented in `lib/host-imports.js` `gdi_stretch_dib_bits` under `if (ctx.dumpSdb)`.
- `test/run.js --png=...` now ALSO dumps each window's `_backCanvas` to `<png>_back_<hwnd>.png` so we can see the offscreen canvas independent of the compositor.
- `SDB_FULL_BLIT=1` env var — debug-only override that overpaints the full back-buffer on every StretchDIBits call. Useful for confirming "is the bug in the small blits or in pixel decoding".
- `SDB_DEBUG=1` env var — logs `bmi/bits/biW/biH/bpp/rowBytes/src/dst/canvas` for the first 12 blits.

### What's still wrong
With `SDB_FULL_BLIT` off, dumping `_backCanvas` directly (bypassing the compositor) shows:
- Table backdrop is laid down correctly (from the 2 startup full-screen blits at calls #4/#5).
- Right-side score panel area shows TWO stacked copies of the static "Space Cadet" panel, not the live score/text.
- General visible content matches what you'd get if many sub-rect blits were copying *static portions of the source DIB* rather than the *current sprite content* pinball is supposed to have written into those positions.

So the sub-rect blits ARE landing in `_backCanvas` (no canvas-clearing bug, no compositor bug), but they're reading **stale or wrong source pixels** at the moment of the blit — even though the snapshot we take at higher call indices clearly shows pinball does eventually write the right content into the buffer.

### Top theories (untested)
1. **Pinball uses two buffers and we're conflating them.** The `bits` pointer in StretchDIBits points to a sprite-cell scratch buffer; pinball CPU-renders the visible game state into a *different* framebuffer (which is what our snapshots are picking up because both addresses happen to land in the same WASM memory range). Need to add a heap-trace to see what allocator returns 0x63020c and whether pinball touches another nearby allocation.
2. **Address-translation skew between CPU writes and StretchDIBits reads.** Pinball's CPU writes go through one address translation, our `gdi_stretch_dib_bits` reads through `g2w`-translated `bitsWA`. If the two land at different WASM offsets we'd read stale-ish bytes that drift over time.
3. **`hdc=0x50002` isn't actually the window DC.** If our `_getDrawTarget` resolves it to the wrong target (e.g., a memory DC selected into something), the sub-rect blits paint to the right canvas but pinball *thinks* it painted somewhere else and never re-issues them. Less likely because the SDB_FULL_BLIT override hits the same `t.ctx` and looks correct.

### Observed sub-rect call pattern
First 12 calls (from `--dump-sdb` log):
```
#0  src=(553,242 15x22)  dst=(553,152 15x22)
#1  src=(403,197 15x22)  dst=(403,197 15x22)   ← src == dst
#2  src=(405,133 165x44) dst=(405,239 165x44)  ← src != dst, large rect
#3  src=(405,25  165x88) dst=(405,303 165x88)  ← src != dst, large rect
#4  src=(0,0    600x416) dst=(0,0   600x416)   ← full-screen
#5  src=(0,0    600x416) dst=(0,0   600x416)   ← full-screen
#6  src=(51,166  21x21)  dst=(51,229 21x21)
#7  src=(41,190  21x20)  dst=(41,206 21x20)
...
```
Mix of identity blits and src≠dst blits. Whatever architecture pinball is using, it's NOT a simple "compose at final coords + push changed regions" — there's at least one level of scratch-cell indirection, which is why the source DIB position read for a blit is *not* the visible-screen position pinball expects to update.

### Files touched in this investigation
- `lib/host-imports.js` — `gdi_stretch_dib_bits`: added `--dump-sdb` instrumentation, `SDB_DEBUG`/`SDB_FULL_BLIT` env hooks, fixed `SelectPalette` to mirror palette index at WASM 0x6020 so DIB_PAL_COLORS resolves the right table per blit.
- `src/09a-handlers.wat` — `$handle_SelectPalette` writes resolved palette index (0..3) to memory 0x6020.
- `test/run.js` — `--dump-sdb=DIR` flag, `_backCanvas` dump alongside `--png`.

### Next steps to try
1. Heap-trace to identify what allocator returns the 0x63020c region and whether pinball calls it once or twice (single buffer vs two buffers theory).
2. Add a memory watchpoint on a few bytes inside 0x63020c+(553*600+242) (the source position of blit #0) and see whether pinball CPU-writes to that exact address before blit #0 fires. If yes, our address translation is fine and the bug is elsewhere. If no, pinball is writing somewhere else and we're reading the wrong place.
3. If theories 1-2 don't pan out, hand-disasm the pinball routine that calls StretchDIBits (the EIP at the time of the call; visible in the trace) to see where it gets `lpBits` and `xSrc/ySrc` from.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads/writes from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
- MapVirtualKeyA scan (0x00–0xFF keyboard mapping)
- Window class registration + CreateWindowExA (640x480 main window)
- **WM_CREATE delivered to pinball's game WndProc**
- **Nested CreateWindowExA**: 4 windows created during init
- CreatePalette, SelectPalette, RealizePalette — palette stored in WASM memory
- GetDesktopWindow, GetWindowRect, SetCursor
- WaveMix initialization: wavemix.inf loaded via CreateFileA/fopen
- waveOutGetDevCapsA, waveOutGetNumDevs, waveOutOpen, waveOutPrepareHeader — audio device enumeration + init
- **PINBALL.DAT fully loaded** — table data parsed, structures initialized
- **WAV sound files loaded** — mmioOpenA/mmioDescend/mmioRead/mmioAscend/mmioClose fully implemented
- **ShowWindow + UpdateWindow for main game window (hwnd=0x10002)**
- **Game loop reached** — PeekMessageA polling active
- **StretchDIBits rendering** — game draws sprites and table elements
- **Clean exit** — ExitProcess(0) after game loop

## Fixes Applied (This Session — mmio + heap_free guard)

1. **mmioOpenA real implementation** (`09a3-handlers-audio.wat`): Previously returned 0 (failure stub). Now opens WAV files via `host_fs_create_file`, returning a real file handle. Supports MMIO_READ and MMIO_CREATE flags.

2. **mmioDescend real implementation** (`09a3-handlers-audio.wat`): Previously returned MMIOERR_CHUNKNOTFOUND. Now properly parses RIFF/LIST chunk headers, reads 8-byte chunk header (ckid + cksize), handles RIFF/LIST fccType reading, supports MMIO_FINDCHUNK/MMIO_FINDRIFF/MMIO_FINDLIST search flags, fills MMCKINFO struct (ckid, cksize, fccType, dwDataOffset, dwFlags).

3. **mmioRead real implementation** (`09a3-handlers-audio.wat`): Previously returned 0. Now reads bytes via `host_fs_read_file`, returns actual bytes read.

4. **mmioAscend real implementation** (`09a3-handlers-audio.wat`): Previously was a no-op. Now seeks past remaining chunk data (word-aligned) using `host_fs_set_file_pointer`.

5. **mmioClose real implementation** (`09a3-handlers-audio.wat`): Previously was a no-op. Now calls `host_fs_close_handle`.

6. **heap_free guard for non-heap addresses** (`10-helpers.wat`): The root cause of the previous crash (HeapReAlloc with corrupted pointer 0x2c2c2c28). msvcrt's Small Block Heap (sbh) manages small allocations (<1KB) internally. When sbh-managed blocks were freed through our HeapFree thunk, `heap_free` would add these foreign addresses (below 0x01D12000) to our free list, corrupting it. Later `heap_alloc` would return these non-heap addresses, leading to cascading corruption. Fix: `heap_free` now silently ignores addresses below `0x01D12000` (our heap base).

7. **msvcrt sbh_threshold patch** (`dll-loader.js`): After DllMain, finds `_set_sbh_threshold` export in msvcrt, extracts `__sbh_threshold` variable address from its code, and sets it to 0 to prevent new sbh allocations. Combined with the heap_free guard, this prevents all sbh-related corruption.

## Previous Fixes (Summary)

- _lread/_hread double g2w fix
- _initterm double g2w fix
- SEH trylevel update double g2w fix
- CACA0001 nested CreateWindowExA stack-based return
- DestroyWindow main_hwnd promotion
- CREATESTRUCT address fix for non-0x400000 imageBase
- StretchDIBits implementation (host import + JS renderer)
- VFS pre-loading of companion files
- Class table expanded (16→32 slots)
- Palette APIs, WINMM audio APIs

## Current State

Title screen renders correctly (table bitmap, palette, menu chrome) in both CLI and browser. F2 (New Game) is received and game state advances (1 ball → 2 balls in score panel), but no physics/animation: ball can't bounce because the wall collision data fails to load for 4 visuals.

Blocker: **`# walls doesn't match data size`** fires 4× during PINBALL.DAT loading from a `loader_query_visual()` context. File reads return correct byte counts — the bug is somewhere subtler (struct size mismatch, alignment, or arithmetic on values read from the file).

### Re-verification (2026-04-09): wall-error path is NOT exercised in current CLI run

Re-ran CLI baseline (`node test/run.js --exe=test/binaries/pinball/pinball.exe --max-batches=10000 --stuck-after=5000`). Findings that contradict the notes above:

- **Zero MessageBoxA calls.** Filtered the entire `--trace-api` log: no "walls doesn't match data size" fires.
- **`loader_query_visual` (0x0100950c) is never reached.** `--break=0x0100950c` → no hit in 10K batches.
- **`loader::loadfrom` root (0x01015426) is never reached.** `--break=0x01015426` → no hit either.
- **Wall-loader sub-call (0x01009349) and the count-mismatch site (0x0100974f) both never hit.**

So whatever path was producing the 4 wall errors in the previous session is no longer being executed at all. PINBALL.DAT *is* still being opened (CreateFileA + many `_lopen`/`_lread` calls trace through), but via a different loader entry that does not call `loader_query_visual`. The "wall validation" investigation in the sections below is operating on a code path the runtime no longer enters — chase this with fresh instrumentation before trusting any of the prior conclusions.

### New blocker (2026-04-09): game switches from PeekMessageA loop to GetMessageA modal loop

Trace shape after the title screen renders:

1. PeekMessageA polling loop runs from API #25013..#27263 (~750 polls — this is the active game loop).
2. At #27266 the game calls `EnableMenuItem(menu=0x80001, id=0x67)`, `EnableMenuItem(id=0x191)`, `CheckMenuItem(id=0x194)` — game-state menu sync, suggesting it just left an attract/intro state.
3. Several rounds of `GetDC → SelectPalette → RealizePalette → StretchDIBits → ReleaseDC` paint sprites (score panel digits).
4. Then a long, hot loop calls `GetLastError → TlsGetValue → SetLastError` ~30 000 times. The code site is `0x0100a482..0x0100a4d4`:
   ```
   0100a482  mov ebx, [0x1001304]   ; IAT slot — almost certainly msvcrt!rand
   0100a488  call ebx               ; rand()
   0100a48a  push 0x64; cdq; pop ecx; idiv ecx   ; eax % 100
   0100a490  cmp edx, 0x46          ; <= 70 ? skip : do FPU branch
   ...
   0100a4a3  call ebx               ; rand() again on the "do" branch
   0100a4d1  dec [ebp-0xc]; jnz 0x100a482   ; loop counter
   0100a4d6  jmp 0x100a297          ; outer loop continuation
   ```
   The `db 0xdb 45 ec` / `db 0xdc` bytes the disassembler is choking on are FPU ops (`fild`/`fmul` etc.), so this loop is the game's randomized sound/animation pump. Each `call rand` expands to the GetLastError/TlsGetValue/SetLastError triple because msvcrt's `rand` touches `_errno`. Not necessarily wrong, but it's where the run spends most of its budget.
5. Once the rand loop exits, pinball receives `WM_ACTIVATE` (DefWindowProcA msg=0x06 wParam=1), does one BeginPaint/EndPaint, and **switches to `GetMessageA` blocking loop** (#27810 onward, 7 600+ calls). It never returns to PeekMessageA.

`GetMessageA` instead of `PeekMessageA` means the game's main loop branch decided "not currently running" and is now blocked waiting for input. In CLI we never deliver any, so it sits forever. This is the *current* blocker, not the wall-loader. To make progress: figure out what set the "not running" flag during the menu-sync transition (#27266) and whether the rand loop is supposed to terminate via a different exit (it currently runs ~30 K iterations before falling through).

Suggested next steps:
- Re-verify in browser whether the title screen still renders the same way and whether F2 → game start still works there. The browser path may behave differently because input is delivered.
- Instrument `EnableMenuItem` / `CheckMenuItem` callers around #27266 to find which game-state setter ran. The id 0x191 = 401 is a menu cmd, not a wall tag — coincidence.
- Add a one-shot host log around eip 0x0100a297 (outer loop head) to confirm the rand loop exits cleanly and to count outer iterations.
- Inject `WM_KEYDOWN VK_F2` *after* the GetMessageA loop is reached and see if the game can start from there (CLI input injection at a fixed batch via `--input=`).

### Version-mismatch hypothesis DISPROVED (2026-04-08)

Staged the original Microsoft Plus! 95 (1996) version under `test/binaries/pinball-plus95/` from `https://archive.org/details/SpaceCadet_Plus95`. This is a fully matched 1996 exe + DAT pair (different content from the XP set: PINBALL.EXE 351,744 vs 281,088, PINBALL.DAT same 928,700 size but different bytes). After implementing trivial stubs for `GetProcessAffinityMask` and `SetThreadAffinityMask` (Plus! 95's older statically-linked CRT calls them during init), the Plus! 95 build runs and **hits the exact same `# walls doesn't match data size` error from `loader_query_visual()`** — 5 occurrences instead of XP's 4.

**Conclusion:** Two independent Microsoft pinball binaries (1996 and 2008), each with their own matched DAT, fail in the same wall-loader. The bug is in our emulator, not in any version skew. The previous "tags 407/408 unhandled" theory is wrong — Plus! 95 binary almost certainly handles different tag ranges than XP's, yet still fails. Focus future investigation on emulator-side bugs in the FPU path or integer arithmetic used by the wall sub-loader at `0x01009349` (XP) / equivalent in Plus! 95.

### msvcrt `floor` traced (this session)

Hand-decoded `msvcrt.dll!floor` (file 0x2c7a1, RVA 0x2b7a1, default load 0x7802b7a1) — the disasm tool was mangling FPU bytes so I read raw bytes:

- `floor()` prologue: saves FPU CW, calls a helper that does `fnstcw + or RC=01 + fldcw` (sets round-down mode)
- Loads input via `fld qword [ebp+8]`, checks high word for NaN/Inf via `and ax, 0x7ff0; cmp ax, 0x7ff0`
- Normal path: `call 0x7802e20e` — and **this helper is exactly**:
  ```
  7802e20e  55              push ebp
  7802e20f  8b ec           mov ebp, esp
  7802e211  51 51           push ecx; push ecx     ; reserve [ebp-8]
  7802e213  dd 45 08        fld qword [ebp+8]
  7802e216  d9 fc           frndint                ; ← rounds per current CW
  7802e218  dd 5d f8        fstp qword [ebp-8]
  7802e21b  dd 45 f8        fld qword [ebp-8]
  7802e21e  c9              leave
  7802e21f  c3              ret
  ```

So `floor()` **does** depend on `frndint` honoring the FPU control word's RC bits — which is exactly the bug I fixed in `06-fpu.wat`.

Verified the fix is being exercised: instrumented `$fpu_round` with `host_log_i32` to log `(fpu_cw, value*1000)`. Saw consistent CW = `0x173F` (RC = 01 = round-down) and many distinct values flowing through. All tag-range floats appearing in `floor` inputs are exact integers: 401.0, 402.0, 403.0, 404.0, 405.0, 406.0, **407.0**, **408.0**.

**New mystery**: the wall sub-loader at `0x01009349` only handles tags `0x191..0x196` (401..406). Tags 407 and 408 fall through the `dec eax` chain to the unknown-tag error path at `0x01009478`. But:
- 407 appears in `floor` inputs as early as batch ~752 (before the first wall error at batch 755)
- 4 wall errors fire total but values 401-407 appear repeatedly throughout the run
- So either 407 is being processed by a *different* function (one of the 44 `floor` call sites in pinball.exe, not just the wall sub-loader), or our pinball.exe simply doesn't handle tags 407/408 at all and the failing visuals contain them

The fix to `frndint` is **correct** but **does not** resolve pinball — `floor` was already working correctly in our emulator for integer-valued floats (which it produces correctly with any rounding mode). The wall errors have a different root cause: probably pinball.exe + PINBALL.DAT version mismatch where the data uses tags 407/408 not in the binary's switch table, OR there's a different code path that handles 407+ via a function I haven't yet identified.

### FPU `frndint` correctness fix (this session)

While investigating the wall hypothesis, found and fixed a real x87 bug in `src/06-fpu.wat`: `frndint` (`D9 FC`) was hardcoded to `f64.nearest`, ignoring the FPU control word's RC bits. Added a `$fpu_round` helper that switches on `(fpu_cw >> 10) & 3` → `f64.nearest` / `f64.floor` / `f64.ceil` / `f64.trunc`, and routed `frndint` through it. **This is a correctness fix but did NOT resolve the pinball wall errors** — msvcrt's `floor()` evidently doesn't reach `frndint` in our run, so the wall-decode failure has another root cause (still TBD; see below). `fistp` paths still use `i32.trunc_sat_f64_s` unconditionally; that's correct for `_ftol` (which sets RC=11 truncate before calling) but wrong for direct `fist`/`fistp` from generic code. Left for a follow-up.

### Wall error site is a SHARED CALL — not the JZ fall-through (2026-04-08)

Spent a session chasing a phantom decoder bug. Decisive instrumentation:

- Hooked `$th_jcc` to log the JZ at `0x010095fa`. It fires **112 times, taken every single time**. The fall-through path to `0x01009600` (`push 0x12; push 0x0e; call 0x01008f7a`) is **never executed in our run**.
- Hooked the `$run` loop to log eip transitions into `0x01009604`. The 4 wall-error fires all come from `prev_eip = 0x0100974f`.
- Disasm of `0x0100974f`:
  ```
  0100973c  cmp ax, 0x1
  01009740  jnz short 0x1009747
  01009742  mov [edi+0x8], ebx
  01009745  jmp short 0x1009727        ; success
  01009747  movsx eax, ax
  0100974a  cmp eax, [edi+0x8]
  0100974d  jz short 0x1009727         ; success
  0100974f  push 0x12
  01009751  push 0x8                   ; ← msg_id=8 = "# walls doesn't match data size"
  01009753  jmp 0x1009604              ; jumps INTO the previous error_reporter call site
  ```
- The compiler emitted a JMP into the middle of the previous (`0x01009600..0x01009609`) error sequence, **reusing only its `call 0x01008f7a; jmp 0x0100972c` tail**. So the disasm of `0x01009600` (`push 0x12; push 0x0e`) is the source-level error site for tag 400, but the **runtime error site is `0x0100974f`** with msg_id=8 (a count-mismatch check unrelated to the tag-400 path).
- Earlier "msg_id mismatch" finding (push trace showed `last_push0=8, last_push1=0x12`) was correct — those are pushed at `0x0100974f-51` by the shared-call site. There is no decoder bug. The decoder, cache, JCC fall-through, and call_rel emit are all correct.

So the **real bug** is in the count-mismatch check at `0x0100974a`: `eax (movsx ax)` does not equal `[edi+8]`. One side is wrong.

Context for `[edi+8]` and `ax`:
- The block lives in some loader function around `0x010096a4..0x01009753`. It calls `0x0100905b` (a sub-loader) at `0x01009612` and processes results in a loop that ends at `0x0100971b: test ax, ax / jnz 0x0100973c`.
- `[edi+8]` is the **expected wall count** stored on the visual record by an earlier code path.
- `ax` is the **actual count** returned/computed somewhere.
- They mismatch in 4 visuals.

**Next investigation step**: instrument around `0x0100974a` to log `eax` and `[edi+8]` for each of the 4 failures, then trace back which load wrote each side wrong. The previous wall sub-loader (`0x01009349`) is **not** the failing function — it returns success on this path; the failure is in a different sub-loader (probably `0x0100905b`) or the count comparison itself.

### Investigation so far (wall validation)

- All 4 MessageBoxA calls share return address `0x01008fd2` → single error-reporter helper at `0x01008f7a`. The helper does `or eax, -1` before returning, so it always returns -1 to its caller.
- Disasm of helper confirms it takes `(msg_id, caption_id)`, looks up text/caption pointers in a table at `0x010235f8` (entries `{key, ptr}` terminated by negative key). Caption=0x12 maps to "loader_query_visual()".
- Disasm of `loader::query_visual` at `0x0100950c`: it's a switch on visual-tag values read as 16-bit words from `[esi]`. Cases for tags 100, 300, 304, 400, 406. The case for **tag 400 (`0x190` = RECTLIST)** is the only place that pushes `(msg_id=0xe, caption=0x12)`:
  ```
  010095eb  lea eax, [edi+0x14]      ; &visual->walls
  010095ee  push eax
  010095ef  movsx eax, word [esi]    ; sub-visual index
  010095f2  push eax
  010095f3  call 0x1009349           ; sub-loader
  010095f8  test eax, eax
  010095fa  jz .ok
  01009600  push 0x12; push 0x0e     ; "# walls doesn't match data size"
  01009604  call 0x1008f7a
  ```
- **Sub-loader `0x01009349`** (~250 bytes): Loads two group-data blobs by index — type-0 (must start with `word 0x190`) and type-0xb (a list of records). Each record's tag is decoded as: `fld dword [esi]; sub esp,8; fstp qword [esp]; call [floor]; call _ftol; movsx eax, ax`. So tags are stored as **single-precision floats** (e.g. 401.0..406.0) and converted via msvcrt's `floor` + `_ftol`. Switch jumps on tags `0x191..0x196`; unknown → inner error path which **also** calls the same helper (caption 0x14, msg_id varies).
- **Mystery**: Trace shows exactly **4** MessageBoxA calls, all caption=0x010017ec, all msg_id=0xe (text "# walls doesn't match data size"). Inner error paths in `0x01009349` should fire MessageBox with caption=0x14 BEFORE the outer fires with 0x12, but no such inner messages are observed. So either: (a) the inner function returns -1 via some path I haven't found that doesn't fire MessageBox; (b) the table lookup degenerates and the helper's caption arg actually maps both 0x12 and 0x14 to the same pointer 0x010017ec, hiding the inner errors as duplicates of the outer text — but text is selected by msg_id and only id=0xe gives "walls doesn't match"; (c) some path I'm not seeing.
- `--break` is unreliable here: it only fires at WASM batch boundaries, so most in-block addresses report "0 hits" even when executed. This invalidated my earlier confidence in "inner error sites are not hit". Need a different debugging mechanism (host_log injection or deeper instrumentation) to actually trace the path through `0x01009349`.
- EBP chain (12 deep) from each MessageBoxA call shows 3 distinct loader entry points hitting it:
  - `0x01017c6f` — 1× failure (first)
  - `0x010190b5` — 3× failures, via `0x0101c59f` / `0x01019bd7` / `0x0101a2d1` (different visual-loader sub-paths)
  - All under `0x0101aaf5` → `0x01015426` (loader-root, likely `loader::loadfrom`)
- Tooling improvement: `test/run.js` `--trace-api` now prints MessageBoxA return address + 12-deep EBP frame chain. This is what made it possible to localize the failures in one run.

### Next Steps
1. **Trace the actual path through `0x01009349`** — `--break` is unreliable for in-block addresses; need either (a) `$host_log_i32` injection at the inner function's tag-switch, (b) a temporary x87-op trace in `06-fpu.wat` to log values returned by `floor`/`_ftol` during PINBALL.DAT loading, or (c) a `--trace-block` mode in run.js that logs every block-decode boundary by EIP.
2. **Verify `getGroup_data` returns the right pointer** for the failing indices — could be a PINBALL.DAT parsing issue rather than FPU. The data format ("PARTOUT(4.0)RESOURCE.3D-Pinball" header) needs to be cross-referenced with the SpaceCadetPinball decomp.
3. **Cross-reference msvcrt `floor` disassembly** — the disasm tool mangles FPU opcodes; need to hand-decode the bytes at `msvcrt.dll!floor` (file offset 0x2c7a1, RVA 0x2b7a1, runtime VA depends on load) to confirm whether it actually uses `frndint` or some other mechanism. `_ftol` is already confirmed to be `fstcw + or RC=11 + fldcw + fistp m64 + restore`, which works correctly with our truncate-always `fistp`.
2. **STUCK detection default** — Pinball has a long row-by-row blit loop at `0x010048c2` (~0xCB × 0x18A bytes) that false-trips `--stuck-after=10`. Need `--stuck-after=2000` and ~5000 batches to reach the message loop now. Bump default, or count instructions instead of batches.
3. **Perf regression?** — `pinball.md` previously said "~54K API calls across 500 batches"; current run needs ~5000 batches for ~45K calls. Worth investigating whether init genuinely got longer or block-cache/decoder regressed.
4. **Sound playback** — WAV files loaded but `waveOutWrite` just marks buffers done. Could add Web Audio playback.
5. **Input handling** — Mouse/keyboard events past F2 need to reach the game's PeekMessageA loop reliably.

## Attract Mode State Machine (open investigation)

The attract mode requires a chain of callbacks to advance the init state to 30, which sets `commands-enabled`, which lets the Y key set `game-active`, which enables the physics counter decrement. Currently the game works because of flag pokes, but the natural attract mode path is broken.

### Key data structures
| Address | Name | Value at runtime |
|---------|------|-----------------|
| `[0x1025798]` | game object ptr | `0x0151dec4` (set during init) |
| `[0x1027be0]` | game obj copy (timer dispatch) | same ptr |
| `[0x1027bec]` | timer linked list head | 0 (always empty) |
| `[game+0xf4..0x134]` | 16 idle callback slots | all 0 or -1 |
| `[game+0x1a4]` | pending-work flag | 0 |
| `[0x102506c]` / `[0x1025070]` | primary object array / count | 1 object |
| `[0x1025084]` / `[0x10250b4]` | secondary object array / count | 195 objects |

### Timer dispatch flow (`0x1006bb8` → `0x101dd5d`)
Called every main loop iteration regardless of game-active:
1. Walk timer linked list at `[0x1027bec]` — execute due callbacks via PostMessageA(0x3BD)
2. If list empty AND `[game+0x1a4]==0`: scan idle callback slots `[game+0xf4..0x134]`
3. If any slot is non-null/non-(-1): PostMessageA(hwnd, WM_USER, *, game_obj)
4. WM_USER in wndproc calls `0x01009896` → `0x01006c26` → `0x0101df3d` (populate slots)
5. **Chicken-and-egg**: step 4 populates the slots that step 3 needs to fire step 4

### Call chain to populate slots
```
0x0101df3d  — writes object ptrs into [game+0xf4+i*4] at 0x101e21d/0x101e24e
  ↑ called from 0x01006c24 (attract mode dispatch, stdcall(6))
  ↑ called from 0x010098b6 (small wrapper, via vtable)
  ↑ called via WM_USER dispatch in wndproc
  ↑ posted by timer dispatch idle check at 0x0101dd3c
  ↑ needs [game+0xf4] to be non-null to fire the PostMessage ← STUCK HERE
```

### How to advance
The slots at `[game+0xf4]` should be set during table initialization (PINBALL.DAT loading). The game object is allocated at `0x1020ed1` with slots initialized to -1 (`rep stosd`). Something in the table loader should write real object pointers there, but it doesn't happen.

**Open questions:**
1. Does `0x1020ed1` (game object alloc) set up the initial callback? Disasm shows it fills with -1, then what?
2. Is the game object's "new game" function supposed to write the first callback? On real Windows, the attract mode might be triggered by a menu command or timer that we're not delivering.
3. Could a missing `WM_COMMAND` (e.g. ID_NEW_GAME from the menu accelerator) be the trigger that starts attract mode?

## Architecture Notes

- Pinball imports from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- **Game WndProc (0x01007a3e)**: Large message dispatch. WM_CREATE does table init.
- Game uses PeekMessageA(PM_REMOVE) + timeGetTime polling game loop
- Table data in proprietary PINBALL.DAT format (928KB)
- Audio via WaveMix library (wavemix.inf config, waveOut* APIs, mmio* for WAV loading)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`
- **Init flow**: WinMain → RegisterClassA → CreateWindowExA (frame) → CreateWindowExA (game) → WM_CREATE → table init → PINBALL.DAT load → WAV load → ShowWindow → DestroyWindow(frame) → PeekMessageA game loop

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004
