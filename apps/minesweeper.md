# Minesweeper (Windows XP)

Classic Minesweeper from Windows XP. 32-bit PE, pure Win32 API with COMCTL32 dependency.

## Binary Info

- **File:** `test/binaries/xp/winmine.exe`
- **Image base:** 0x01000000
- **Entry point:** 0x01003E21 (CRT startup)
- **Sections:** .text (0x3A56), .data (0xB98), .rsrc (0x19160)

## Key Addresses

| Address | Description |
|---------|-------------|
| 0x01003E21 | CRT entry point (WinMainCRTStartup) |
| 0x010021F0 | WinMain |
| 0x01001BC9 | WndProc (registered in WNDCLASS at WinMain+0x6D) |
| 0x01001950 | Window sizing/layout function |
| 0x01001915 | GetSystemMetrics helper (called for window chrome) |
| 0x01002B14 | Post-CreateWindow init |
| 0x01003AB0 | Early init (called from WinMain) |

## Import Table (key entries)

| IAT Address | Function | Notes |
|-------------|----------|-------|
| 0x100111C | GetMenuItemRect | Used in sizing function to detect menu wrap |
| 0x1001118 | MoveWindow | Used in sizing function to resize window |
| 0x1001114 | SetRect | Used after sizing to set invalidation rect |
| 0x1001110 | InvalidateRect | Triggers repaint after resize |
| 0x100115C | CreateWindowExW | Main window creation |
| 0x10010CC | RegisterClassW | |
| 0x10010D4 | LoadMenuW | Menu resource 0x1F4 (500) |
| 0x1001160 | LoadAcceleratorsW | Accelerator table 0x1F5 (501) |
| 0x10010AC | LoadIconW | Icon resource 0x64 (100) |
| 0x100101C | InitCommonControlsEx | COMCTL32 init |
| 0x1001028 | GetLayout | GDI RTL layout support |
| 0x100102C | SetLayout | GDI RTL layout support |
| 0x100104C | SetDIBitsToDevice | Bitmap rendering |

## DLL Dependencies

- **msvcrt.dll** — C runtime (loaded as DLL)
- **USER32.dll** — 23 imports (windowing, messages, menus, dialogs)
- **GDI32.dll** — 15 imports (drawing, DC management, bitmaps)
- **KERNEL32.dll** — 13 imports (resources, strings, module info)
- **ADVAPI32.dll** — 6 imports (registry for settings persistence)
- **COMCTL32.dll** — 1 import (InitCommonControlsEx)
- **SHELL32.dll** — 1 import (ShellAboutW for Help>About)
- **WINMM.dll** — 1 import (PlaySoundW for win/lose sounds)

## Window Sizing Function (0x01001950)

This is the most interesting early code path. Minesweeper computes its window size from the grid dimensions and menu bar height:

1. `mov edi, [0x100111C]` — loads GetMenuItemRect function pointer
2. Calls GetMenuItemRect twice (items 0 and 1), compares `.top` fields to detect menu row wrapping
3. Computes: `width = cols*16 + 24`, `height = rows*16 + 67`
4. Calls GetSystemMetrics (SM_CXFRAME, SM_CYFRAME, SM_CYCAPTION) for window chrome
5. Calls MoveWindow (ESI = `[0x1001118]`) to resize
6. Second pass of GetMenuItemRect to re-check after resize
7. SetRect + InvalidateRect to trigger repaint

## Global Variables (.data section, base 0x01005000)

| Address | Description |
|---------|-------------|
| 0x1005334 | Grid columns |
| 0x1005338 | Grid rows |
| 0x1005B24 | Main window handle (hWnd) |
| 0x1005B28 | Icon handle |
| 0x1005B30 | hInstance |
| 0x1005B34 | Menu bar height adjustment |
| 0x1005B38 | Minimized flag |
| 0x1005B80 | Saved window height |
| 0x1005B88 | Computed window height |
| 0x1005AA0 | Window class name string |
| 0x1005A90 | Window border offset |
| 0x1005A94 | Menu handle |
| 0x10056B0 | Window X position |
| 0x10056B4 | Window Y position |
| 0x10056C4 | Layout flags |
| 0x1005B2C | Computed client width |
| 0x1005B20 | Computed client height |

## Click Handler Flow (0x0100140C)

After WM_LBUTTONDOWN, the click handler:
1. `PtInRect` — checks if click is on smiley button
2. `SetCapture` — captures mouse
3. Enters tight `PeekMessageW` loop at `0x0100148C` filtering for `WM_MOUSEFIRST(0x200)..0x20D`, waiting for `WM_LBUTTONUP` or `WM_MOUSEMOVE`
4. On WM_LBUTTONUP: `ReleaseCapture`, proceeds to reveal logic

## Mine Placement Function (0x010036C7)

Loop places 10 mines (beginner):
- Calls rand wrapper at `0x01003940` (msvcrt `rand()` + `cdq; idiv` for modulo)
- `test byte [ecx+esi+0x1005340], 0x80` — check if cell already has mine
- `or byte [eax], 0x80` — place mine
- `dec [0x1005330]` — decrement mine counter
- Loop until counter reaches 0

## Cell Drawing Function (0x01002646)

```
movsx edx, byte [edx+eax+0x1005340]  ; read cell value (SIB addressing)
and edx, 0x1f                         ; mask to sprite index 0-31
push [0x1005a20+edx*4]                ; dcArray[index] = source DC handle
; ... BitBlt to window DC
```

DC handle array at `0x1005a20`: 16 entries (0x80002..0x80020), one per sprite (empty, 1-8, mine, flag, etc.)

## Status

- **Current:** PASS — window created, grid renders correctly, clicking reveals cells with correct neighbor counts
- **Rendering:** `--png` output shows proper window with title bar, Game/Help menu, mine grid, smiley button
- **Known issues:**
  - SetROP2 is stubbed (always R2_COPYPEN) — white highlight lines on the 3D border draw gray instead of white

## Open Tasks

- **`$handle_SetDlgItemInt` is a silent return-1 stub** (`src/09a-handlers.wat:1517`). Should locate the edit control by id, write the ASCII integer into its `EditState.text_buf`, and fire WM_SETTEXT so the renderer picks it up. Consequence today: the Custom Field dialog's Height/Width/Mines edit boxes paint empty instead of `8 / 8 / 10`. Violates the "Real implementations" project rule.
- **Cancel button not visible in Custom Field dialog.** Chrome + OK render cleanly, but the Cancel button doesn't appear in the PNG — suspect it's in the RT_DIALOG template but missing from the paint queue pass that runs before the pump yields, or its child rect lies outside the dialog's client-area paint region. Worth checking once SetDlgItemInt is real.
- **Clip-bypass fix's scope is narrow.** The `_drawWithClip` bypass only kicks in when the target hwnd matches `_activeChildDraw.hwnd`. Child-control composites (acd.hwnd = parent) are intentionally unaffected. If a child control's DC carries a clipRgn set during its own BeginPaint, it still clips on its dedicated canvas — revisit if any control paint turns up clipped incorrectly.

## Progress Log

- **Custom Field dialog now renders (both Win98 and XP winmine)**: after WM_INITDIALOG ran `SetDlgItemInt` x3 and `ret 0x10`'d back into the `CACA0004` dlg pump, EIP dropped to 0 and the emulator stalled. Root cause in `13-exports.wat` thunk-zone auto-pop (added in `5291175`): when a continuation thunk re-enters itself by setting `eip = dlg_loop_thunk` (same as `prev_eip`), the `eip == prev_eip` check read that as "handler didn't redirect" and popped `[prev_esp]` (=0) into EIP. Fix: added `$handler_set_eip` flag in `01-header.wat`; `CACA0004` in `09b-dispatch.wat` raises it; `$run` only auto-pops when both `eip == prev_eip` AND `handler_set_eip == 0`. Normal API handlers (e.g. DispatchMessageA → thunk-resident wndproc) still get their auto-pop semantics (MFC-paint scenario from the 5291175 commit preserved). Custom dialog draws chrome + Height/Width/Mines labels + edit frames + OK button; values and Cancel are follow-ups (see Open Tasks).
- GetMenuItemRect: Added handler with RECT fill (items spaced 100px horizontally, top=0, bottom=20). Fixed missing `esp += 20` stdcall cleanup that caused EIP=0x14 crash.
- GetLayout/SetLayout: Added stubs returning 0 (LTR layout). Unblocked the GDI drawing path.
- Window sizing function fully understood — measures menu items to detect wrapping, computes grid-based window size, accounts for window chrome via GetSystemMetrics.
- Multi-window DC support: DC handle now encodes hwnd (hdc = hwnd + 0x40000). Smiley face fixed from drawing at (0,0). Removed $window_dc_hwnd global.
- **PeekMessageA/W**: Fixed to poll `$host_check_input` for input events (was only checking posted queue). Root cause of click not working — Minesweeper's click handler uses a `PeekMessageW` loop to wait for WM_LBUTTONUP, which previously spun forever.
- **Custom dialog (both Win98 and XP winmine)** — `Game > Custom...` (menu ID 524) now opens and renders correctly.
  - **DialogBoxParamW missing** (XP): XP winmine imports the W variant at IAT `0x1001120` (USER32 `[29]`), but only `DialogBoxParamA` existed, so `Custom...` crashed with `UNIMPLEMENTED API: DialogBoxParamW`. Added `DialogBoxParamW` to `src/api_table.json` and a forwarding `$handle_DialogBoxParamW` in `09a-handlers.wat` that reuses the A handler (int IDs and ASCII template names flow through `$find_resource` the same way; UTF-16 string templates fall to the int branch like `CreateDialogParamW`).
  - **Modal dialogs stayed chrome-less in headless PNG mode** (affected both versions plus freecell's Statistics F4). The modal pump in `09b-dispatch.wat` (CACA0004 continuation) drained `$paint_queue_count` but skipped `$nc_flags_count` entirely, so WM_NCPAINT and WM_ERASEBKGND for the dialog never fired — the back-canvas stayed transparent. Two fixes: (1) `$handle_DialogBoxParamA` now seeds `nc_flags` bit 0 (NCPAINT) and pushes each child control onto the paint queue (mirroring `CreateDialogParamA`'s loop at `09a5-handlers-window.wat:417`); (2) the modal pump now scans `nc_flags` for bits 0/1 and dispatches straight to `$defwndproc_do_ncpaint` / `$host_erase_background` (COLOR_BTNFACE+1), bypassing the DlgProc — DlgProcs conventionally return FALSE for these and expect DefDlgProc to draw. After rebuild, the Custom dialog renders its title bar, Height/Width/Mines static + edit controls, and OK/Cancel buttons. `test-freecell-stats.js` went from 6/7 to 7/7.
- **Menu dropdown clipped to window**: opening Game menu showed only 6 of 14 items, with labels truncated ("Intermediat"/"Custom.."). Root cause in `lib/host-imports.js:_drawWithClip` — the dropdown paints to a full-screen overlay via `_activeChildDraw`, but still shared `_dcState[hdc]` with the main window DC, whose `clipRgn` was set to the client rect (0,0,168,211) from a prior BeginPaint. That clip was applied to the overlay coords, cutting off everything past x=168 / y=211. Fix: in `_drawWithClip`, when `_activeChildDraw` matches the hdc's window, bypass `dc.clipRgn` — the stored clip belongs to the back-canvas coordinate system, not the overlay/child surface. All 14 items now render with full-width labels.
- **SIB test byte fix**: `$th_test_m8_i8` (handler 124) used `$read_thread_word` instead of `$read_addr` to get the memory address. For SIB addressing (e.g. `test byte [edx+esi], 0x80` in the neighbor-count function at `0x01002F68`), the address was read as the raw sentinel `0xEADEAD` instead of the computed `$ea_temp`. This made the mine-check always read 0 from garbage memory, so neighbor counts were always 0 and the flood-fill reveal cleared the entire grid. Fixed by using `$read_addr` which checks for the sentinel.
