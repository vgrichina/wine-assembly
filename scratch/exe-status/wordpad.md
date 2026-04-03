# WordPad (test/binaries/win98-apps/wordpad.exe)

## Status: FAIL (crash)

## Crash Point
Crashes on API #791: ResumeThread(0x000e0003)
- EIP at crash: 0x0104a5d4
- Crashes at batch 5

## API Call Sequence Leading to Crash
1. RegOpenKeyExA -- opens registry key
2. TlsGetValue calls (MFC thread-local state)
3. FindResourceA + LoadMenuA + LoadAcceleratorsA (loads menus for IDs 4, 5, 6)
4. GetCursorPos
5. CreateEventA x2 -- creates two manual-reset events (handles 0xe0001, 0xe0002)
6. Enter/LeaveCriticalSection
7. **CreateThread(0, 0, 0x011227c5, 0x01166870, CREATE_SUSPENDED=4, ...)** -- creates suspended thread, returns handle 0xe0003
8. **ResumeThread(0x000e0003)** -- tries to resume the thread, crashes

WordPad loads 3 different menu/accelerator sets and then creates a background worker thread (likely for OLE/COM or file I/O). After CreateThread with CREATE_SUSPENDED flag, it calls ResumeThread to start it.

## What Needs to Be Implemented
1. **ResumeThread** -- needs real implementation that actually resumes a suspended thread
2. This requires the **thread-manager.js** multi-thread support to actually work with CreateThread
3. CreateThread currently returns a fake handle but ResumeThread has no implementation

The thread entry point is at 0x011227c5 with parameter 0x01166870. WordPad uses this for background initialization (likely OLE subsystem).

## Difficulty: Hard
Requires real multi-threading support. CreateThread needs to spawn a new execution context (via thread-manager.js), and ResumeThread needs to activate it. This is a fundamental architecture feature, not just a simple API stub.
