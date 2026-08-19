# Kodak Preview (test/binaries/win98-apps/kodakprv.exe)

## Status: FAIL (crash)

## Crash Point
Crashes on API #356: GetWindowPlacement(0x00010006, ...) -- unnamed in trace output
- API ID 356 = GetWindowPlacement (2 args, stdcall)
- EIP at crash: 0x004070a2 (jmp [0x41243c] -- import table jump)
- Crashes at batch 5

## API Call Sequence Leading to Crash
1. LoadStringA, SendMessageA, GetWindowLongA -- standard window init
2. IsBadReadPtr, MultiByteToWideChar, LocalAlloc -- string handling
3. GetClientRect, InvalidateRect, UpdateWindow -- window painting
4. CreateCompatibleDC, GetSysColor, DeleteDC -- GDI operations
5. SendMessageA(WM_USER+1=0x401) -- custom toolbar messages
6. CreateWindowExA -- creates toolbar (hwnd=0x10005) and status bar
7. SetWindowLongA (subclassing), SendMessageA, CallWindowProcA
8. LoadStringA, CreateFontIndirectA, SendMessageA(WM_SETFONT)
9. EnableWindow, GetClientRect, GetWindowRect, ScreenToClient
10. CreateWindowExA -- creates another child window (hwnd=0x10006, style=0x52800000)
11. **GetWindowPlacement(0x00010006, ...)** -- crashes, unimplemented

## What Needs to Be Implemented
1. **GetWindowPlacement** -- returns WINDOWPLACEMENT struct with window position/show state
2. This is a straightforward API: fill in the struct with current window position from the window table

## Difficulty: Easy
GetWindowPlacement just needs to populate a WINDOWPLACEMENT structure (44 bytes) with the window's current show state, min/max positions, and normal position rectangle. All the data is available in the existing window table. This is a simple struct-filling API.
