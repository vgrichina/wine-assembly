# Resource Meter (rsrcmtr.exe) — Win98

**Status:** WARN (27 APIs, no window)

## Behavior
Creates a dialog (CreateDialogParamA id=100), opens registry key, then calls DialogBoxParamA(id=101) which is a modal dialog. The modal dialog blocks.

## Last APIs
CreateDialogParamA(0x400000, 100, 0, 0, 0) → RegOpenKeyA(HKCU, "Software\\...") → DialogBoxParamA(0x400000, 101, hwnd, dlgproc, 0)

## Blocking Issue
DialogBoxParamA needs full modal dialog loop implementation — create dialog, run internal message pump, return result. Currently likely returns immediately without showing the dialog.

## What's Needed
- DialogBoxParamA needs to create the dialog, send WM_INITDIALOG, and run a message loop
- The dialog callback (dlgproc) needs to be called with messages

## Difficulty: Medium (modal dialog message loop)
