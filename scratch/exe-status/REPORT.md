# Wine-Assembly EXE Status Report

**Date:** 2026-04-04
**Score:** 25 PASS / 7 FAIL / 13 WARN / 0 SKIP (45 total)

## Changes This Session

- Fixed DefWindowProc WM_CLOSE: only sets quit_flag for main/dialog window (was causing premature exit)
- Fixed CW_USEDEFAULT window size: defaults to 427x320 instead of 0x80000000 (was breaking card position calculations)
- +2 PASS from last report, several apps now render correctly that didn't before

## PASS (25) — Window created, message loop running

| EXE | APIs | Notes |
|-----|------|-------|
| Notepad | 43 | Clean, renders correctly |
| Calculator | 39 | Creates msg pump window only (XP calc needs dialog) |
| SkiFree | 59 | Renders splash screen with sprites |
| FreeCell | 91 | Shows card cells, some cards visible |
| Solitaire | 88 | Card back + status bar visible |
| MSPaint (Win98) | 132 | Toolbar renders |
| Cruel | 65 | **Full card game with all cards rendered** |
| Golf | 69 | **Card columns + draw pile rendered** |
| Pegged | 66 | **3D peg board with blue marbles** |
| Rattler Race | 79 | Snake game board with score |
| Taipei | 69 | Green table (tiles need init) |
| TicTacToe | 73 | Window + menus (grid flickers) |
| Minesweeper (XP) | 106 | Window + menus (grid needs init) |
| Reversi | 66 | **8x8 board with starting pieces** |
| Minesweeper (WEP) | 76 | Counters + black grid area |
| Media Player | 64 | Window created, no ShowWindow |
| Sound Recorder | 103 | Window + transport buttons |
| RegEdit | 56 | Treeview + menus |
| System Monitor | 66 | Window + 5-item menu bar |
| Resource Meter | 12 | Dialog created |
| Disk Cleanup | 59 | Dialog created |
| Notepad (98) | 43 | Full notepad with edit area |
| Sound Recorder (XP) | 55 | Dialog + controls |
| Space Cadet Pinball | 107 | Pinball table renders |
| Kodak Preview | 53 | 6 windows created |

## FAIL (7) — Crashes

| EXE | Crash | Root Cause | Difficulty |
|-----|-------|------------|------------|
| MSPaint (NT) | RaiseException | C++ exception (0xe06d7363) during MFC init — needs SEH exception dispatch | Hard |
| WordPad | ResumeThread | MFC app needs thread creation support | Hard |
| Kodak Imaging | ?UpdateVersion@@YGJH@Z | Calls undecoded C++ mangled export from oieng400.dll | Hard |
| HyperTerminal | InitInstance | MFC app, gets past CRT init but InitInstance is app-specific code, not a Win32 API | Medium |
| Explorer (98) | RaiseException | Uses GetProcAddress for ordinal export, fails, raises exception | Hard |
| Task Manager | SetWindowLongA | Memory OOB during dialog init after window subclass — complex batch execution issue | Hard |
| Telnet | RegCloseKey | Loads WSOCK32.dll for networking, crashes on first winsock call (thunk not set up) | Hard |

## WARN (13) — No window created, no crash

| EXE | APIs | Root Cause | Fixable? |
|-----|------|------------|----------|
| Write | 32 | ShellExecute launcher — calls ShellExecuteA to launch wordpad.exe, then exits | Expected |
| CD Player | 26 | No CD drive — calls GetLogicalDrives/GetDriveTypeA, finds no CD, shows MessageBox, exits | Expected |
| Media Player 32 | 54 | MFC app stuck in init — SetEvent returns 0, enters loop waiting for event | Medium |
| Font Viewer | 3 | Only 3 APIs (_controlfp) — something wrong very early in CRT init | Unknown |
| Volume Control | 39 | No mixer — mixerGetID fails, app exits normally | Expected |
| Welcome (98) | 29 | Jumps to MZ header (EIP=0x00905a4d) — bad indirect call/jump target | Hard |
| Win98 Tour | 60 | MFC init loop — 388 API calls in 80 batches, all CriticalSection/TlsGetValue, never reaches WinMain | Needs more batches |
| IP Config | 38 | Requires WS2_32.dll (winsock) — no network support | Expected |
| Volume (98) | 39 | Same as sndvol32 — no mixer device | Expected |
| Calculator (XP) | 47 | MFC init — registers classes but stuck in CriticalSection loop | Needs more batches |
| XP End of Life | 55 | MFC init — same pattern, never reaches CreateWindow | Needs more batches |
| WinAmp Installer | 38 | NSIS installer — exits after checking system | Medium |
| mIRC Installer | 0 | Zero API calls — likely format issue or import failure | Unknown |

## Quick Wins (most impactful fixes)

1. **mplay32.exe**: Needs SetEvent to return success (1) and MsgWaitForMultipleObjects
2. **tour98/claass/xp_eos**: Just need more batches in test (increase max-batches for MFC apps)
3. **fontview.exe**: Debug why only 3 API calls — likely CRT init issue
4. **HyperTerminal**: InitInstance might just need to return success
