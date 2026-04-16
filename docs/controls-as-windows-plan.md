# Plan: Controls as Real Windows

## Problem

Currently, dialog controls (buttons, checkboxes, edit fields, static text) are rendered as dumb visual elements by the JS renderer. They don't have HWNDs, WndProcs, or message handling. APIs like `IsDlgButtonChecked`, `GetDlgItemText`, `SendDlgItemMessage` are implemented as special-case hacks with side tables (`ctx._checkStates`, renderer control arrays).

In real Win32, every control IS a window — it has an HWND, a WndProc (e.g., `ButtonWndProc`), and responds to messages like `BM_SETCHECK`, `BM_GETCHECK`, `WM_SETTEXT`, `WM_GETTEXT`, etc.

## Goal

Make controls proper windows so that `SendMessage(ctrl_hwnd, BM_GETCHECK, 0, 0)` works the same as `IsDlgButtonChecked`. Apps that talk to controls via messages (most real Win32 apps) will just work.

## Architecture

### HWND allocation for controls

- During `CreateDialogParam` / dialog resource parsing, each control gets a real HWND via the existing `$next_hwnd` counter
- Control HWNDs are child windows of the dialog HWND
- `GetDlgItem(hDlg, ctrlId)` maps control ID → child HWND (currently fakes it with `0x0002xxxx`)

### Built-in WndProcs for control classes

Register built-in WAT-native WndProcs for standard classes:
- **Button** (`$button_wndproc`): handles `BM_SETCHECK`, `BM_GETCHECK`, `BM_SETSTATE`, `BM_CLICK`, `WM_SETTEXT`, `WM_GETTEXT`
- **Edit** (`$edit_wndproc`): handles `WM_SETTEXT`, `WM_GETTEXT`, `EM_SETSEL`, `EM_LIMITTEXT`
- **Static** (`$static_wndproc`): handles `WM_SETTEXT`, `WM_GETTEXT`, `STM_SETIMAGE`
- **ListBox** (`$listbox_wndproc`): handles `LB_ADDSTRING`, `LB_GETCOUNT`, `LB_GETCURSEL`
- **ComboBox** (`$combobox_wndproc`): handles `CB_ADDSTRING`, `CB_GETCURSEL`, `CB_SETCURSEL`

These can live in `09c-help.wat` or a new `09c3-controls.wat`.

### Per-control state storage

Each control HWND needs a small state block in WASM memory:
- Control type (button/edit/static/list/combo)
- Control ID
- Parent HWND
- Check state (for buttons)
- Text pointer + length
- Selection state

Could use a fixed-size struct per HWND slot in the existing window table area, or allocate from heap.

### Message routing

`SendMessage(ctrl_hwnd, msg, wParam, lParam)` already routes through `$wnd_table_get` to find the WndProc. If the WndProc is a built-in control proc (identified by a sentinel like `0xFFFF0002`+class), dispatch to the WAT handler directly via `$wat_wndproc_dispatch`.

### Migration path

1. Keep existing JS-side `checkDlgButton` / `setControlText` for rendering
2. Add WAT-side state so message-based APIs work
3. `IsDlgButtonChecked` → `SendMessage(GetDlgItem(hdlg, id), BM_GETCHECK, 0, 0)` internally
4. Eventually remove special-case APIs as they become thin wrappers around SendMessage

## Files to modify

- `09c-help.wat` or new `09c3-controls.wat` — control WndProcs
- `09a5-handlers-window.wat` — CreateDialogParam to allocate HWNDs for controls
- `09a-handlers.wat` — simplify IsDlgButtonChecked/GetDlgItemText to use SendMessage
- `lib/host-imports.js` — create_window calls for control HWNDs
- `lib/renderer.js` — map control HWNDs to visual elements
