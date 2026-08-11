# Marbles (Plus! 98) — Progress

**Binary:** `test/binaries/plus98/MARBLES.EXE`
**Assets:** `test/binaries/plus98/*.BMP`, `*.MID`, `*.WAV`, `*.DAT` (extracted from PLUS98.CAB)
**Window:** 640×480 fullscreen DirectDraw, title "Marbles"
**Image base:** 0x00400000
**Status (2026-08-10):** Browser desktop smoke now reaches a live round and
checks actual gameplay input: Right selects a column, Up/Down shift the selected
column, and Space rotates the center row. The mode-selection screen's grayscale
marble background matches `DIALOG.BMP` source art. A separate DirectDraw
presentation bug made Marbles intermittently show an offscreen/sprite-sheet
surface after explicit primary presents; the browser host now stops using the
periodic offscreen fallback once the game has presented the primary surface.
Browser guest ticks also track wall-clock elapsed time instead of advancing 200ms
per interpreter slice, which avoids racing through Marbles animations/menus.
**Status (2026-06-14):** Focused all-EXE smoke is now a normal pass under `LoseYourMarbles (DX)`, capturing the SegaSoft splash frame (`100` APIs, `172` PNG colors). The older deeper gameplay status below still applies for scripted/high-budget runs.

**Status (2026-04-16):** Game screen renders with marbles visible and dialog text ("CLASSIC PLAY / To clear the marbles..."). 173K API calls in 5000 batches. BltFast sprite rendering loop running. All BMP assets load correctly. Needs mouse input to proceed past intro screen.

## Key Addresses

| Address | Description |
|---------|-------------|
| 0x00434FF0 | CRT startup / `_cinit` |
| 0x00401352 | WndProc |
| 0x0040A786 | EnumDisplayMonitors call site |
| 0x00412E71 | DirectDrawCreate call |
| 0x00412E9E | IDirectDraw::SetCooperativeLevel |
| 0x00412ED6 | IDirectDraw::SetDisplayMode (640×480×8) |
| 0x00412F12 | IDirectDraw::CreateSurface (primary+backbuffer) |
| 0x00412F3E | IDirectDrawSurface::GetAttachedSurface |
| 0x0040C9BD | Asset file open routine |
| 0x004324D0 | CRT `memmove` / `memcpy` |
| 0x00432628 | `memmove` epilog (stuck point) |
| 0x0042CDEE | MIDI init (midiOutGetDevCapsA) |
| 0x0042FF31 | WaitMessage call (main loop idle) |

## Source Paths (from PDB references in exe)

- `C:\proj\Marbles\source\Ddutil.cpp` — DirectDraw utilities
- `C:\proj\Marbles\source\drawing.cpp` — Drawing/rendering
- `C:\proj\Marbles\source\fx.cpp` — Effects
- `C:\proj\Marbles\source\Sound.cpp` — Sound/MIDI
- `C:\proj\Marbles\source\textfile.hpp` — Text/data file parsing

## Asset Files

**Required (referenced in exe):**
- `llogo.bmp`, `lsplash.bmp` — Logo/splash screens
- `choose1.bmp`, `choose2.bmp` — Level selection
- `common01-05.bmp`, `cmnbonus.bmp` — Common sprites
- `level-01.bmp`, `level-01.dat`, `level1bg.bmp` — Level 1 data
- `trans1a-5b.bmp` — Transition animations
- `dialog.bmp`, `options.bmp`, `textfont.bmp`, `crack.bmp`, `grastile.bmp`
- `b1.mid`, `crd.mid`, `lvl1-5.mid` — MIDI music
- `2.wav` — Sound effect
- `marbles.dat` — Game configuration
- `o_demo.bmp` — Demo mode

**Available from PLUS98.CAB:** All level-1 assets present. Levels 2-5 assets (trans2b-5b, lvl2-5.mid, marbles.dat, o_demo.bmp) missing from CAB — may be on separate media or generated at install time.

## APIs Implemented for Marbles

### New handlers added:
- `EnumDisplayMonitors` — Calls callback once with primary monitor RECT {0,0,640,480} (src/09a-handlers.wat)
- `midiOutGetNumDevs` — Returns 1 (src/09a3-handlers-audio.wat)
- `midiOutGetDevCapsA` — Fills MIDIOUTCAPS with basic info (src/09a3-handlers-audio.wat)
- `midiOutOpen` — Returns fake handle (src/09a3-handlers-audio.wat)
- `midiOutClose` — Returns MMSYSERR_NOERROR (src/09a3-handlers-audio.wat)
- `midiOutShortMsg` — Returns MMSYSERR_NOERROR (src/09a3-handlers-audio.wat)
- `midiOutReset` — Returns MMSYSERR_NOERROR (src/09a3-handlers-audio.wat)
- `joyGetPos` — Returns JOYERR_UNPLUGGED (src/09a3-handlers-audio.wat)
- `joyGetNumDevs` — Returns 0 (src/09a3-handlers-audio.wat)
- `WaitMessage` — Returns TRUE immediately (src/09a-handlers.wat, was crash stub)

### Existing handlers used:
- DirectDraw COM vtable (src/09a8-handlers-directx.wat)
- DirectInput COM vtable
- CreateFileA, ReadFile, CloseHandle (filesystem)
- LocalAlloc, HeapAlloc (memory)
- CreateWindowExA, ShowWindow, UpdateWindow, SetFocus (window mgmt)
- waveOutOpen (audio)
- CreateFontA, GetStockObject, RegisterClassA

## Bugs Fixed

### 1. VFS `setCurrentDirectory` double backslash — FIXED
**File:** `lib/filesystem.js`
**Root cause:** `setCurrentDirectory` always appended `\\` to the resolved path. For root `C:\`, `_resolvePath` returned `c:\` (trailing backslash preserved for 3-char root), then `+ '\\'` made it `c:\\`. Subsequent relative path resolution produced `c:\\llogo.bmp` (double backslash) which didn't match VFS keys stored as `c:\llogo.bmp`.
**Fix:** Check if resolved path already ends with `\\` before appending.

### 2. Dispatch table not regenerated — FIXED
Generated `09b2-dispatch-table.generated.wat` didn't include DirectX handlers. Fixed by re-running `gen_dispatch.js` after DirectX work.

### 3. DX_OBJECTS pool exhausted (32 slots) — FIXED
**File:** `src/09a8-handlers-directx.wat`
**Root cause:** Marbles creates 14 DDraw surfaces, 1 DDPalette, 1 DSound, 15 DSBuffers = 31 objects. DirectInputCreateA needed slot 32 but the pool was full (32 max). Creation failed, game posted WM_CLOSE and exited.
**Fix:** Expanded DX_OBJECTS from 32 to 64 entries. Also moved COM_WRAPPERS from 0xEE00 to 0xF200 to avoid overlap.

### 4. DDraw palette R↔B byte swap — FIXED
**File:** `src/09a8-handlers-directx.wat` (`$dx_present`)
**Root cause:** `dx_present` used memcpy to copy PALETTEENTRY (R,G,B,flags) into BITMAPINFO palette slots that expect RGBQUAD (B,G,R,0). Red and blue channels were swapped.
**Fix:** Replaced memcpy with a 256-iteration loop that swaps byte 0 (R) and byte 2 (B) using bitwise ops.

### 5. Browser DDraw offscreen fallback after primary present — FIXED
**File:** `lib/host-imports.js`
**Root cause:** The browser host periodically called `presentBestDxOffscreen()`
as a safety fallback. Its surface chooser could prefer a high-color offscreen
surface over the primary surface after Marbles had already begun explicit
primary presents, so a transition/offscreen sprite surface could be copied into
the app window.
**Fix:** `dx_trace` records explicit primary presents, and the periodic fallback
now returns without presenting an offscreen candidate after that point. Forced
diagnostic fallback remains available.

### 6. Browser guest tick acceleration — FIXED
**File:** `host.js`
**Root cause:** The browser host advanced guest ticks by 200ms for every run
slice. On a fast browser loop this made Marbles time-gated UI and board
animation run far faster than wall time, making the game feel unplayable.
**Fix:** Browser guest ticks now derive from wall-clock elapsed time for
`timeGetTime`/`GetTickCount` instead of synthetic per-slice jumps.

## Gameplay Expectations

External references describe Lose Your Marbles as a real-time matching game
played with the arrow keys and Space: Left/Right choose a column, Up/Down shift
that column, and Space rotates the center row. Matches in the center row clear
marbles. References checked:
- https://gamefaqs.gamespot.com/pc/197802-lose-your-marbles/reviews/40216
- https://www.old-games.com/download/3698/lose-your-marbles
- https://oldpcgaming.net/lose-your-marbles-review/

## Current State (2026-04-16)

**Game screen renders** with marbles visible, dialog text, and stone border background. Game runs 173K API calls in 5000 batches. BltFast sprite rendering loop works. The stuck detection at `memcpy` (0x004324D0) was a false positive — the function is called in a tight BMP row-copy loop and needs `--stuck-after=10000` to avoid early abort.

**Working:**
- 8bpp palette rendering with SetPaletteEntries animation
- BMP asset loading (llogo, lsplash, dialog, textfont, choose, common, level BMPs)
- DDraw surface creation, Lock, BltFast, Flip
- Sprite rendering via BltFast with color-key transparency
- DirectInput device creation

**Next steps:**
1. Audio: MIDI playback is still stubbed/no-op in this runtime.
2. Broaden gameplay coverage if more levels/assets become available.
