# Winamp 2.91 (winamp.exe) — Extracted Player Binary

Extracted from `winamp291.exe` NSIS installer via VFS dump. Binary is 846,848 bytes.

## PE Structure

- **Entry point:** `0x00444FC8`
- **Image base:** `0x00400000`
- **Imports:** COMCTL32.dll, MSVCRT.dll (loaded as DLLs), plus dynamic GetProcAddress for rasapi32.dll, wsock32.dll
- **Resources:** 1 menu, 36 dialogs, 154 strings, 12 icons, 4 accelerators (no bitmap resources — skin BMPs loaded from files)
- **Sections:** Standard .text/.rdata/.data/.rsrc

## DLL Dependencies

| DLL | Load Address | Notes |
|-----|-------------|-------|
| comctl32.dll | 0x4e3000 | InitCommonControls, toolbar/status bar classes |
| msvcrt.dll | 0x56b000 | C runtime (file I/O, string, memory) |
| rasapi32.dll | (dynamic) | RasEnumConnectionsA — dial-up connectivity check |
| wsock32.dll | (dynamic) | socket/connect/send — update check / survey |

## Key Addresses

### EXE Functions

| Address | Name | Notes |
|---------|------|-------|
| 0x41c210 | Main WndProc | Set via first EXE-space RegisterClassA |
| 0x41d240 | WM_COMMAND dispatcher | 3-level: byte table 0x41e940, jump table 0x41e8e0 |
| 0x421290 | WM_USER IPC dispatcher | byte table 0x421e54, jump table 0x421dd8 |
| 0x421641 | IPC_PLAYFILE handler | lParam=100: adds file to playlist |
| 0x421d64 | IPC_DELETE handler | lParam=101: clears playlist |
| 0x421d93 | IPC_STARTPLAY handler | lParam=102: calls Stop then Play |
| 0x42e0eb | Open File Play function | WM_COMMAND 40029 path, shows Open dialog |
| 0x42e577 | Play init (post-survey) | Sets [0x4575fc]=1, enumerates skins, loads playlist |
| 0x42fbcc | Play function | Gated on [0x45caa4]!=0 and [0x457608]>0 |
| 0x42ef0b | Get playlist count | Returns [0x457608] |
| 0x419020 | Stop wrapper | Loads [0x45ae28] (in_module), jmp [eax+0x48] (Stop) |
| 0x419070 | Build file type filter | For GetOpenFileNameA |
| 0x410060 | WM_PAINT handler | Checks [0x450500] (skin DC), BitBlts if set |
| 0x41aaf8 | Cmdline parser | Parses _acmdln flags: F/Q/S/D/R/A |
| 0x41efe0 | WM_CREATE handler | Creates child windows, INI, survey dialog |
| 0x4145f0 | Skin blit function | Checks [0x449e56] bit 0x01 |
| 0x40b959 | Skin DC writer | Writes [0x450500] = skin DC |
| 0x4382be | Survey/update thread | Loads wsock32, tries HTTP POST, gives up |
| 0x432bc0 | Timer/monitor thread | Spawned during play init |

### EXE Globals (BSS/Data)

| Address | Name | Notes |
|---------|------|-------|
| 0x45ae28 | in_module ptr | Points to in_mp3.dll's In_Module struct |
| 0x450500 | Skin DC handle | Set by skin loader; WM_PAINT checks this |
| 0x451608 | Playing flag | Non-zero = currently playing; Stop checks this |
| 0x4575fc | Init-done flag | Set to 1 after play init |
| 0x457608 | Playlist count | Number of entries in playlist |
| 0x45caa4 | Ready-to-play flag | Gate for play function; never set naturally in our init |
| 0x45a9f0 | Command-line flags | Parsed from cmdline: F=0x02, S=0x08, D=0x10, R=0x20, A=0x40 |
| 0x45acc0 | Current filename | Path of playing file |
| 0x45a7e0 | Title string buffer | Formatted title for SetWindowText |
| 0x45d960 | INI path buffer | winamp.ini path |
| 0x449e56 | Skin state bits | Bit 0x01 = skin initialized |
| 0x45caa5 | Skin dir path set | 0 = no skin dir → enumerate skipped |
| 0x45d5e1 | Taskbar mode | From INI "taskbar" key |
| 0x4581b0 | Skin-loaded flag | 0 = skin not loaded |
| 0x44d328 | Playlist index | -2 = unset; gets set from playlist count |

### WM_COMMAND IDs

| ID | Hex | Handler | Action |
|----|-----|---------|--------|
| 40029 | 0x9C5D | 0x41d866 | WINAMP_FILE_PLAY (Open + Play) |
| 40041 | 0x9C69 | 0x41dc62 | Skin Browser |
| 40044 | 0x9C6C | 0x41d782 | Previous Track |
| 40045 | 0x9C6D | 0x41d7a8 | Play |
| 40046 | 0x9C6E | 0x41d7ce | Pause |
| 40047 | 0x9C6F | 0x41d7f4 | Stop |
| 40048 | 0x9C70 | 0x41d81a | Next Track |

### in_mp3.dll (In_Module struct at 0x5cc8c8, loaded at 0x5af000)

| Offset | Field | Value | Notes |
|--------|-------|-------|-------|
| +0x00 | version | 0x100 | |
| +0x04 | description | 0x5cc96c | |
| +0x08 | hMainWindow | 0x10001 | Set by Winamp |
| +0x0C | hDllInstance | 0x5af000 | DLL base |
| +0x1C | Config | 0x5b051a | |
| +0x20 | About | 0x5b0de0 | |
| +0x24 | Init | 0x5b7363 | |
| +0x28 | Quit | 0x5b7385 | |
| +0x34 | IsOurFile | 0x5b7391 | |
| +0x38 | Play | 0x5b73d9 | |
| +0x3C | Pause | 0x5b74a0 | |
| +0x40 | UnPause | 0x5b74bc | |
| +0x44 | IsPaused | 0x5b74d6 | |
| +0x48 | Stop | 0x5b74dc | WaitForSingleObject([0x5cc590]), CloseHandle, cleanup |
| +0x94 | outMod | 0x5cc95c | Pointer to Out_Module (out_wave.dll) |

### in_mp3.dll Globals

| Address | Name | Notes |
|---------|------|-------|
| 0x5cc590 | Decode thread handle | Set by Play, waited by Stop |
| 0x5cc95c | outMod ptr | Points to out_wave.dll's Out_Module |
| 0x5d40d8 | Stopping flag | Set to 1 by Stop() |
| 0x5d40cc | Output-active flag | Non-zero = outMod was opened; checked by Stop for Close call |
| 0x5b7e45 | Decode thread entry | Start address for CreateThread |

### out_wave.dll (loaded at 0x5e2000)

| Address | Name | Notes |
|---------|------|-------|
| 0x5e3f28 | Buffer thread entry | Start address for T4's CreateThread |
| 0x5e3f66 | Buffer thread post-wait | Return address after WaitForSingleObject |

### Shared Memory (below GUEST_BASE, cross-thread)

| Address | Name | Notes |
|---------|------|-------|
| 0xD160 | waveOut handle | Set by waveOutOpen |
| 0xD164 | waveOut callback | Event handle for WOM_DONE (CALLBACK_EVENT) |
| 0xD168 | waveOut instance | dwInstance from waveOutOpen |
| 0xD16C | waveOut cb_type | 5 = CALLBACK_EVENT |

### Thread Handles (runtime)

| Handle | Thread | Start | Notes |
|--------|--------|-------|-------|
| 0xe0001 | Event | — | Manual-reset, initial=false |
| 0xe0002 | T1 | 0x4382be | Survey/update thread |
| 0xe0003 | T2 | 0x432bc0 | Timer/monitor thread |
| 0xe0004 | T3 | 0x5b7e45 | in_mp3.dll decode thread |
| 0xe0005 | Event | — | Auto-reset, data-ready + WOM_DONE |
| 0xe0006 | T4 | 0x5e3f28 | out_wave.dll buffer thread |

## Startup Sequence

```
1. ComCtl32 DllMain → registers common control classes
2. MSVCRT DllMain → init CRT
3. RegisterClass × 8 (Winamp_v1.x, plus child window classes)
4. CreateWindowExA "Winamp 2.91" (main, style=0xCA0000, size=0×0)
5. CreateWindowExA "" (child, style=0x40000000)
6. CreateThread → survey/update thread (0x417d3b)
7. LoadLibrary rasapi32 → RasEnumConnectionsA (check dial-up)
8. DialogBoxParamA #231 "User information" (modal first-run survey)
   → Button click → collects user info → CoCreateGuid for tracking
   → Tries HTTP POST via wsock32 (socket fails → gives up)
9. ShowWindow main (cmd=8)
10. SetTimer → WM_TIMER loop (timer ID 42)
11. Message loop: GetMessageA / TranslateMessage / DispatchMessageA
```

## Current Status: FULLY SKINNED — All 4 Windows Render

**Test command:**
```bash
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 \
  --batch-size=5000 --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --stuck-after=5000 --input=10:273:2 --png=scratch/winamp.png
```

- 7315 API calls across 200 batches, stable in message loop at EIP=0x0041bb3e
- **Main player** (65537, 275×116): Full classic skin — WINAMP header, transport buttons, time display, spectrum analyzer area, volume/balance sliders, mono/stereo, EQ/PL toggles
- **Equalizer** (65556, 275×116): All 10 EQ band sliders, presets button, on/auto toggles
- **Playlist Editor** (65557, 275×116): Track list area, transport buttons, add/rem/sel/misc controls
- **Minibrowser** (65560, 350×348): Frame chrome with nav buttons renders, content area is empty white (no HTML engine)
- Survey dialog dismissed via `--input=10:273:2` (WM_COMMAND IDCANCEL), skin loads inline in main thread

## Fixed Issues

### 1. WndProc Detection (commit f256248)

`$wndproc_addr` was captured from comctl32.dll's RegisterClassA (DllMain), giving a DLL-space WndProc. Fix: only capture EXE-space WndProcs.

### 2. DeferWindowPos / SetWindowPos not applying (current)

Winamp resizes its main window via `BeginDeferWindowPos` → `DeferWindowPos(hwnd, x=26, y=29, cx=275, cy=116)` → `EndDeferWindowPos`. These were stubs returning success without updating the renderer. Fix: `DeferWindowPos` now calls `host_move_window` immediately; `SetWindowPos` also calls it (respecting SWP_NOMOVE/SWP_NOSIZE flags).

## Current Blocking Issue: Skin Never Loads

The main window renders at 275×116 but the client area is gray because the skin bitmap DC at `[0x450500]` is never set.

### What We Know (deep analysis of WM_CREATE flow)

1. **WM_CREATE handler** at `0x41efe0` runs fully — creates child windows, reads INI, shows first-run survey dialog, does DeferWindowPos (275×116), creates window region, enters message loop
2. **BSS is properly zeroed** — `[0x45a7c0]`, `[0x45a9f0]`, `[0x45ab08]` are 0 (verified at load_pe time)
3. **`[0x45a9f0]` = command-line flags** — parsed from cmdline at `0x41ab78`: 'F'=0x02, 'Q', 'S'=0x08, 'D'=0x10, 'R'=0x20, 'A'=0x40. Since cmdline is empty, stays 0
4. **Code path at `0x41f1c2`**: `test eax,[0x45a9f0]; jz 0x41f401` — since flags=0, skips to 0x41f401 which is the **standard init** (not an error path)
5. **WM_PAINT** at `0x410060` checks `[0x450500]` (skin DC) — if zero, returns immediately without drawing
6. **Skin loading thread** at `0x406fa1` is spawned by dialog proc `0x406df5` on WM_INITDIALOG — but that dialog is never created
7. **Skin DC writer** at `0x40c587`: `mov [0x450500], ebx` is inside function `0x40b959` — called from `0x414729` and `0x43619f` etc.
8. **No PostMessageA calls** during init — the trigger for skin loading must come from message loop activity

### Skin Bitmap Resources (in .rsrc, NOT disk files)

| Resource ID | Size | Dimensions | Purpose |
|------------|------|------------|---------|
| 109 | 57,896 | 392×192 8bpp | Main skin sprite sheet |
| 126 | 26,666 | 275×116 8bpp | Main window background |
| 127 | 3,706 | 136×36 8bpp | Control buttons area |
| 128 | 2,550 | 58×24 8bpp | Misc controls |
| 129 | 362 | 42×9 8bpp | Small element |
| 130 | 4,430 | 92×85 8bpp | Volume/balance area |
| 132 | 2,016 | 99×13 8bpp | Position bar |
| 133 | 30,510 | 68×433 8bpp | Numbers/text font |
| 134 | 6,806 | 155×74 8bpp | Equalizer |
| 135 | 3,170 | 307×10 8bpp | Seek bar |
| 150 | 30,994 | 344×87 8bpp | Playlist skin |
| 194 | 67,086 | 275×315 8bpp | Extended skin |

### INI Config Read (all defaulting, empty winamp.ini)

Key values: PluginDir, SkinDir, skin (empty = use built-in), wx=26, wy=29, pe_width=275, pe_height=116, volume=200, sa=1 (spectrum analyzer), eq_open=1, pe_open=1, mb_open=1

### Skin Loading Chain

```
0x406df5 (dialog proc, WM_INITDIALOG)
  → CreateThread(0x406fa1)  — skin loading thread
    → 0x406fa1: GetWindowDC, LoadImageA(hInst, 109, ...), CreateDIBSection, ...
      → sets [0x450500] = skin DC
        → WM_PAINT at 0x410060 can now draw
```

The dialog proc `0x406df5` is NOT invoked during our execution. It would be invoked when a specific dialog is created — likely by the skin management code in `0x406918` which stores the function pointer and gets invoked via callback.

### Skin Rendering Chain

```
0x4145f0 (skin blit function)
  → checks [0x449e56] bit 0x01 (= 1, initialized in .data)
  → calls 0x40b959(bitmap_dc, rect) for each skin piece
    → reads [0x450500] (skin DC) — ZERO, so no blit
```

### APIs Added

- **MonitorFromPoint** — returns fake monitor handle (same as MonitorFromRect)
- **GetPrivateProfileStructA** — returns 0 (not found)

### Triggering Skin Loading (SOLVED)

Skin loading is triggered by **WM_COMMAND 0x9C69** (menu command "Skin Browser"):
```
WM_COMMAND(0x9C69) → WndProc switch at 0x41d5f2 (index 10)
  → 0x41dc62: call 0x4068e0 (show/create skin dialog)
    → CreateDialogParamA(hInst, 245, main_hwnd, 0x406918)
      → Dialog proc 0x406918 handles WM_INITDIALOG
        → Creates sub-dialog with proc 0x406df5
          → 0x406df5 WM_INITDIALOG: CreateThread(0x406fa1) — skin loading thread
```

**Test command:**
```bash
node test/run.js --exe=test/binaries/winamp.exe --max-batches=50000 --batch-size=5000 --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --input=10:273:40041 --png=scratch/winamp.png
```

### Current Status: Skin Thread Spawns But Too Slow

The skin loading thread runs: LoadImageA(109) → SelectObject → GetDIBits → GetDIBColorTable → CreateDIBSection → Sleep → FPU pixel processing. After Sleep, the thread enters heavy FPU math (color quantization for 8bpp→32bpp conversion) that takes millions of x86 instructions. With 50K batches × 5K instructions, the thread hasn't finished processing.

### APIs Implemented This Session

- **MonitorFromPoint** — returns fake monitor handle
- **GetPrivateProfileStructA** — returns 0 (not found)  
- **GetDIBits** — reads bitmap pixel data via host gdi_get_di_bits
- **Sleep** — no-op return (was crash stub)

### Why Default Skin Doesn't Load via Normal Init Path

The init function at 0x41f6bd calls `0x43518a` (enumerate skin directory) and `0x432e9b` (apply skin). Both are gated:
- `0x43518a` checks `[0x45caa5]` (skin dir path set) — 0 in BSS, so entire function skipped
- `0x432e9b` checks `[0x45d5e1]` (taskbar mode from INI "taskbar" key, default 0) and `[0x4581b0]` (skin-loaded flag) — both 0, so skin load skipped

On a real install, the NSIS installer creates the skin directory and populates INI values. Without these, the init function never loads skins. The WM_COMMAND 0x9C69 (skin browser) triggers loading from PE resources instead.

### Thread 2 Stuck in msvcrt FPU Math

After Sleep, the skin thread enters a msvcrt math function (likely `pow()` at 0x593ca5) doing per-pixel color quantization. The thread IS running (yield=0, EIP advances) but the FPU computation for 75K pixels takes billions of x86 instructions. Even at 50K batches × 50K instructions = 2.5B total, the thread doesn't complete.

### What's Needed Next

1. **Best: populate skin DC from JS** — parse the 8bpp resource bitmaps (#109 = 392×192 main skin, #126 = 275×116 bg) in JS, create canvases, and write the DC handle to `[0x450500]` directly. This bypasses the x86 color conversion entirely.
2. **Alternative: increase thread instruction budget** — the math function eventually completes, just needs more cycles. Could increase batch size to 500K+ or run thread batches separately.
3. **Alternative: stub the msvcrt `pow()` function** — the skin thread calls `pow()` repeatedly for gamma correction. Intercepting `pow()` at WASM level (return fast approximation) would speed up the loop.
4. **GetDIBColorTable** — currently returns 0 (stub). Should return palette entries for 8bpp bitmaps to enable the thread to properly convert colors.

## SESSION 2 PROGRESS — Skin Actually Loads!

### Findings

- **Survey dialog is the gate**, not skin browser command. The first-run survey
  (DialogBoxParamA #231 wrapping child #234) runs as a modal pump (`0xCACA0004`
  thunk in `09b-dispatch.wat`). Until it is dismissed, all `host_check_input`
  events are routed to the dialog proc — main wndproc never sees the injected
  WM_COMMAND. Confirmed by tracing: with `--input=10:273:40041` (skin browser),
  zero new APIs run; the modal pump just calls dispatch with WM_COMMAND 0x9c69
  on the survey dialog (which returns FALSE).
- **Dismiss survey with IDCANCEL**: `--input=10:273:2` (WM_COMMAND wParam=2)
  closes the modal pump → survey thread spawns → control returns to main
  WinMain init code → it proceeds into skin loading inline (not via separate
  thread on this path).
- **GDI skin pipeline runs in main thread** after survey dismissal. Calls
  flow: GetPixel × N → SelectObject → GetNearestColor → CreateBrushIndirect →
  ... per pixel color conversion. ~1900 API calls before first crash.

### Fixes Made This Session

1. **`_ftol` was using trapping `i32.trunc_f64_s`** → swapped to
   `i32.trunc_sat_f64_s` (`src/09a6-handlers-crt.wat:275`). The skin color math
   produces NaN/inf which previously crashed. (This wasn't the actual blocker
   for this exe, but the trap was real and would bite eventually.)
2. **`CreateBrushIndirect` was missing entirely** — added handler that reads
   `lbColor` from the LOGBRUSH struct and delegates to
   `host_gdi_create_solid_brush` (`src/09a4-handlers-gdi.wat`). Added to
   `tools/gen_api_table.js`.
3. **`AppendMenuA` / `InsertMenuA` were missing** — added no-op stubs
   returning TRUE in `src/09a-handlers.wat` (matches the existing `DeleteMenu`
   pattern). Winamp populates preset/playlist menus via these; visual skin
   does not depend on menu state.

### Session 2 End State

Skin loaded in back buffer (65537) but not blitted on-screen. EIP→0 stall after SetTimer. 2138 API calls.

## SESSION 3 PROGRESS — All Windows Skinned

### Fixes Made

1. **Paint queue: single slot → 16-entry ring buffer** — The old `$child_paint_hwnd` global could only hold one hwnd needing WM_PAINT. Winamp creates ~8 windows during init (main, EQ, playlist, minibrowser, video, etc.), each needing WM_PAINT. Only the last-created window got painted. New 16-entry queue at `0xB200` with `$paint_queue_push`/`$paint_queue_pop` + dedup. ShowWindow also enqueues. All windows now receive WM_PAINT.

2. **Unified full-window back canvas + ShowWindow paint + NULL_BRUSH fix** — Back canvases now sized to full window (not just client area), ShowWindow triggers WM_PAINT dispatch, and NULL_BRUSH class background doesn't crash FillRect.

### Current State: 4 Windows Rendering

| Window | HWND | Size | Status |
|--------|------|------|--------|
| Main player | 65537 | 275×116 | Full skin — header, transport, time, spectrum, volume |
| Equalizer | 65556 | 275×116 | All EQ sliders, presets, on/auto toggles |
| Playlist | 65557 | 275×116 | Track list, transport, add/rem/sel/misc buttons |
| Minibrowser | 65560 | 350×348 | Frame chrome + nav buttons rendered, **content area empty** (no HTML) |
| Video | 65558 | 275×232 | Hidden (visible=false), back canvas exists but blank |

### Remaining Issues

1. **Minibrowser content area is empty white** — Winamp uses private COM interfaces (`{77A366BA-2BE4-4a1e-9263-7734AA3E99A2}`, `{46986115-84D6-459c-8F95-52DD653E532E}`) via `CoCreateInstance`, NOT the standard IE WebBrowser control (`{8856F961-...}`). These are Winamp's own minibrowser plugin COM objects (likely `gen_ml.dll`). `CoCreateInstance` returns `E_NOINTERFACE` (0x80004002), so Winamp shows an empty content area gracefully. Could overlay a cosmetic `<iframe>` in the browser renderer at the child window position, but the original winamp.com minibrowser URLs are dead. Not worth pursuing unless for aesthetics (Wayback Machine snapshot).
2. **Main skin has garbled strips** — LCD area and visualizer band in the 275×116 back buffer have noise pixels. The per-pixel `GetPixel`→`CreateBrush`→`FillRect` skin builder may be computing wrong rects for some bands due to FPU math edge cases.
3. **No on-screen compositing yet** — Back buffers have correct pixels but the composite `winamp.png` shows them via the renderer's window-to-desktop blit, not via Winamp's own WM_PAINT→BitBlt path. The wndproc WM_PAINT at `0x410060` checks `[0x450500]` and does BitBlt, but we haven't confirmed this path fires correctly.

## SESSION 4 PROGRESS — Plugin DLL Loading

### Dynamic LoadLibraryA Implementation

Winamp dynamically loads plugins via `FindFirstFile("C:\Plugins\IN_*.DLL")` → `LoadLibraryA` → `GetProcAddress("winampGetInModule2")`. Previously `LoadLibraryA` was a stub returning the EXE base for any unknown DLL.

**New mechanism:**
1. `LoadLibraryA` checks `$find_loaded_dll` (already-loaded DLLs) first
2. If not found, calls `host_has_dll_file(nameWA)` to check VFS/host filesystem
3. If file exists: yields (reason=5, yield_flag=1) with EIP/ESP already adjusted
4. JS handler reads DLL from VFS, calls `loadDll()` + `patchDllImports()`, sets EAX
5. If file not found: returns `$image_base` (system DLL stub for GetProcAddress thunks)

**GetProcAddress enhanced:**
- First checks if hModule matches a loaded DLL → resolves via `$resolve_name_export`
- Falls back to thunk creation for Win32 API names
- Returns NULL for unknown names (instead of creating crash-stub thunks)

### Plugin Files

| File | Source | VFS Path | Load Address |
|------|--------|----------|-------------|
| in_mp3.dll | NSIS installer extract | `C:\Plugins\in_mp3.dll` | 0x5af000 |
| out_wave.dll | NSIS installer extract | `C:\Plugins\out_wave.dll` | 0x5e2000 |
| demo.mp3 | NSIS installer extract | `C:\demo.mp3` | N/A (data file) |

### VFS Recursive Loading

`test/run.js` companion file loader now recursively scans subdirectories. Files in `test/binaries/plugins/` map to `C:\Plugins\` in VFS.

### Current Blocking: EIP Corruption After Plugin Init

With plugins loaded, execution reaches the plugin init phase (calling `winampGetInModule2` etc.) but eventually EIP corrupts to 0x0001001a (invalid address). This is likely the same uninitialized function pointer issue from Session 2 (EIP→0 after SetTimer) — the plugin loading code path exercises additional init code that hits uninitialized callback slots.

Without plugins (moving `test/binaries/plugins/` away), the skin renders normally at 7315 API calls.

### DllMain Skipped

Plugin DLL DllMain is currently skipped because calling it triggers yields inside `callDllMain()` (which calls `run()` internally), causing state corruption. Plugin DLLs don't need DllMain for their plugin API to work — `winampGetInModule2` handles init.

### EIP Corruption FIXED — CoCreateInstance *ppv

The EIP corruption was caused by `CoCreateInstance` not zeroing `*ppv` on failure. Winamp's minibrowser creates COM objects for its embedded browser. On `E_NOINTERFACE`, the unzeroed `ppv` contained garbage (the hwnd value 0x1001a), which the caller dereferenced as a vtable pointer, corrupting EIP. Fix: zero `*ppv` when HRESULT is non-zero.

### Current Test Command

```bash
node test/run.js --exe=test/binaries/winamp.exe --max-batches=500 \
  --batch-size=5000 --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --stuck-after=5000 --input=10:273:2 --png=scratch/winamp.png
```

Stats: 8241 API calls, all 4 windows skinned, plugins loaded, no crashes.

## SESSION 5 PROGRESS — IPC Playback Injection

### wvsprintfA Added

`wvsprintfA(buf, fmt, arglist)` was crashing as unimplemented. It's the va_list variant of wsprintfA — stdcall 3 args, third arg is a guest pointer to the varargs. Calls `$wsprintf_impl(buf, fmt, g2w(arglist))` directly. Added to api_table.json as ID 963.

### WM_USER IPC Message Injection

Added `--input=B:winamp-play:FILENAME` command that posts Winamp IPC messages via the post queue:
- IPC_DELETE (WM_USER lParam=101, wParam=0): clear playlist
- IPC_PLAYFILE (WM_USER lParam=100, wParam=ptr-to-filename): add file
- IPC_STARTPLAY (WM_USER lParam=102, wParam=0): start playback

**Key finding: IPC_PLAYFILE dereferences wParam** — the handler reads `*(char**)wParam`, NOT `(char*)wParam`. Need to pass a pointer to a pointer.

**Current blocker: memory placement.** Writing the filename string + pointer cell to guest memory is fragile:
- BSS addresses (0x449000-0x46003C): overwritten by Winamp's own variables during IPC processing
- Stack addresses (below ESP): overwritten by nested function calls during dispatch
- Sub-GUEST_BASE addresses (WASM 0x300): conflicts with extra cmdline storage
- Heap region addresses: need verification

Writing to .rsrc section (0x461100) with `guest_write32` for the pointer cell successfully passes the address through the dereference chain, but `lstrcpynA` sees an empty string — the .rsrc data may overwrite the string bytes.

### IPC_STARTPLAY Play Gate

The play function `0x42fbcc` is only called when `[0x45caa4] != 0`. This byte is a "ready to play" flag, likely set during normal skin loading or INI processing. In our clean-slate init it's 0. Workaround: `--input=49:poke:0x45caa4:1`.

When poked to 1, IPC_STARTPLAY does enter the play path (GlobalAlloc called for audio buffer), but since the filename isn't in the playlist correctly, no CreateFileA for the MP3 occurs.

### Command-Line Args — ROOT CAUSE FOUND

`--args=C:\demo.mp3` correctly sets `_acmdln` to `"winamp.exe C:\demo.mp3"` (verified in memory at 0x9b103c). However, the **cmdline parser at 0x41aaf8 is never reached**.

**Root cause: `_acmdln` data import gets a code thunk instead of a variable address.**

The CRT startup at 0x445095 does:
```asm
mov eax, [0x4462bc]    ; IAT entry for MSVCRT!_acmdln
mov esi, [eax]          ; read the char* variable
cmp byte [esi], 0x22    ; check if quoted
```

The EXE imports `_acmdln` as a **data symbol** (PE import hint=143, RVA=0x48ca6). The IAT entry should contain the address of MSVCRT's `_acmdln` variable. But our PE loader creates a function thunk for ALL imports, so `[0x4462bc]` contains a thunk address. `mov esi, [eax]` then reads thunk code bytes as a pointer, producing garbage.

**Fix needed:** The PE/DLL import resolver must detect data exports (like `_acmdln`, `_environ`, `_commode`, `_fmode`) and store the actual variable address in the IAT instead of a thunk. The dll-loader.js already patches these variables via `__p__acmdln` etc., but the EXE's direct imports bypass this.

### Remaining Issues for Audio

1. **Fix IPC filename delivery** — need a memory region that survives from injection to dispatch without being overwritten. Options: (a) allocate via GlobalAlloc thunk, (b) write to a verified-unused BSS gap, (c) directly poke playlist data structure
2. **Fix cmdline parsing** — verify CRT passes lpCmdLine to WinMain, or find why parser entry isn't reached
3. **waveOut API implementation** — `out_wave.dll` calls waveOutOpen/Write/PrepareHeader via WINMM.dll thunks. Need real implementations piping PCM to Web Audio API
4. **Plugin DllMain** — currently skipped because `callDllMain()` can trigger LoadLibrary yields during `run()`, corrupting state. Need either: (a) handle yield_reason inside callDllMain, or (b) defer DllMain to run during the normal batch loop

### Palette Plumbing Added (not on hot path for this exe but correct)

- `lib/resources.js`: 8bpp DIB parser now retains `indices` (raw palette
  indices) and `paletteBGRA` (BMP-format palette) alongside the expanded
  RGBA `pixels`.
- `lib/host-imports.js`: `gdi_load_bitmap` propagates these to the GDI
  object. `gdi_get_di_bits` 8bpp output path now copies palette indices
  verbatim and writes the BMP palette into the BITMAPINFOHEADER. New
  `gdi_get_dib_color_table` reads the selected bitmap's palette.
- `src/01-header.wat`, `src/09a-handlers.wat`: import + wire
  `GetDIBColorTable` to the host.

Winamp doesn't actually call `GetDIBits` on the hot skin path (it uses
`GetPixel`), so this didn't affect the rendering output, but it's correct
infrastructure for any other paletted-bitmap caller.

## APIs Implemented for Winamp

| API | Implementation |
|-----|---------------|
| JECXZ (x86 opcode 0xE3) | New decoder + handler #216 — jump if ECX==0 |
| RasEnumConnectionsA | Return 0 connections (no dial-up) |
| CoCreateGuid | Deterministic counter-based GUID |
| IsDlgButtonChecked | Query stored check state from CheckDlgButton |
| GetForegroundWindow | Return main_hwnd |
| MonitorFromRect/Window | Return fake monitor 0x10000 |
| GetMonitorInfoA | 640×480 single primary monitor |
| CreateRectRgn/Indirect | Counter-based fake region handles |
| CombineRgn | Return COMPLEXREGION (3) |
| SetWindowRgn | No-op, return 1 |
| WSAStartup/Cleanup | Version 2.2, return success |
| socket/connect/send/recv | Return INVALID_SOCKET / SOCKET_ERROR |
| gethostbyname | Return NULL (no DNS) |
| htons | Byte-swap 16-bit |
| wvsprintfA | va_list variant of wsprintfA, calls $wsprintf_impl |

## Thread: Survey/Update (0x417d3b)

The main thread spawns a background thread that:
1. LoadLibrary + GetProcAddress for network functions
2. WSAStartup → socket (fails) → WSACleanup
3. Sets window text to "Sending in survey" during the attempt

Thread runs safely alongside main thread; socket failure causes graceful fallback.

## Message Loop Behavior

Once past the first-run dialog, the main loop processes:
- **WM_TIMER** (0x113): Timer ID 42 fires regularly
- **WM_PAINT** (0x0F): Dispatched to WndProc, window now 275×116
- **WM_COMMAND** (0x111): Many command messages dispatched (init-time menu setup?)
- **WM_ACTIVATE** (0x06): Falls through to DefWindowProcA
- **WM_ERASEBKGND** (0x14): Falls through to DefWindowProcA

## SESSION 6 PROGRESS — Dialog Fix, Audio Bridge, IPC Delivery

### Fixes Made

1. **EndDialog quit_flag regression (commit 66f2f86)** — commit 66f2f86 removed `quit_flag=0` from the EndDialog cleanup path, and changed dialog loop dispatch to route messages by hwnd wndproc instead of always using `$dlg_proc`. Winamp's survey dialog creates a CHILD dialog (dlg#234, hwnd=0x10009) inside the modal (dlg#231, hwnd=0x10003). When `check_input_hwnd` returned 0 (unspecified), the new code fell back to `dlg_hwnd` (0x10009) and dispatched to the child's dlg_proc, so IDCANCEL never reached the outer modal's EndDialog. Fix: when hwnd=0 from host input, always dispatch to `$dlg_proc` (the modal dialog proc). Also restored `quit_flag=0` on EndDialog. (`src/09b-dispatch.wat`)

2. **waveOut audio bridge** — Added host imports `wave_out_open/write/close/get_pos` in `src/01-header.wat`. `waveOutOpen` now reads WAVEFORMATEX (sample rate, channels, bits) and calls host. `waveOutWrite` reads WAVEHDR lpData/dwBufferLength and sends PCM to host. Host-side (`lib/host-imports.js`) uses Web Audio API for browser playback (AudioContext → createBuffer → BufferSource scheduling). Node CLI can write raw PCM to file descriptor. (`src/09a3-handlers-audio.wat`, `lib/host-imports.js`)

3. **IPC filename delivery fixed** — Changed winamp-play handler to use `guest_alloc()` (heap) instead of hardcoded .rsrc addresses (0x461100) that got overwritten. Filename and pointer cell now survive from injection to dispatch. (`test/run.js`)

4. **_acmdln data import** — NOT actually broken. `resolve_name_export` in `patch_caller_iat` correctly resolves msvcrt's `_acmdln` export (RVA 0x3a6d8, .data section) to guest address 0x5a56d8. `initMsvcrtGlobals` patches the same address via `__p__acmdln`. Verified: IAT[0x4462bc] = 0x5a56d8, `[0x5a56d8]` = cmdline string pointer.

### IPC Playback — Partially Working

IPC_PLAYFILE (WM_USER lParam=100) successfully adds a file to the playlist:
- CharPrevA walks the filename "C:\demo.mp3" to extract directory
- GlobalAlloc allocates playlist entry structures
- wsprintfA formats playlist display text
- SetWindowTextA updates title bar to "(null) - (null)" (no ID3 metadata)
- `[0x457608]` (playlist entry count) set to 1

IPC_STARTPLAY (WM_USER lParam=102) dispatched but does NOT trigger actual playback:
- The play function at 0x42fbcc IS entered from IPC_PLAYFILE's auto-play attempt (batch 160), but `[0x457608]` is still 0 at that point → early return
- When IPC_STARTPLAY arrives later (batch 185+), the play function breakpoint does NOT fire — the wndproc's IPC handler for lParam=102 apparently has additional gating conditions beyond `[0x45caa4]`
- With --args="C:\demo.mp3", the cmdline parser reaches a string comparison loop in msvcrt at 0x0057b6f6 (RVA 0x106f6) that runs for billions of instructions — NOT pow() as previously documented, but a strchr/strstr-type scan

### Current Blocking Issues for Audio

1. **Plugin Play() not invoked** — IPC_STARTPLAY dispatches to the wndproc but never reaches the in_mp3.dll plugin's Play function. The wndproc's WM_USER lParam=102 handler has unknown gating conditions. Need to disassemble the IPC dispatch chain from the wndproc's jump table at `0x41d5f2: jmp [0x41e8e0 + ecx*4]` where `ecx = [eax+0x41e940]` to find what blocks lParam=102 → play.

2. **Missing: WM_USER routing in wndproc** — The wndproc uses a two-level dispatch: message ID → byte index table at 0x41e940, then jump table at 0x41e8e0. Need to map WM_USER (0x400) through this table to find the IPC handler, then trace lParam=102 (IPC_STARTPLAY) to identify the gate.

3. **Alternative: command-line path** — `--args="C:\demo.mp3"` correctly sets `_acmdln` and the cmdline parser runs, but gets stuck in a msvcrt string scan loop. This loop isn't pow() — it's a string comparison (test al,al / jnz) that iterates over a large buffer. Could be FindFirstFileA-related path scanning. With batch-size=500K × 500 batches (250M instructions), still stuck.

### Open Tasks (priority order)

| # | Task | Files | Notes |
|---|------|-------|-------|
| 1 | **Trace IPC_STARTPLAY gate** | `test/binaries/winamp.exe` (disasm 0x41d5f2 dispatch) | Map WM_USER through the wndproc jump table, find why lParam=102 doesn't call the play function |
| 2 | **Fix cmdline path string loop** | `test/binaries/dlls/msvcrt.dll` (RVA 0x106f6) | The string scan loop blocks the --args path; may need to stub or accelerate the offending msvcrt function |
| 3 | **waveOut callback (WOM_DONE)** | `src/09a3-handlers-audio.wat` | Winamp's out_wave.dll expects WOM_DONE callbacks to refill buffers; currently waveOutWrite marks WHDR_DONE immediately but doesn't fire the callback |
| 4 | **Plugin DllMain** | `lib/dll-loader.js` | DllMain skipped for plugins due to yield corruption; some plugins may need DllMain for init |
| 5 | **Test waveOut with simpler app** | Create a minimal WAV-playing test EXE | Validate the waveOut→WebAudio bridge independently of Winamp's complex plugin chain |

### Test Commands

```bash
# Skin renders, no audio:
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input=10:273:2 --png=scratch/winamp.png

# IPC file injection (adds to playlist but doesn't play):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=2000 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input="10:273:2,160:winamp-play:C:\demo.mp3,200:poke:0x45caa4:1,201:winamp-start"
```

## SESSION 7 PROGRESS — Post Queue Fix, IPC Path Verified

### Root Cause: Post Queue Flooded by Renderer WM_PAINT

**Problem:** IPC_STARTPLAY (WM_USER lParam=102) was posted to the post queue but never consumed by GetMessageA. Investigation revealed the post queue (max 8 entries at WASM 0x400) was permanently full with WM_PAINT messages.

**Cause:** The JS renderer's `repaint()` cycle calls `send_message(hwnd, 0x000F, 0, 0)` for every window. For Winamp's 4 x86-wndproc child windows (EQ=0x10014, Playlist=0x10015, Video=0x10016, Minibrowser=0x10017), `$wnd_send_message` queued these into the post queue (since they have x86 wndprocs, not WAT-native). With 4 windows × ~1400 repaint cycles per batch, the queue was permanently at capacity. Any other message (like WM_USER IPC) was silently dropped.

**Fix:** Skip WM_PAINT in `$wnd_send_message` for x86 wndprocs (`src/09c3-controls.wat`). The app generates its own WM_PAINT via InvalidateRect → paint queue → GetMessageA, so renderer-injected WM_PAINT was redundant and harmful.

### WndProc Dispatch Fully Mapped

The main Winamp wndproc is at 0x41c210 (set as `$wndproc_addr` via first EXE-space RegisterClassA). WM_USER routing:
```
0x41c210 → cmp esi, 0x205 → ja 0x41cd89
0x41cd89 → cmp esi, 0x400 → jz 0x41cec3
0x41cec3 → call 0x421290(hwnd, wParam, lParam)  [IPC dispatch]
0x421290 → byte table at 0x421e54, jump table at 0x421dd8
  lParam=100 → 0x421641  [IPC_PLAYFILE]
  lParam=101 → 0x421d64  [IPC_DELETE]
  lParam=102 → 0x421d93  [IPC_STARTPLAY]
0x421d93 → call 0x42f868(0); test [0x45caa4]; jz skip; call 0x42fbcc(0)
```

### IPC_STARTPLAY Now Reaches Play Function

With the post queue fix, breakpoints at 0x421d93 and 0x42fbcc both fire. The play function enters but:
- Calls `[0x457608]` (playlist count via 0x42ef0b) — returns count
- If count == 0, exits without playing
- IPC_PLAYFILE (lParam=100) sets count to 1, but timing depends on message ordering

### Ready Flag [0x45caa4] Never Set Naturally

The "ready to play" flag at [0x45caa4] is never written during our init path. On real Windows, it's likely set by INI processing or the full skin loading chain (which we bypass). Workaround: `--input=...,B:poke:0x45caa4:1`.

### Tools Added

- `tools/disasm_fn.js` — Reusable PE disassembler: `node tools/disasm_fn.js <exe> <VA_hex> [count=30]`

### Remaining Issues for Audio

| # | Task | Notes |
|---|------|-------|
| 1 | **Verify IPC_PLAYFILE → playlist → play chain** | Post queue fix enables the full sequence; need to confirm playlist count is 1 when IPC_STARTPLAY fires |
| 2 | **Fix cmdline path string loop** | `--args` path still stuck in msvcrt string scan at RVA 0x106f6 |
| 3 | **waveOut WOM_DONE callback** | out_wave.dll needs buffer-done callbacks to drive decode→play pipeline |
| 4 | **Plugin DllMain** | Skipped due to yield corruption during callDllMain |

### Test Commands

```bash
# Skin renders (stable):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input=10:273:2 --png=scratch/winamp.png

# IPC playback attempt (play function reached):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=300 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --input="10:273:2,100:winamp-play:C:\demo.mp3,140:poke:0x45caa4:1,150:winamp-start"
```

## SESSION 8 PROGRESS — WM_COMMAND Dispatch Mapped, Play Path Reached

### WM_COMMAND Dispatch Fully Mapped

The main wndproc WM_COMMAND dispatch is a three-level chain:

```
WndProc 0x41c210
  → WM_COMMAND (0x111) handler at 0x41c73b
    → extracts commandID = wParam & 0xFFFF, notifyCode = wParam >> 16
    → calls 0x41d240(hwnd, commandID, lParam, notifyCode)

0x41d240 WM_COMMAND dispatcher:
  1. Skin range: 0x87D0 ≤ cmd < [0x45a9e8] → dynamic menu item
  2. Plugin range: 0x8000 ≤ cmd < [0x45aca8] → plugin menu
  3. Standard: byte table at 0x41e940, jump table at 0x41e8e0
     index = cmd - 0x9C41, max 0xA4

Button command IDs (byte table → jump table):
  40029 (0x9C5D) → 0x41d866  WINAMP_FILE_PLAY (Open + Play)
  40044 (0x9C6C) → 0x41d782  Previous
  40045 (0x9C6D) → 0x41d7a8  Play
  40046 (0x9C6E) → 0x41d7ce  Pause
  40047 (0x9C6F) → 0x41d7f4  Stop
  40048 (0x9C70) → 0x41d81a  Next
  40041 (0x9C69) → 0x41dc62  Skin Browser
```

### Play Button (40045) → Open File (40029) Redirect

The Play button handler at 0x41ec00 does NOT directly start playback. When not already playing (`[0x451608]==0`), it calls `SendMessageA(hwnd, WM_COMMAND, 0x9C5D, 0)` — redirecting to the "Open File" command (40029). This is the standard Winamp behavior: pressing Play with no playlist opens the file picker.

### Open File Play Function 0x42e0eb

WM_COMMAND 40029 calls `0x42e0eb(mode=1, hwnd, 0)`:
1. Checks `[0x457600]` (is-playing flag)
2. `GlobalAlloc(0, 0x3FF80)` — audio buffer
3. Calls `0x419070` — builds file type filter
4. Calls `0x444e70` → `GetOpenFileNameA` — shows Open dialog
5. On success, parses filename extension via `CharPrevA`
6. Calls `_stricmp` ([0x4462dc], MSVCRT import) to match extension to plugins
7. Calls plugin's `Play()` or `0x41a477`/`0x432180` depending on extension match

### Current Blocker: EIP=0 After Open Dialog

**Command:**
```bash
node test/run.js --exe=test/binaries/winamp.exe --max-batches=400 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --input="10:273:2,95:poke:0x45caa4:1,160:post-cmd:40029,170:open-dlg-pick:C:\demo.mp3"
```

The GetOpenFileNameA modal dialog opens, `open-dlg-pick` writes `C:\demo.mp3` into OFN.lpstrFile and closes the dialog. The play function starts processing (3× CharPrevA on the filename path). Then **EIP goes to 0** with return address 0x0042e210 on the stack.

0x42e210 is inside the extension-matching loop at 0x42e1f0:
```
0x42e1dd: push 0x44a7f4    ; extension string (e.g. ".mp3")
0x42e1e2: push esi          ; filename buffer
0x42e1e3: call 0x4378d5     ; extract/compare extension
0x42e1e8: mov edi, [0x4462dc] ; _stricmp (MSVCRT IAT)
0x42e1f0: call edi           ; _stricmp(ext, ".mp3") — CRASHES HERE
0x42e1f2: ...
0x42e201: push 0x44a7f0     ; try another extension
0x42e207: call 0x4378d5
0x42e20e: call edi           ; _stricmp again
0x42e210: pop ecx            ; ← return addr on stack
```

**Root cause:** `[0x4462dc]` (IAT for `_stricmp` from MSVCRT.dll) is likely not resolved. The EXE imports `_stricmp` from MSVCRT.dll. The dll-loader.js patches the IAT with the DLL's export address. If the resolution failed or the DLL's _stricmp code is not executable in our emulator, calling through it leads to EIP=0.

### `post-cmd` Input Action Added

New `--input` command: `B:post-cmd:WPARAM` — posts WM_COMMAND with the given wParam to main_hwnd via the post queue (bypasses check_input timing issues).

### Key Findings

1. **IPC_STARTPLAY only sets playlist index** — it does NOT invoke the plugin's Play(). The actual audio pipeline is triggered by the Open File path (0x42e0eb).
2. **The Play button always opens the file picker** when nothing is playing — this is normal Winamp 2.x behavior.
3. **Plugin init code DOES execute** — `winampGetInModule2()` is called, the plugin reads INI settings, initializes. But `Play()` is never invoked because the play path crashes at `_stricmp`.
4. **Post queue delivery works correctly** — `post-cmd` successfully routes WM_COMMAND through the wndproc to the right handler.

## SESSION 9 PROGRESS — msvcrt SBH Corruption, g2w Analysis

### Stall at 0x005c3ad4 — Linked List Walk in in_mp3.dll

After _stricmp works and the extension→plugin matcher runs, in_mp3.dll's Play() is called. The plugin opens `C:\demo.mp3` via CreateFileA, reads it, then enters an ID3 tag parser. The parser allocates nodes via msvcrt `malloc` and appends them to a linked list.

**Root cause found:** msvcrt's SBH (Small Block Heap) allocator returns garbage pointers (e.g., 0xfaaf2030). The linked list node is "allocated" at this out-of-bounds address. When the code tries to initialize the node's fields (`and [eax], 0` etc.), the writes go through g2w which maps OOB addresses to GUEST_BASE. When the code later tries to traverse the list, it reads from GUEST_BASE (PE header data) and enters an infinite loop.

### msvcrt CRT IS Initialized

- `[0x5a3000]` = 0x00140000 (process heap handle) ✓
- `[0x5a3004]` = 0x00000002 (SBH state = active) ✓  
- DllMain runs successfully with EAX=1
- HeapCreate returns 0x140000 (fake handle, ESP cleanup is correct: 3 args = 16 bytes incl ret)

### SBH Allocator Returns Invalid Pointers

The SBH at 0x780010b0 (relocated to 0x56c0b0) manages small allocations from pre-allocated regions. It was initialized during DllMain CRT init. However, it returns addresses like 0xfaaf2030 which are way out of bounds.

The SBH uses complex bookkeeping (region headers, page bitmaps, free lists) that involves pointer arithmetic. If any of these internal pointers are wrong (e.g., computed from unrelocated addresses or corrupted during init), the returned pointers will be garbage.

### g2w "Shadow Memory" Behavior

The current `$g2w` function maps ALL out-of-bounds guest addresses to GUEST_BASE (0x12000). This creates a "shadow memory" where reads and writes to the SAME unrelocated address are consistent (both map to GUEST_BASE). But reads and writes to DIFFERENT unrelocated addresses alias to the same WASM offset, causing corruption.

Changing g2w to return a different fallback (0, 0x80) breaks msvcrt because its CRT init code writes to unrelocated addresses that must be read back. The GUEST_BASE fallback accidentally works for same-address read/write consistency.

### Thread Stack Zeroing Added

`lib/thread-manager.js`: thread stacks allocated via `guest_alloc` are now zeroed (matching Windows zero-fill behavior for new stack pages). This doesn't fix the current stall but prevents future uninitialized-stack issues.

### What Needs Investigation

The SBH allocator's internal pointer arithmetic needs to be traced to find where the invalid 0xfaaf2030 address comes from. Likely one of:
1. A VirtualAlloc call during SBH region creation returned an unexpected address
2. The SBH's region bookkeeping uses address arithmetic that wraps incorrectly
3. An intermediate HeapAlloc during SBH init returned a value that was misinterpreted

## SESSION 10 PROGRESS — SBH Fix, Play Path Unblocked

### Root Cause: Wrong Variable Patched

Session 9 identified that msvcrt's SBH allocator returned garbage pointers and patched `__sbh_threshold` to 0 via the `_set_sbh_threshold` export. But that patch was **ineffective** because msvcrt's `_heap_alloc_base` checks a DIFFERENT variable.

**The actual malloc dispatch** (at relocated 0x56c304 in `_heap_alloc_base`):
```asm
mov eax, [0x5a3004]    ; __active_heap
cmp eax, 3             ; V5 SBH?
je  use_v5_sbh
cmp eax, 2             ; V6 SBH?
jne use_heapalloc      ; <-- we want this path
; ... SBH code ...
cmp esi, [0x5a5148]    ; compare with REAL threshold (NOT 0x5aa034!)
ja  use_heapalloc
```

The old code scanned `_set_sbh_threshold` for an `A3` byte (mov [imm32], eax) and patched whatever address it found — this turned out to be 0x5aa034, an unrelated variable. The actual threshold used by `_heap_alloc_base` is at 0x5a5148.

### Fix: Patch `__active_heap` Instead

Instead of trying to find the correct threshold, we now extract `__active_heap` from the `A1` instruction at the start of `_set_sbh_threshold` (offset 3: `mov eax, [__active_heap]`) and set it to 1. This makes `_heap_alloc_base` take the `jne use_heapalloc` branch, bypassing the SBH entirely.

### Results

- Play path now works: file opens, ID3 tags parsed, track info displayed ("DJ MIKE LLAMA")
- No regressions: test-all-exes.js still passes 47 tests

### Audio Pipeline Progress

Added `waveOutSetVolume` and `waveOutGetVolume` handlers. The playback thread (T3) now progresses through:
1. waveOutGetNumDevs → waveOutOpen (22050Hz 2ch 16bit) → waveOutRestart
2. waveOutSetVolume → GlobalAlloc → InitializeCriticalSection
3. CreateThread (spawns T4 decode thread) → SetEvent (signals decoder)

Thread T4 (decode) calls GetCurrentThread, SetThreadPriority, Enter/LeaveCriticalSection, then loops on WaitForSingleObject. Thread T3 signals it via SetEvent repeatedly.

No `waveOutWrite` calls yet — the decode thread may need to produce decoded PCM data first. The next step is likely implementing the inter-thread event signaling (SetEvent/WaitForSingleObject) so T4 can actually wake up and decode.

The "stuck at EIP=0x113" detected after ~250 batches is a false positive — it's the Winamp wndproc actively processing WM_TIMER (timer id=0x27, 200ms interval). With batch-size=1 the app progresses normally through 50,000+ batches. The WM_TIMER handler has a large stack frame (5.5KB alloca) and reads multiple INI settings, so it takes many instructions per timer tick.

### Open Tasks (Priority Order)

| # | Task | Files | Notes |
|---|------|-------|-------|
| 1 | **Inter-thread event signaling** | `lib/thread-manager.js` | T3 calls SetEvent to wake T4, but T4's WaitForSingleObject may not be receiving the signal. Need to verify event delivery between threads. |
| 2 | **waveOut WOM_DONE callback** | `src/09a3-handlers-audio.wat`, `lib/host-imports.js` | out_wave.dll needs buffer-done callbacks to drive decode→play pipeline |
| 2 | **Fix cmdline path string loop** | `test/binaries/dlls/msvcrt.dll` (RVA 0x106f6) | `--args` path stuck in msvcrt string scan; alternative to IPC/dialog approach |
| 3 | **Plugin DllMain** | `lib/dll-loader.js` | Skipped due to yield corruption during callDllMain; some plugins may need it |

### Test Commands

```bash
# Skin renders (stable):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input=10:273:2 --png=scratch/winamp.png

# Play via Open dialog (works — loads file, parses ID3, shows track info):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=400 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --input="10:273:2,95:poke:0x45caa4:1,160:post-cmd:40029,170:open-dlg-pick:C:\demo.mp3"
```

## SESSION 11 PROGRESS — Thread Yield Fix, Audio Pipeline Flowing

### Critical Bug: Thread yield/resume stack corruption

When WaitForSingleObject yielded during `$th_call_ind_ro` (inline thunk dispatch in threaded code), the `$run` loop re-executed the cached block from its entry EIP. Each re-execution pushed a new return address + args onto the stack before re-dispatching the handler. With batch_size=5000, each batch leaked ~60KB of stack (5000 × 12 bytes).

**Root cause:** The `$run` loop lacked a `yield_reason` check, and `$th_call_ind_ro` uses `if ($steps)` to decide whether to restore EIP — but yields set $steps=0 (same as handler redirects), so EIP was left at the block entry.

**Three-part fix:**
1. `src/13-exports.wat`: Added `(br_if $halt (i32.eq yield_reason 1))` at top of `$run` loop — exits immediately when WaitForSingleObject yields
2. `lib/thread-manager.js` `runSlice()`: On resume, read return address from `[ESP]` via `guest_read32()` and call `set_eip(retAddr)` before `set_esp(esp+12)`
3. Result: ESP stays stable across batches, T4 properly resumes at the return address

### FPU: Added 5 transcendental instructions

MP3 decoding uses FYL2X for dB/frequency calculations. Added:
- **F2XM1** (D9 F0): ST(0) = 2^ST(0) - 1
- **FYL2X** (D9 F1): ST(1) = ST(1) * log2(ST(0)), pop — via `Math.log2` host import
- **FPREM1** (D9 F5): IEEE remainder
- **FYL2XP1** (D9 F9): ST(1) = ST(1) * log2(ST(0)+1), pop
- **FSCALE** (D9 FD): ST(0) = ST(0) * 2^trunc(ST(1)) — via `2**x` host import

### WOM_DONE callback via CALLBACK_EVENT

waveOutOpen uses CALLBACK_EVENT (type 5) with event handle 0xe0005 (same event used for T3→T4 signaling). Callback info stored in shared memory at 0xD160 (not globals, since globals are per-WASM-instance). waveOutWrite now sets the callback event after marking WHDR_DONE.

### waveOutGetPosition startTime

Fixed `wave_out_open` to set `startTime = Date.now()` unconditionally (was only set when AudioContext existed in browser).

### Results

- T4 now wakes, decodes, and calls `waveOutPrepareHeader → waveOutWrite → waveOutUnprepareHeader`
- T3's MP3 decode loop runs successfully (tight compute loop at EIPs 0x593xxx/0x596xxx/0x5baxxx)
- T3 signals T4 ~9 times (9 decoded buffers), T4 writes 1 buffer to waveOut
- Test suite: 55 PASS (no regressions)

### CanWrite Stall — RESOLVED (was block cache corruption)

The CanWrite stall at EIP 0x5b9c69 was a symptom of the thread cache collision (see below), not a real audio pipeline issue. With the fix, T4 produces 25+ waveOutWrite calls in 2000 batches.

## SESSION 12 PROGRESS — Thread Cache Collision Fix, Web Deployment

### Critical Bug: Thread block cache collision

**Root cause:** Thread 2 (tid=2) got `THREAD_BASE = 0x01D52000 + 2*0x80000 = 0x01E52000`, which is the SAME address as the main instance's hardcoded `THREAD_BASE = 0x01E52000`. Thread 2's decoded blocks overwrote the main instance's block cache in shared WASM linear memory, causing corrupted x86 execution.

**Symptom:** Main thread's WM_TIMER handler (wndproc at 0x41c210) executed corrupted decoded blocks, causing a ret to pop 0 from the stack → EIP=0 crash at batch ~247. The crash only occurred when audio threads were active.

**Investigation path:**
1. Traced that the crash always happened during DispatchMessageA(WM_TIMER) — the same message that worked fine hundreds of times before
2. Confirmed no direct stack corruption from threads (memory snapshots showed no changes)
3. Isolated to thread execution: crash disappeared when `threadManager.runSlice()` was disabled
4. Found that `init_thread` uses `0x01D52000 + tid*0x80000` for THREAD_BASE, and tid=2 produces 0x01E52000 = main's base

**Fix:** Changed main instance's THREAD_BASE from 0x01E52000 to 0x01D52000 (aligns with tid=0 in the init_thread formula). No overlap with heap (ends at 0x01E12000) or thunks (start at 0x01E12000).

### Results

- Main thread stable through 2000+ batches with audio threads running
- T4 produces 25 waveOutWrite calls (was 1 before)
- T3 decode loop runs successfully with no CanWrite stall
- Test suite: 56 PASS (up from 55), no regressions

### Web Deployment

Added Winamp to the browser launcher:
- `index.html`: Added to DEFAULT_APPS and apps config with plugin files
- `host.js`: Added `binaries/plugins/` search path for dynamic DLL loading; added VFS fallback for COM DLL loads

### Open Tasks (Priority Order)

| # | Task | Notes |
|---|------|-------|
| 1 | **Browser audio playback** | The host-side Web Audio bridge exists but needs testing with real decoded PCM from Winamp |
| 2 | **Verify continuous playback** | With 2000 batches, 25 waveOutWrite calls happen. Need to verify audio data quality and timing |
| 3 | **Browser file picker** | The Open File dialog path needs browser-side file input integration for MP3 selection |

### Test Commands

```bash
# Skin renders (stable):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input=10:273:2 --png=scratch/winamp.png

# Play path with audio (25 waveOutWrite calls):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=2000 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --trace-api \
  --input="10:273:2,95:poke:0x45caa4:1,160:post-cmd:40029,170:open-dlg-pick:C:\demo.mp3"

# Regression suite:
node test/test-all-exes.js
```

### Key Files Modified

| File | Changes |
|------|---------|
| `src/01-header.wat` | THREAD_BASE/thread_alloc: 0x01E52000 → 0x01D52000 (fix tid=2 collision) |
| `src/13-exports.wat` | Added get_dbg_prev_eip export |
| `index.html` | Added Winamp to DEFAULT_APPS and apps config |
| `host.js` | Added binaries/plugins/ search path; VFS fallback for COM DLL loads |

## SESSION 13 PROGRESS — WaitForSingleObject Main Thread Fix, Audio PCM Output

### Critical Bug: Main Thread WaitForSingleObject Double Stack Adjustment

**Problem:** When the main thread called WaitForSingleObject (e.g., in_mp3.dll's Stop() function waiting for the decode thread), `checkMainYield()` in thread-manager.js adjusted ESP by 12 (popping return address + 2 args). But EIP was left pointing at the WaitForSingleObject thunk. When the run loop resumed, it re-entered the thunk, dispatching the handler again, which adjusted ESP by ANOTHER 12 bytes. This 24-byte corruption caused the decode thread's Stop function to `jmp [eax+0x48]` through a corrupted vtable → EIP=0 crash.

**Root cause analysis:**
- Worker threads already handled this correctly: they read the return address from ESP, set EIP to it, and adjusted ESP — so the thunk was never re-entered.
- The main thread's `checkMainYield()` didn't set EIP, leaving it at the thunk address. The run loop re-entered the thunk on each iteration.

**Fix:** Made `checkMainYield()` mirror the worker thread approach — read return address from `[ESP]` via `guest_read32()`, set EIP to it, adjust ESP, set EAX.

### Audio Pipeline: End-to-End PCM Output

With the WaitForSingleObject fix, the full IPC playback chain works:
1. IPC_PLAYFILE adds `C:\demo.mp3` to playlist
2. IPC_STARTPLAY calls play function → starts decode threads T3 (in_mp3.dll) + T4 (out_wave.dll buffer thread)
3. T3 opens demo.mp3, reads full file (38KB), decodes MP3 frames via FPU math
4. T3 opens waveOut (22050Hz 2ch 16bit) via outMod->Open
5. T3 creates T4 (out_wave.dll buffer management thread)
6. T3 fills ring buffer with decoded PCM, signals event 0xe0005
7. T4 reads from ring buffer → waveOutPrepareHeader → waveOutWrite (11520 bytes per buffer) → waveOutUnprepareHeader
8. WOM_DONE callback (CALLBACK_EVENT type 5) signals event 0xe0005 for buffer recycling

**Audio output:** 4 waveOutWrite × 11520 bytes = 46080 bytes = 0.52s of decoded PCM from the 5.34s demo.mp3.

### Shared Audio State Across Threads

waveOutOpen runs on T3 but waveOutWrite runs on T4 — different WASM instances with different host import contexts. Added `ctx._sharedAudio` object shared across all worker contexts so `_waveOut` state (sample rate, channels, bits, bytesWritten) is visible to all threads. Added `--audio-out=FILE` CLI flag to write raw PCM to file.

### IPC Message Fix

Removed redundant IPC_STARTPLAY from `winamp-play` input action — IPC_PLAYFILE was followed immediately by IPC_STARTPLAY in the same post queue, causing Stop() to kill the just-started decode threads and restart. Now `winamp-play` only sends IPC_DELETE + IPC_PLAYFILE; IPC_STARTPLAY is sent separately via `winamp-start` at a later batch.

### Thread Scheduling: Interleaved Slices

Changed `runSlice()` from running each thread for the full `batchSize` to splitting into `batchSize/4` interleaved slices (min 1000 instructions each). This allows producer/consumer thread pairs (decode → waveOut) to make progress within a single batch. Also added Sleep yield via `yield_flag` so spin-wait loops (ring buffer full) yield to other threads.

### waveOutGetPosition: Instant Playback

Changed `wave_out_get_pos` to return `bytesWritten` directly instead of wall-clock-time estimation. In emulation, wall time doesn't match audio time, causing pacing issues where the output thread thinks buffers haven't been played yet.

### Remaining Audio Limitation

Only 0.52s of 5.34s gets decoded/output. The bottleneck is the out_wave.dll ring buffer + scheduling: T3 fills the ring buffer, T4 drains 4 buffers, then T4 finds the buffer empty despite T3 signaling 90+ SetEvent calls. The likely cause is the ring buffer overflowing (CriticalSection is a no-op, so T3's spin-wait on buffer-full burns instruction budget without yielding to T4). In the browser with continuous execution, more audio should flow.

### Test Commands

```bash
# Skin renders (stable):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input=10:273:2 --png=scratch/winamp.png

# IPC playback with audio output (0.52s PCM):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=300 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --input="10:273:2,99:poke:0x45caa4:1,100:winamp-play:C:\demo.mp3,150:winamp-start" \
  --audio-out=scratch/winamp-audio.pcm

# Convert PCM to WAV:
ffmpeg -f s16le -ar 22050 -ac 2 -i scratch/winamp-audio.pcm scratch/winamp-audio.wav -y
```

### Key Files Modified

| File | Changes |
|------|---------|
| `lib/thread-manager.js` | Fixed `checkMainYield()` to set EIP (mirror worker thread approach); interleaved thread slices in `runSlice()` |
| `lib/host-imports.js` | Shared `_waveOut` via `ctx._sharedAudio`; instant `wave_out_get_pos`; removed debug logging |
| `src/09a-handlers.wat` | Sleep sets `yield_flag` for thread cooperation |
| `test/run.js` | Added `--audio-out` flag; shared `_sharedAudio`/`_audioOutFd` with worker contexts; removed IPC_STARTPLAY from `winamp-play` |

## SESSION 14 PROGRESS — Deferred WHDR_DONE, Thread Scheduling, Audio Pipeline Analysis

### Root Cause: waveOutWrite Marked WHDR_DONE Immediately

In real Windows, `waveOutWrite` submits a buffer for **async** playback. WHDR_DONE is set only after the hardware finishes playing the buffer. Our implementation marked WHDR_DONE immediately, causing `out_wave.dll`'s buffer thread to think all buffers had been played instantly.

**Impact on out_wave.dll threshold logic:**

The buffer thread (`T4`, start=0x5e3f28) uses a two-level write threshold at `0x10002017`:
```
if ([ebp+0x6c] == 0) {           // outstanding buffer count
    threshold = max([ebp+0x68],   // initWriteSize (0)
                    [ebp+0x5c]);  // largeThreshold (11025)
} else {
    if ([ebp+0x48] < [ebp+0x44]/2  // inFlight < ringSize/2
        || [ebp+0x6c] < 3)         // outstanding < 3
        threshold = [ebp+0x54];   // smallThreshold (256)
    else
        threshold = [ebp+0x5c];   // largeThreshold (11025)
}
// Write only when pending > threshold
```

With immediate WHDR_DONE, outstanding was always 0 → threshold always 11025 → T4 waited for 11025 bytes (5 decoded MP3 frames) before each write. Only 4 writes occurred with 300 batches.

**Fix:** Deferred WHDR_DONE — each `waveOutWrite` marks the PREVIOUS buffer as done. Pending WAVEHDR guest address stored at shared memory `0xAD98`. `waveOutReset`/`waveOutClose` flush the last buffer.

**Result:** outstanding=1 after first write → threshold drops to 256 → T4 writes every 2304 bytes (1 frame). Writes increased from 4 to 17 in 300 batches.

### out_wave.dll Buffer Thread (T4) Main Loop — Full Disassembly

```
0x5e3f28 (VA 0x10001f28): Thread entry
  mov ecx, [esp+4]         ; ecx = lpParameter (ring buffer struct ptr)
  call 0x10001f36           ; main loop function

0x5e3f36 (VA 0x10001f36): Main loop
  push ecx,ecx,ebx,ebp,esi,edi
  mov ebp, ecx              ; ebp = ring buffer struct

  ; === OUTER LOOP ===
  0x10001f4f: cmp [ebp+0x00], 0   ; waveOut handle valid?
  jz exit

  0x10001f5b: WaitForSingleObject([ebp+0x08], INFINITE)  ; wait for signal from T3 or WOM_DONE
  0x10001f66: EnterCriticalSection([ebp+0x0C])

  ; --- Check stop flag ---
  0x10001f6d: cmp byte [ebp+0x76], 0
  jnz cleanup

  ; --- Drain completed buffer list ---
  0x10001f77: esi = [ebp+0x24]    ; completed list head
  loop:
    if esi == 0: break
    if [esi+0x14] & 1:           ; WHDR_DONE?
      dec [ebp+0x6c]             ; outstanding--
      sub [ebp+0x48], [esi+0x8]  ; inFlight -= buffer size
      timeGetTime → [ebp+0x60]
      waveOutUnprepareHeader(hwo, esi+4, 32)
      free node → [ebp+0x28]
      esi = [esi]
    else:
      esi = [esi]; continue

  ; --- Pause/resume logic ---
  0x10001fb7-0x10002008: checks [ebp+0x74] (paused), [ebp+0x7a] (pause-req)
  Calls waveOutPause/waveOutRestart + timeGetTime for pause timing

  ; --- Compute write threshold ---
  0x10002017: see threshold logic above

  ; === WRITE LOOP ===
  0x10002049: cmp [ebp+0x4c], threshold
  jbe 0x10002101              ; not enough data → skip

  0x10002056: ebx = min(pending, maxWriteSize)
  align down to [ebp+0x3c] (block align)
  add [ebp+0x48], ebx        ; inFlight += size
  sub [ebp+0x4c], ebx        ; pending -= size

  0x10002078: call alloc_node → allocate WAVEHDR node
  Copy data from ring buffer (with wrap handling via rep movsd/movsb)

  0x100020ba: if byte [ebp+0x78] (DSP callback):
    call 0x100029e4           ; volume/DSP processing (DISABLED for Winamp)

  0x100020ce: waveOutPrepareHeader(hwo, wavhdr, 32)
  0x100020e3: waveOutWrite(hwo, wavhdr, 32)

  0x100020e9: if [ebp+0x6c] == 1:   ; first buffer submitted?
    timeGetTime → [ebp+0x60]        ; record start time
  jmp 0x10002049                     ; check for more data

  ; === EXIT WRITE LOOP ===
  0x10002101: LeaveCriticalSection → loop back to WaitForSingleObject
```

### Ring Buffer Struct Layout (ebp-relative, out_wave.dll)

| Offset | Type | Name | Notes |
|--------|------|------|-------|
| +0x00 | HWAVEOUT | waveOut handle | 0 = closed |
| +0x08 | HANDLE | event | Waited by T4, set by T3/WOM_DONE |
| +0x0C | CRITICAL_SECTION | cs | Lock for ring buffer access |
| +0x24 | ptr | completed list | Linked list of WHDR_DONE buffers |
| +0x28 | ptr | free list | Recycled buffer nodes |
| +0x30 | int | nChannels | 2 for stereo |
| +0x3C | int | block align | nChannels × bitsPerSample/8 = 4 |
| +0x40 | ptr | ring buffer base | Guest address of circular buffer |
| +0x44 | int | ring buffer size | 176400 bytes (2s @ 22050Hz stereo 16-bit) |
| +0x48 | int | bytes in flight | Submitted to waveOut, not yet completed |
| +0x4C | int | pending data | Bytes in ring buffer available for write |
| +0x50 | int | write offset | Current position in ring buffer |
| +0x54 | int | small threshold | 256 — min bytes for a write when buffers outstanding |
| +0x58 | int | max write size | Max bytes per waveOutWrite call |
| +0x5C | int | large threshold | 11025 — min bytes when no buffers outstanding |
| +0x60 | DWORD | last time | timeGetTime value from last completed/first buffer |
| +0x64 | DWORD | pause delta | Accumulated pause time |
| +0x68 | int | initial write | First-buffer threshold (0 = use large) |
| +0x6C | int | outstanding | Number of buffers submitted but not completed |
| +0x74 | byte | paused | 1 = playback paused |
| +0x75 | byte | flush | Flush request |
| +0x76 | byte | stop | Stop request → thread exits |
| +0x78 | byte | DSP active | 1 = call DSP callback on write (0 for Winamp) |
| +0x7A | byte | pause request | |
| +0x7B | byte | end of stream | |
| +0x7C | int | volume L | Left channel volume (-666..255) |
| +0x80 | int | volume R | Right channel volume |

### in_mp3.dll Synthesis Filter (T4 Bottleneck)

T4 enters a tight FPU loop in in_mp3.dll at relocated address 0x5bd470 (VA 0x1000E470):
```asm
loop:
  ecx = [esi]; esi += 4     ; read Huffman code
  if ecx > 0: [eax] = scale × table[ecx]      ; FPU multiply
  if ecx < 0: [eax] = -scale × table[-ecx]    ; negate + multiply
  if ecx == 0: [eax] = 0                       ; zero
  eax += 4; edx--
  jnz loop
```

This is the MP3 Huffman dequantization/inverse quantization step. Each call processes 256 samples (~1500 x86 instructions). The function is called from a code path in T4's execution that I traced entering from 0x5e3f66 (out_wave.dll WaitForSingleObject return), but the exact intermediate caller is unclear — the return address on T4's stack is 0 (likely tail-call optimized or thunk-related).

**Impact:** This FPU loop consumes the majority of T4's instruction budget. With 5000 instructions per batch / 4 threads / 4 slices = ~312 instructions per slice, one call to this function takes ~5 slices to complete. T4 can only complete ~1-2 writes per batch.

### Thread Scheduling Improvements

1. **Sleep deprioritization** — Threads that call Sleep repeatedly (like T2 timer/monitor thread, which calls Sleep 467× in 300 batches) are deprioritized: run only every 8th slice. Uses new `$sleep_yielded` global that persists across `run()` calls.

2. **Deferred WHDR_DONE** — Previous WAVEHDR guest address stored at `0xAD98`. Each waveOutWrite marks the previous buffer done, keeping ≥1 outstanding. Flushed by waveOutReset/waveOutClose.

### Audio Output Results

| Config | waveOutWrite | PCM bytes | Duration |
|--------|-------------|-----------|----------|
| Before (immediate WHDR_DONE) | 4 | 46080 | 0.52s |
| After (deferred WHDR_DONE) | 17 | 39168 | 0.44s |
| 2000 batches × 5000 | 17 | 39168 | 0.44s |
| 500 batches × 100000 | 9 | ~20736 | 0.23s |

More writes per batch but smaller buffers (2304 vs 11520). Total output limited by T4's FPU throughput, not scheduling. Larger batch sizes actually reduce output because the interleaving is coarser.

### Key Files Modified

| File | Changes |
|------|---------|
| `src/09a3-handlers-audio.wat` | Deferred WHDR_DONE in waveOutWrite; flush in waveOutReset/waveOutClose |
| `src/01-header.wat` | Added `$sleep_yielded` global; documented 0xAD98 shared memory slot |
| `src/13-exports.wat` | Added `get_yield_flag`, `get_sleep_yielded` exports |
| `src/09a-handlers.wat` | Sleep handler sets `$sleep_yielded` flag |
| `lib/thread-manager.js` | Sleep-based thread deprioritization; adaptive slice count |

### Open Tasks (Priority Order)

| # | Task | Notes |
|---|------|-------|
| 1 | **Browser audio playback** | The Web Audio bridge + deferred WHDR_DONE should work with continuous execution in browser (requestAnimationFrame). T3/T4 get unlimited instruction budget. |
| 2 | **Optimize FPU synth** | T4's FPU loop at 0x5bd470 (in_mp3.dll synthesis filter) is the decode bottleneck. Options: (a) detect and fast-path the specific loop pattern in the threaded code emitter, (b) increase thread slice size for compute-heavy threads, (c) implement the inverse quantization as a WASM host import |
| 3 | **Trace T4→in_mp3 call path** | T4 enters in_mp3.dll FPU code from out_wave.dll but the exact call chain is unclear (stack shows return addr 0). May be via a function pointer in shared audio state or a thunk redirect. |

### Test Commands

```bash
# Skin renders (stable):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=200 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --stuck-after=5000 \
  --input=10:273:2 --png=scratch/winamp.png

# IPC playback with audio output (17 writes, 0.44s PCM):
node test/run.js --exe=test/binaries/winamp.exe --max-batches=300 --batch-size=5000 \
  --buttons=1,1,1,1,1,1,1,1,1,1 --no-close \
  --input="10:273:2,99:poke:0x45caa4:1,100:winamp-play:C:\demo.mp3,150:winamp-start" \
  --audio-out=scratch/winamp-audio.pcm

# Convert PCM to WAV:
ffmpeg -f s16le -ar 22050 -ac 2 -i scratch/winamp-audio.pcm scratch/winamp-audio.wav -y

# Regression suite:
node test/test-all-exes.js
```

## SESSION 15 PROGRESS — Survey Dialog Routing Bug Blocks Playback

After the Atomics.wait / shared-memory work (commits 9de3418, 01a65bf), the documented `--input=10:273:2` IDCANCEL trick to dismiss the survey now causes immediate `ExitProcess(39)`. Investigation:

### Survey dlgproc reverse-engineered (0x4254f6)

Survey dialog (`DialogBoxParamA` resource ID 0xe7) is a multi-page registration form. State at `[0x45330c]` is the page counter (1 → 2 → 3). Child sub-dialog `0x10009` (created by `CreateDialogParamA` from inside the survey at API #473) holds the form fields.

WM_COMMAND handling in dlgproc:
- **wParam=1 (IDOK)** → at 0x4255b2: SendMessage(child, 0x408) to validate. If validation passes AND `[0x453310]==0` OR `[0x45330c]!=1` → calls `EndDialog(survey, 0)`. Else `[0x45330c]++` (advance page).
- **wParam=2 (IDCANCEL)** → falls through to 0x425541 (page advance / decline path).
- **Other wParams** → ignored.

WM_CLOSE (msg=0x10) only acts when `[0x45330c]==2`: sets `[0x45a9f0]=1` and `[0x45330c]=3`.

### The real bug: nested dialog hwnd tracking

`$dlg_hwnd` is a single global. When the inner sub-dialog 0x10009 is created via `CreateDialogParamA`, the global gets overwritten — so `09b-dispatch.wat:131-134` routes hwnd-less input to the **sub-dialog**, not the outer survey.

Confirmed by trace: with `--input="50:poke:0x45330c:3,60:273:1"`, EndDialog fires on hwnd `0x10009` (sub-dialog) at API #665, never on outer `0x10003`. The outer survey never receives WM_COMMAND. Eventually winamp exits at API #4902 via the standard `RevokeDragDrop → OleUninitialize → ExitProcess(0x27)` shutdown path.

### Sweep results (all `--max-batches=20000`, no audio output)

| Input | APIs ran | Outcome |
|-------|----------|---------|
| (none) | 491 | Idle — survey modal forever |
| `10:273:2` | 6069 | Exit at batch ~14 — IDCANCEL routes to main wndproc somewhere |
| `10:273:1` | 4316 | Inner sub-dialog ends, survey stays, exits later |
| `50:poke:0x45330c:3,60:273:1` | 4902 | Sub-dialog ends with poked page state, still no playback, still exits |
| `wParam ≥ 3` | 491 | No effect |

### Why playback can't proceed

Survey's modal `DialogBoxParamA` loop blocks the main message pump. Until the **outer** survey ends, IPC posts (winamp-play / winamp-start / poke) never reach winamp's main code path that initializes playback (the post-survey init at 0x42e577 sets `[0x4575fc]=1`).

### Fix options (not implemented this session)

1. **Make `$dlg_hwnd` a stack, or track only the topmost modal dialog.** Non-modal `CreateDialogParamA` should NOT overwrite the modal hwnd used by the dispatch loop's hwnd-less fallback. Architecturally correct, fixes the routing for all nested-dialog apps.
2. **Suppress survey for resource ID 0xe7** — return IDOK/EndDialog immediately. Hacky but unblocks playback for testing.
3. **Bypass dialog entirely** — directly call play function `0x42fbcc` after manually setting up `[0x4575fc]`, `[0x45caa4]`, playlist count `[0x457608]`, and entry. Risky, easy to crash.

### Recommended next step

Option 1 — fix `$dlg_hwnd` so the modal pump (`09b-dispatch.wat:131-134`) routes hwnd-less input to the topmost MODAL dialog (DialogBoxParamA), not whatever non-modal `CreateDialogParamA` ran most recently. This is the actual regression introduced or exposed by recent dialog/threading changes; the IDCANCEL path that worked in prior sessions worked because that nested-dialog architecture either didn't exist or `$dlg_hwnd` wasn't being clobbered yet.

## SESSION 16 — Modal Pump HWND Fix, Survey Dismissible Again

Implemented Option 1 from Session 15. Added a dedicated `$dlg_pump_hwnd` global, set only by `DialogBoxParamA`, used by the pump's hwnd-less fallback in `09b-dispatch.wat`. Nested modeless `CreateDialogParamA` still updates `$dlg_hwnd` (so `IsChild` / `DefWindowProc` routing for the "most recent" dialog still works) but no longer hijacks the modal pump.

### Result

`--input=10:273:2` now dismisses the outer survey cleanly:

- EndDialog fires at API #492 on hwnd `0x10003` (the outer survey). Previously routed to `0x10009` (inner sub-dialog) at API #665.
- After EndDialog, winamp continues into its post-survey code path (SetWindowPos, SetWindowLong, CreateWindowEx for the main Winamp window, SetPriorityClass, skin/GDI drawing). Execution reaches API #6117 before the standard shutdown (`RevokeDragDrop → OleUninitialize → ExitProcess(0x27)`) fires.

IDCANCEL still ends up taking the survey decline path, so playback via this input still doesn't happen — winamp exits. To get audio playback, a different input (IDOK through all three pages, or bypassing via page-counter poke + IDOK) is needed. That's independent of the pump routing bug.

### Files changed

| File | Change |
|------|--------|
| `src/01-header.wat` | Added `$dlg_pump_hwnd` global with docstring |
| `src/09a-handlers.wat` | `$handle_DialogBoxParamA` sets `$dlg_pump_hwnd` alongside `$dlg_hwnd` |
| `src/09b-dispatch.wat` | Pump fallback uses `$dlg_pump_hwnd`; dlg_ended cleanup destroys that hwnd and clears it |

Regression: `test-all-exes.js` shows no new failures.

## Difficulty: Medium-Hard

The skin bitmap loading and GDI double-buffered drawing pipeline is the main challenge. Winamp doesn't use standard Win32 controls for its main UI — everything is custom-drawn via GDI onto a borderless window.
