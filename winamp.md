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

## Current Status: RUNS — No Rendering

**Test command:**
```bash
node test/run.js --exe=test/binaries/winamp.exe --max-batches=50000 --batch-size=5000 --buttons=1,1,1,1,1,1,1,1,1,1 --no-close --png=scratch/winamp.png
```

- Runs 100K+ API calls through 50K batches without crashing
- Creates "Winamp 2.91" main window and enters message loop
- Processes WM_PAINT, WM_TIMER, WM_COMMAND, WM_ACTIVATE
- **Window rendered at 0×0 pixels** — blank screen

## Blocking Issue: Main Window Has Zero Size

The main window is created with `CreateWindowExA(..., x=26, y=29, cx=0, cy=0)`, class name `"Winamp v1.x"`. Winamp deliberately creates the window at size 0 and resizes later via `MoveWindow` after loading its skin.

### Bug Fixed: WndProc Detection

**Previously:** `$wndproc_addr` was captured from the first `RegisterClassA` call, which came from **comctl32.dll** (during DllMain). This gave wndproc `0x004eddb1` (DLL space), not Winamp's actual WndProc.

**Fix:** Only capture `$wndproc_addr` from EXE-space WndProcs (`>= image_base && < image_base + 0x80000`). Now correctly detects `0x0041c210` as the first EXE WndProc.

### Current State

WM_CREATE IS dispatched synchronously to the WndProc at `0x0041c210`. But the WndProc returns almost immediately (only `GetTickCount` + `TlsGetValue` during WM_CREATE — 4 API calls). No `MoveWindow` or `SetWindowPos` targets the main window.

### Analysis

The startup flow is:
1. `CreateWindowExA` main window (size 0×0) → WM_CREATE does almost nothing
2. `CreateWindowExA` child window → `ShowWindow`
3. First-run "User information" `DialogBoxParamA` (modal) → user clicks Next
4. Survey HTTP POST attempt (socket fails → gives up gracefully)
5. `ShowWindow(main, SW_SHOWNA)` + `SetForegroundWindow` + `SetTimer(42)`
6. Enters `GetMessage/DispatchMessage` loop
7. WM_TIMER fires but doesn't trigger MoveWindow

### Root Cause Hypothesis

Winamp's WM_CREATE handler likely checks a global/config flag to decide whether to initialize the skin engine. On first run, the `winamp.ini` file doesn't exist, so the skin loading path may be skipped or takes a different code path that doesn't call MoveWindow.

Alternatively: The WndProc at `0x0041c210` may NOT be the correct WndProc for "Winamp v1.x". There are 8 RegisterClassA calls from the EXE (#421-#429), each registering a different class. The class_table_lookup needs to correctly match "Winamp v1.x" to the right WndProc.

### What's Needed

1. **Verify class→WndProc mapping** — dump the class table to confirm "Winamp v1.x" maps to the correct WndProc (not `0x0041c210` but the actual main WndProc)
2. **Trace WM_CREATE execution** — break at the WndProc entry with single-step to see what it does
3. **winamp.ini** — Winamp reads config from `winamp.ini` via GetPrivateProfileString. The INI file doesn't exist on first run, so all reads return defaults. Check if any critical setting is missing.

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
- **WM_PAINT** (0x0F): Dispatched to WndProc but window is 0×0
- **WM_COMMAND** (0x111): Many command messages dispatched (init-time menu setup?)
- **WM_ACTIVATE** (0x06): Falls through to DefWindowProcA
- **WM_ERASEBKGND** (0x14): Falls through to DefWindowProcA

## Difficulty: Medium-Hard

The skin bitmap loading and GDI double-buffered drawing pipeline is the main challenge. Winamp doesn't use standard Win32 controls for its main UI — everything is custom-drawn via GDI onto a borderless window.
