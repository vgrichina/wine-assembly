# Disk Cleanup (cleanmgr.exe) — Win98

**Status:** WARN (862 APIs, no window)

## Behavior
Gets very far — 862 API calls! Creates dialogs, sends messages (WM_COMMAND etc.), calls GetDlgItem, SetFocus. It's running but the test doesn't detect a window because it uses dialog-based UI rather than CreateWindow.

## Last APIs
SendMessageA(hwnd, WM_COMMAND, ...) → GetDlgItem(hwnd, 999) → SetFocus(child)

## Blocking Issue
May actually be close to working — the dialog-based UI is created but not detected as "window created" by the test harness (which looks for [CreateWindow] in output). Need to check if it's actually showing a dialog.

## What's Needed
- Check if CreateDialogParamA or DialogBoxParamA creates the UI correctly
- The test harness may need updating to detect dialog-based apps as PASS
- May need full message loop support for the dialog

## Difficulty: Easy (possibly just a test harness fix)
