# RollerCoaster Tycoon (shareware/demo)

`test/binaries/shareware/rct/English/RCT.exe` — Chris Sawyer / Hasbro Interactive,
1999. App id `rct`. Image base `0x00400000`, entry `0x00412d80`; the whole game is
one EXE with no shipped DLLs, so every address below is both an original and a
runtime VA and needs no `module+0x` arithmetic.

The registry entry (`lib/apps.js`, `rctFiles`) mounts the tree from
`test/binaries/shareware/rct/`: `Data/` (CSG1/CSG1I plus CSS1–CSS17, `GAME.CFG`,
`TUTORIAL.DAT`, `KANJI.DAT`, `MP.DAT`), `Scenarios/` (`SC.IDX` and ten `*.SC4`),
`Tracks/`, `Saved Games/`. **The VFS has never been the problem** — an earlier
note calling RCT "VFS-blocked" was wrong, and `--trace-fs` shows every file it
asks for resolving on the first try.

## Status (2026-09-01): reaches the title screen

```
timeout -s KILL 250 node test/run.js --app=rct --quiet-api \
  --batch-size=200000 --max-batches=20000 --max-seconds=90 \
  --no-close --png=/tmp/rct.png
```

A healthy capture is the animated demo park: the RollerCoaster Tycoon logo top
right, wooden and steel coasters over a pine forest, and the four-button menu
bar along the bottom. `--dx-surfaces` reports the primary (640x480x8) with
~108 distinct colours; a broken run reports `colors=1 nonZero=0`.

**`--batch-size=200000` is not optional.** At the default budget the game is
still decoding `Scenarios/*.SC4` after 20000 batches and has drawn nothing, which
reads exactly like a hang. It scans the scenario directory at startup, opening
and decoding each `.SC4` in 1KB `ReadFile` chunks before it will show a menu.

## The two bugs that were in the way

### 1. `DPLAYX` ordinals were answered with DirectSound ids (fixed)

RCT imports `DPLAYX.dll` **by ordinal only** (`tools/pe-imports.js` shows
`[0] ordinal 1`, `[1] ordinal 2`), and the stub at `0x0041b08e` is
`jmp [0x55e034]` — inside DPLAYX's IAT at RVA `0x15e030`, *not* DSOUND's at
`0x15e03c`. `$system_ordinal_api_id` in `src/08b-dll-loader.wat` gated its DSOUND
rule on `$guest_name_is_static_system_dll == 4`, but that helper returns a
**1-based** position into `ole32/user32/comctl32/dplayx/ddraw/dsound/d3drm`, where
dplayx is 4 and dsound is 6. So every dplayx ordinal was resolved as a
DirectSound API and the DSOUND rule never fired at all.

RCT's ordinal 2 is `DirectPlayEnumerateA`, whose callback is
`(LPGUID, LPSTR, DWORD major, DWORD minor, LPVOID ctx)` and ends `ret 0x14` at
`0x004107b2`. Our `DirectSoundEnumerateA` handler pushes four arguments, so the
callback popped one dword too many and the guest returned to **EIP 0** after
11 batches, with `dbg_prev_eip=0x004107b2`. The callback itself is at
`0x00410710` (allocates a 0x10c-byte provider record, stores the GUID at +0 and
`strcpy`s the name to +4, links it at `[0x56306c]`/`[0x563070]`).

`test/test-directsound-ordinals.js` was already failing at HEAD on the DSOUND
half of this and now covers both DLLs.

### 2. `RICHEDIT_FORMAT_TABLE` was allocated on top of `MM_TIMER_TABLE` (fixed)

RCT drives its entire game loop from one multimedia timer:
`timeSetEvent(50, 10, 0x0040c7a6, 0, TIME_PERIODIC)` at `0x0040d269`, called from
`0x0045231d`. `MM_TIMER_TABLE` and `MM_TIMER_NEXT_ID` were raw
`(i32.const 0x00010800)` / `0x000108C0` in `src/01-header.wat`, in no region at
all — and the WATX allocator, which only knows about declared regions, had put
the 1KB `RICHEDIT_FORMAT_TABLE` region at exactly `0x00010800`.

The first `CreateDialog` with controls therefore wrote hwnd-slot zeroes over
timer slot 0's **interval** (`+4`) and **callback** (`+8`) while leaving its id
(`+0`) and last-tick (`+16`) intact. A zero interval reads as "always due" and a
zero callback makes `DispatchMessageA` decline the message, so the pump filled
with `MM_TIMER` (`0x7FF0`, hwnd 0, wParam 1, lParam 0) forever and the game never
ran another frame — 153 million API calls in 180s, all `PeekMessage` /
`TranslateMessage` / `DispatchMessage`.

Reproduction of the corruption itself, which is app-independent (the guest
address is the g2w alias of the linear address, `0x10808 + 0x400000 - 0x12000`):

```
node test/run.js --app=rct --quiet-api --batch-size=200000 \
  --max-batches=800 --max-seconds=60 --no-close --watch=0x3FE808 --watch-log
```

Before the fix that prints the callback being stored at batch 624 (`EIP 0x40d269`)
and zeroed at batch 715, right at the `[CreateDialog]` line. The live table can be
read from a `--control` session with `instance.exports.dbg_mm_timer(slot, field)`
(fields: 0 id, 1 interval, 2 callback, 3 dwUser, 4 last_tick, 5 oneshot).

Both are now `region.declare`d in `src/00-regions.wat`, so the region gate makes a
future overlap a build failure rather than a silent one.

## Dead ends

- **"RCT is VFS-blocked."** Withdrawn. `--trace-fs` shows every `Data/`,
  `Scenarios/` and font file opening successfully, including on the build that
  crashed at EIP 0. The crash was ordinal resolution and happened long before the
  game looked at a data file.
- **"The pump jam is a `PeekMessageA` bug."** Withdrawn. The MM_TIMER delivery
  path in `$timer_check_due` (`src/09a-handlers.wat`) is correct; it was faithfully
  reporting a timer slot that had already been overwritten.
- **`--async-mm-timer` is not the fix.** It masks the corruption because
  `fire_mm_timer` runs the callback out of band from batch 624, before the dialog
  that would clobber the slot is created. Message-loop delivery is the default and
  is what the browser host uses for RCT; the comment in `test/run.js` about
  duplicate dispatch for RCT still holds.

## Startup API profile

Ordinary CRT init, then `LoadCursorA`/`SetErrorMode`/`timeBeginPeriod(1)`,
`GetVersionExA`, `GetSystemInfo`, `GlobalMemoryStatus`, `GetUserNameA`,
`GetComputerNameA`, `RegisterClassA("RollerCoaster Tycoon")` (wndproc
`0x00403c7d`), then `DirectPlayEnumerateA`. Graphics come up through
`GetProcAddress(DirectDrawCreate)` → `IDirectDraw_EnumDisplayModes` (three times)
→ `CreateWindowExA` 640x480 → `SetCooperativeLevel` → `SetDisplayMode(640,480,8)`
→ primary + back surfaces + clipper + palette. Input is DirectInput 5
(`DirectInputCreateA(.., 0x0500, ..)`, keyboard + mouse devices). Audio is
DirectSound with three secondary buffers locked at startup.

Two compat patches already exist for this binary and fire at load
(`[compat] patched RCT ... video-mode change invalidates cached geometry at
0x0045268d` and `0x0042d2d3`).

## Named addresses (original VAs)

| VA | What |
|---|---|
| `0x00412d80` | PE entry |
| `0x00403903` | stores five globals from its args; block ending here calls `0x004036d3` and is where the dialog path begins |
| `0x00403b2e` | main message pump (`PeekMessageA` PM_REMOVE, `cmp [ebp-0x1c], 0x12` for WM_QUIT) |
| `0x00403c7d` | main window procedure |
| `0x004036d3` | function entered right before the first `CreateDialog` |
| `0x00410710` | DirectPlay provider-enumeration callback (`ret 0x14`) |
| `0x004107c0` | its caller; `0x004107e0` is the `DirectPlayEnumerateA` call, returning to `0x004107e5` |
| `0x0040c7a6` | multimedia-timer `TimeProc` — the game loop. `--count=0x0040c7a6` is the single best health check: 0 means the timer is dead, ~1000 over a 90s run is healthy |
| `0x0040d269` | return site of the `timeSetEvent` call that arms it |
| `0x0045231d` | caller of that arming function |
| `0x0042f5a5`–`0x0042f5ff` | the `.SC4` decode inner loop the startup scan spends its time in |
