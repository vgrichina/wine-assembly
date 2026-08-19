# Sound Recorder XP (sndrec32.exe) — XP

**Status:** WARN (55→246 APIs, no window detected but has message loop!)

## Behavior
Actually gets quite far — enters a GetMessageW/TranslateMessage/DispatchMessageW message loop. DefWindowProcA is called for WM_PAINT. The app IS running but the test harness doesn't detect a window.

## Last APIs
GetWindowLongA(0, 0) → DefWindowProcA(0, WM_PAINT, 0, 0) → GetMessageW → TranslateMessage → DispatchMessageW (loop)

## Blocking Issue
The test harness looks for `[CreateWindow]` in verbose output but this app likely creates its window via CreateDialogParam or a DLL-loaded dialog. The window creation may be working but not logged.

## What's Needed
- Update test harness to detect dialog-based window creation
- Check if RegisterClipboardFormatW/CreateWindowExW is being called but not logged
- May already be a PASS if the test harness is updated

## Difficulty: Easy (likely test harness detection issue)
