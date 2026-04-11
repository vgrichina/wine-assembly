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

## Difficulty: Medium-Hard

The skin bitmap loading and GDI double-buffered drawing pipeline is the main challenge. Winamp doesn't use standard Win32 controls for its main UI — everything is custom-drawn via GDI onto a borderless window.
