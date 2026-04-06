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

## Current Status: RUNS — Window Renders at 275×116

**Test command:**
```bash
node test/run.js --exe=test/binaries/winamp.exe --max-batches=50000 --batch-size=5000 --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --png=scratch/winamp.png
```

- Runs 100K+ API calls through 50K batches without crashing
- Creates "Winamp 2.91" main window and enters message loop
- Processes WM_PAINT, WM_TIMER, WM_COMMAND, WM_ACTIVATE
- **Window rendered at 275×116 pixels** — title bar + menu visible, client area gray

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

## Difficulty: Medium-Hard

The skin bitmap loading and GDI double-buffered drawing pipeline is the main challenge. Winamp doesn't use standard Win32 controls for its main UI — everything is custom-drawn via GDI onto a borderless window.
