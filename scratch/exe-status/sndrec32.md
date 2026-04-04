# Sound Recorder (sndrec32.exe) -- Win98

**Status:** FAIL
**Crashes on:** table index out of bounds (batch 2)
**API calls:** 333

## Crash Details

sndrec32 actually gets much further than previously documented. It completes CRT init, creates a dialog (hwnd 0x10002) with child controls (0x000200cd, 0x000200ce), processes WM_INITDIALOG with extensive control setup. It crashes at batch 2 after 333 API calls.

**Root cause:** `CallWindowProcA(0x00000000, 0x000200cd, 0x55, ...)` -- the wndproc is **NULL** (0x00000000). The app subclasses dialog controls using SetWindowLongA(hwnd, GWL_WNDPROC, newProc) but the original wndproc stored by the emulator is 0. When SendMessageA dispatches to the control via CallWindowProcA, it tries to call address 0, which the decoder translates to an invalid table index.

**Crash sequence:**
1. CreateWindowExA creates control hwnd 0x000200cd (class from 0x00412124)
2. SetWindowLongA(0x000200ce, GWL_WNDPROC=-4, 0x0040806a) -- subclass the control
3. SendMessageA(0x00010001, 0x404, ...) triggers message to child 0x000200cd
4. GetPropA(0x000200cd, ...) fetches subclass data
5. CallWindowProcA(0x00000000, ...) -- boom, NULL wndproc

**Key insight:** The child control hwnd 0x000200cd was created with a registered class wndproc, but the window table doesn't preserve the class's default wndproc. When SetWindowLongA(GWL_WNDPROC) replaces it, the old value returned is 0 instead of the class wndproc. The app saves this 0 and later calls CallWindowProcA with it.

## What Needs to Be Fixed

**SetWindowLongA(GWL_WNDPROC) must return the previous wndproc.** Currently when a window is created with a class-registered wndproc (like a standard control), the window table stores the wndproc. But GetWindowLong/SetWindowLong for GWL_WNDPROC (-4) likely returns 0 instead of the stored wndproc. The fix is:
1. Ensure CreateWindowEx stores the class wndproc in the window table
2. SetWindowLongA(GWL_WNDPROC) returns the old value before overwriting
3. For built-in control classes (edit, button, static, etc.), return DefWindowProcA thunk or a proper default handler address

## Difficulty: Medium

Requires ensuring the window table tracks wndproc per-hwnd and that SetWindowLongA correctly returns the previous value for GWL_WNDPROC.
