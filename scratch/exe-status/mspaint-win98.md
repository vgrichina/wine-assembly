# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: FAIL (stuck in message loop)

## Crash Point
Not a hard crash -- gets STUCK at EIP=0x01000000 (thunk dispatch) after DispatchMessageA. The emulator enters an infinite loop dispatching WM_PAINT (0x000f) messages to the main window's wndproc, which keeps returning to the message pump.

## API Call Sequence (leading to stuck)
- GetMessageA returns WM_TIMER (0x0113) and WM_PAINT (0x000f) messages
- TranslateMessage + DispatchMessageA dispatches them
- WndProc calls CallWindowProcA -> DefWindowProcA for WM_PAINT
- PeekMessageA finds no messages, GetMessageA called again
- Loop repeats with the same WM_PAINT pattern indefinitely
- 1634 API calls completed before hitting max batches

## Key APIs in the loop
- GetMessageA, TranslateMessage, DispatchMessageA
- CallWindowProcA, DefWindowProcA
- PeekMessageA, GetParent, GetWindowLongA, GetWindow
- TlsGetValue (MFC thread-local state), Enter/LeaveCriticalSection

## What Needs to Be Implemented
The message loop itself works but the app is stuck repainting. The issue is likely that:
1. WM_PAINT handling via DefWindowProcA does not properly validate the window (BeginPaint/EndPaint not clearing the invalid region)
2. The app keeps getting WM_PAINT because InvalidateRect damage is never consumed
3. The wndproc at 0x02e026f8 dispatches to MFC message map but paint never completes

## Difficulty: Medium
The message loop infrastructure works. The fix is likely in the WM_PAINT/BeginPaint/EndPaint cycle not properly clearing the update region, causing infinite repaints.
