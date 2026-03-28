# SkiFree (ski32.exe) — Progress Notes

## Binary Info
- Source: Microsoft Entertainment Pack, `test/binaries/entertainment-pack/ski32.exe`
- Size: 118,784 bytes
- PE with 4 sections: .text, .rdata, .data, .rsrc
- Resources: 0 menus, 0 dialogs, 17 strings, 2 icons, bitmap resources (not parsed)
- Imports from: KERNEL32, USER32, GDI32, WINMM
- Two window classes: "SkiMain" (WndProc=0x405800), "SkiStatus" (WndProc=0x4068d0)

## Current Status
- **CRT startup completes successfully** — all Heap*, Virtual*, CRT init APIs work
- **Window created** — "SkiFree" title bar shows, game enters message loop
- **Timer running** — WM_TIMER messages dispatched to timer callback 0x4047c0
- **BLOCKED**: Timer callback does nothing because `[0x40c67c]` (game-running flag) = 0
- **ROOT CAUSE**: RegisterClassA is never called → wndproc_addr = 0 → DispatchMessageA can't call WndProc → WM_ACTIVATE/WM_SIZE never processed → game never starts

## Key Discovery: Init Path Bypass
The game's window creation function at 0x405470 (which calls RegisterClassA, CreateWindowExA with WndProcs) is **never reached**. Instead, CreateWindowExA is called from a different code path (possibly the CRT _initterm chain or a WinMain variant). The RegisterClassA call at 0x4054dd is bypassed entirely.

Need to trace: What path actually creates the windows? Why is 0x405470 skipped?

WinMain is at 0x4047e0. It calls:
1. 0x4048c0 — alloc init (works, returns 1)
2. 0x404970 — game state init (works, returns 1)
3. 0x4052d0 — window creation (called via `call 0x4052d0` at 0x40482c)

But 0x4052d0 is **never reached** per breakpoint testing. This means WinMain itself isn't being called, OR the call at 0x40482c is skipped.

## Bugs Fixed
- [x] `66` prefix for ALU r/m (0x81 group) — 16-bit immediate was correct but operation was 32-bit
- [x] `66` prefix for ALU reg-mem (0x00-0x3D) — added 16-bit handlers (159-162)
- [x] `66` prefix for MOV r/m (0x89/0x8B) — added 16-bit load/store handlers (163-166)
- [x] `66` prefix for MOV [mem], imm (0xC7) — fetch 16-bit immediate
- [x] GetStringTypeA/W byte offset was 12, should be 13
- [x] Multiple WndProc support — first RegisterClassA sets main, second sets child

## APIs Implemented (new for ski32)
### KERNEL32
- HeapCreate/HeapAlloc/HeapFree/HeapReAlloc/HeapDestroy
- VirtualAlloc/VirtualFree
- GetACP, GetOEMCP, GetCPInfo
- MultiByteToWideChar, WideCharToMultiByte
- GetStringTypeA/W, LCMapStringA/W
- GetStdHandle, GetFileType, WriteFile, SetHandleCount
- GetEnvironmentStrings/W, FreeEnvironmentStringsA/W
- GetModuleFileNameA, UnhandledExceptionFilter
- GetCurrentProcess, TerminateProcess, GetTickCount
- FindResourceA, LoadResource, LockResource, FreeResource
- RtlUnwind, FreeLibrary

### USER32
- FillRect, FrameRect, LoadBitmapA, OpenIcon
- WM_TIMER dispatch with callback (DispatchMessageA)
- Timer support in GetMessageA (generates WM_TIMER when idle)
- WM_ACTIVATE message delivery

### GDI32
- PatBlt, CreateBitmap, TextOutA

### WINMM
- sndPlaySoundA (stub)

## Next Steps
1. **Find why 0x4052d0/0x405470 is never called** — trace CRT _initterm → WinMain entry
2. **OR: set wndproc directly** from CreateWindowExA by reading the class name and finding the registered wndproc
3. Once WndProc works: WM_ACTIVATE → game starts → timer callback does work → rendering begins
4. Implement proper resource loading (bitmaps) for sprite rendering
