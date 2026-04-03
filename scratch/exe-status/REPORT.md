# Wine-Assembly EXE Status Report

**Date:** 2026-04-03
**Score:** 18 PASS / 13 FAIL / 14 WARN / 0 SKIP (45 total)

## PASS (18) — Window created, running

| EXE | APIs | Notes |
|-----|------|-------|
| Notepad | 47 | Clean |
| Calculator | 39 | Clean |
| SkiFree | 61 | Clean |
| FreeCell | 80 | Clean |
| Solitaire | 83 | Clean |
| Cruel | 56 | Clean |
| Golf | 63 | Clean |
| Pegged | 66 | Clean |
| Rattler Race | 82 | Clean |
| Taipei | 69 | Clean |
| TicTacToe | 74 | Clean |
| Minesweeper (XP) | 107 | Clean |
| Reversi | 66 | Clean |
| Minesweeper (WEP) | 78 | Clean |
| Media Player | 71 | Clean |
| System Monitor | 68 | Clean |
| Notepad (98) | 47 | Clean |
| Space Cadet Pinball | 103 | Clean |

## FAIL (13) — Crashes on unimplemented API

### Easy fixes (1-2 APIs needed)

| EXE | Crash API | What's Needed | Difficulty |
|-----|-----------|---------------|------------|
| **Calculator (XP)** | UnhookWindowsHook | Add to api_table + trivial handler (return TRUE) | Easy |
| **Kodak Preview** | GetWindowPlacement | Fill WINDOWPLACEMENT struct with defaults | Easy |
| **Media Player 32** | GetWindowTextW | Implement wide GetWindowText (wsprintfW now works!) | Easy |

### Medium fixes (specific API implementation)

| EXE | Crash API | What's Needed | Difficulty |
|-----|-----------|---------------|------------|
| **RegEdit** | GetCurrentObject (GDI) | Track current font/brush/pen per DC, return valid handle | Medium |
| **MSPaint (Win98)** | WM_PAINT loop | InvalidateRect/BeginPaint/EndPaint need to properly clear invalid region | Medium |

### Hard fixes (infrastructure needed)

| EXE | Crash API | What's Needed | Difficulty |
|-----|-----------|---------------|------------|
| **MSPaint (NT)** | RaiseException (C++) | Full SEH + C++ exception unwinding | Hard |
| **Explorer (98)** | RaiseException | SEH exception handler chain | Hard |
| **WordPad** | ResumeThread | Multi-threading support | Hard |
| **Win98 Tour** | TlsGetValue loop | Debug TLS persistence across DLL init | Medium |
| **Telnet** | WSAStartup (WSOCK32 ordinal) | Winsock DLL + networking layer | Hard |
| **Task Manager** | SHELL32 ordinal 181 | RunFileDlg ordinal import + implementation | Hard |
| **HyperTerminal** | InitInstance | Missing HYPERTRM.dll | Easy (need DLL) |
| **Kodak Imaging** | ?UpdateVersion@@ | Missing IMGCMN.dll + Wang Imaging OCX DLLs | Hard |

## WARN (14) — Runs but no window created

### Close to PASS (likely test harness or minor fix)

| EXE | APIs | Issue | Fix |
|-----|------|-------|-----|
| **Disk Cleanup** | 862 | Dialog-based UI working, test doesn't detect it | Update test harness |
| **Sound Recorder (XP)** | 246 | Has message loop running, test doesn't detect window | Update test harness |

### Need audio hardware emulation

| EXE | APIs | Issue |
|-----|------|-------|
| **Volume Control** | 163 | Exits: no mixer device |
| **Volume (98)** | 163 | Same binary as sndvol32 |
| **CD Player** | 153 | Exits: no CD drive |
| **Sound Recorder** | 151 | Stuck in CRT init |

### Stuck in MFC/CRT init loop

| EXE | APIs | Issue |
|-----|------|-------|
| **Write** | 31 | MFC CriticalSection loop |
| **IP Config** | 147 | MFC CriticalSection loop |
| **XP End of Life** | 54 | MFC CriticalSection loop |

### Missing DLLs

| EXE | APIs | Missing DLLs |
|-----|------|-------------|
| **Font Viewer** | 3 | MFC30.DLL, MSVCRT20.dll, LZ32.dll, VERSION.dll |

### Other

| EXE | APIs | Issue |
|-----|------|-------|
| **Welcome (98)** | 91 | Blocked on registry query |
| **Resource Meter** | 27 | Needs modal DialogBoxParamA |
| **WinAmp Installer** | 474 | NSIS extraction loop (ReadFile) |
| **mIRC Installer** | 0 | PE loading failure |

## Missing DLLs Summary

| DLL | Needed By | Available From |
|-----|-----------|---------------|
| HYPERTRM.dll | HyperTerminal | Win98 system files |
| IMGCMN.dll | Kodak Imaging | Win98 system files (Wang Imaging) |
| WSOCK32.dll | Telnet | Win98 system files |
| MFC30.DLL | Font Viewer | Win98 or VC++ 2.0 redist |
| MSVCRT20.dll | Font Viewer | Win98 system files |
| LZ32.dll | Font Viewer | Win98 system files |
| VERSION.dll | Font Viewer | Win98 system files |
| OICOM400.dll+ | Kodak Imaging | Wang Imaging suite |

## Infrastructure Gaps

1. **SEH (Structured Exception Handling)** — Blocks Explorer, MSPaint NT, and any app using C++ exceptions. Requires walking the FS:[0] exception chain and calling handlers.

2. **Multi-threading** — Blocks WordPad. CreateThread works but ResumeThread/thread scheduling is not implemented.

3. **MFC CriticalSection init loop** — Blocks Write, IP Config, XP End of Life, Sound Recorder. MFC's class factory registration enters an infinite loop. May be related to missing OLE/COM init.

4. **Ordinal imports** — Task Manager (SHELL32 #181) and Telnet (WSOCK32 #115) import by ordinal. The hash-based name→ID lookup can't resolve these.

5. **GDI object tracking** — RegEdit needs GetCurrentObject to return the selected font/brush/pen from DC state.

## Quick Wins (ordered by effort)

1. **UnhookWindowsHook** → Calculator XP to PASS (add API + 3-line handler)
2. **GetWindowPlacement** → Kodak Preview past crash (fill struct with defaults)  
3. **GetWindowTextW** → Media Player 32 past crash (read window title)
4. **Test harness update** → Disk Cleanup + Sound Recorder XP to PASS (detect dialogs)
5. **GetCurrentObject** → RegEdit past crash (GDI DC tracking)
