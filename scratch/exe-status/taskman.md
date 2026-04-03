# taskman.exe (Task Manager) - Win98

**Status:** FAIL
**Crashes on:** SHELL32.dll ordinal 181 (RunFileDlg - undocumented)
**Batch reached:** 0

## Crash Details

Taskman initializes successfully -- creates its main dialog window with a listbox, registers for drag-drop, reads registry settings, draws its UI with MultiByteToWideChar text conversion. Then it calls SHELL32 ordinal 181 which is `RunFileDlg`, an undocumented Shell32 API that opens the "Run..." dialog.

The import is by ordinal (not by name), so the hash-based API name lookup fails. The dispatch table has no entry for it, and the API shows as unnamed `(0x00010001, 0x00000001, 0x00400000, 0x00000000, 0x00000000, 0x00000000)`.

EIP at crash: `0x004015e6` -- calling `[0x409414]` which is the IAT entry for SHELL32 ordinal 181.

Call args: `RunFileDlg(hwnd=0x10001, hIcon=NULL, workingDir=NULL, title=NULL, description=NULL, flags=0)`

## API Call Sequence (257 calls before crash)

Key APIs:
- GetModuleHandleA, GetCommandLineA, GetStartupInfoA
- DialogBoxParamA (creates main dialog)
- DragAcceptFiles, GetWindowLongA, SetWindowLongA
- CreateWindowExA (listbox child)
- RegOpenKeyExA, RegQueryValueExA x multiple (window position)
- GetDC, SelectObject, GetTextExtentPoint32A (font measurement)
- MultiByteToWideChar x many (text conversion)
- CreateWindowExA (another child window, style 0x54100b51)
- **SHELL32 ordinal 181 (RunFileDlg)** -- CRASH

## What Needs to Be Implemented

1. Ordinal-based import resolution for SHELL32.dll -- the emulator needs to map SHELL32 ordinal 181 to a name so it can dispatch it.
2. `RunFileDlg` handler -- this is an undocumented API: `void RunFileDlg(HWND hwndOwner, HICON hIcon, LPCSTR lpszWorkingDir, LPCSTR lpszTitle, LPCSTR lpszDescription, UINT uFlags)`. It displays the Run dialog.

## Difficulty: Hard

Two separate problems: (1) ordinal-to-name mapping for SHELL32 (infrastructure), and (2) implementing the Run dialog which is a complex UI element with file browsing, command history, and process launching. A minimal stub that does nothing might get past the crash but Task Manager's core purpose is launching programs via Run dialog.
