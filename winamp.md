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

## Current Blocking Issue: Idle Message Loop

After first-run dialog and initial setup, the message loop receives only WM_NULL (49,998 out of 50,013 dispatched messages). Only 1 WM_TIMER, 2 WM_PAINT, 9 WM_COMMAND. The program is effectively idle — no skin drawing, no further initialization.

### What's Needed

1. **Skin loading** — Winamp loads BMP files for its custom-drawn UI. No skin files exist in VFS. The classic skin may need to be extracted from resources or provided as files.
2. **WM_TIMER handler** — timer 42 fires but doesn't trigger any visible work. May need config/INI values.
3. **winamp.ini** — Winamp reads config via GetPrivateProfileString. Missing INI may cause skin engine to skip initialization.

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
