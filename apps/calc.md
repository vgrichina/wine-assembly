# Calc.exe Execution Analysis

## Current Status (2026-04-15)

### Button bezel investigation (followup to 2026-04-13)

User challenged the premise: **real Windows does not pre-paint
BS_OWNERDRAW buttons.** The app's WM_DRAWITEM handler is 100%
responsible for everything, including the bezel. So pre-painting
in button_wndproc is the wrong direction — it masks the real bug.

Tried pre-painting anyway: bezels appeared on all 30 buttons, but
a second WM_PAINT cycle overpainted the labels the app had drawn
(flag 0x04 skipped re-posting WM_DRAWITEM but not the bezel paint).
Reverted.

**Real diagnosis via DBG_EDGE trace:**
- Calc's SciCalc WndProc DOES call DrawEdge for all 27 non-memory
  buttons (in addition to MC/MR/MS). Count matches exactly: 27 WAT
  [API] DrawEdge invocations, 27 JS [gdi] DrawEdge with target=ok,
  all with sensible per-button ox/oy offsets into the top-level
  back canvas.
- But the final render only shows MC/MR/MS bezels. The other 24
  are drawn then lost.
- No FillRect or other wipe happens in the button area between the
  DrawEdge burst and the final render — so it's not overpaint from
  a subsequent erase_background.
- Hypothesis: calc top-level hwnd=65537 is the zero-size
  "CalcMsgPumpWnd". The dialog hwnd (≈65538) is a separate top-level
  that hosts the 30 buttons. `_resolveTopHwnd` walks child→parent
  and lands on the dialog. `getWindowCanvas` creates the back canvas
  sized to that dialog's w/h. If the dialog geometry changes after
  buttons are drawn (WM_SIZE, template-driven resize, etc.), the
  back canvas is recreated fresh and all bezels are lost. MC/MR/MS
  being drawn LAST in a later cycle would survive. Unverified.

**Next concrete step:** instrument `getWindowCanvas` to log when the
backing canvas is recreated (size mismatch path). Re-run calc and
check if a recreation happens between the DrawEdge burst and the
final PNG. If yes, the fix is either (a) avoid recreating when
contents would be lost, or (b) ensure all child paints happen after
the final geometry is settled.

## Previous Status (2026-04-13, evening)

### Summary
All 30 owner-draw buttons now render with labels (digits 0-9, operators,
MC/MR/MS/M+, Backspace/CE/C, sqrt/%/1/x). Calc is visibly functional —
title bar, menu bar, and button pad all composite correctly via the x86
SciCalc WndProc.

### Two root causes fixed this session

**1. `CreateDialogParamA` stored a NULL wndproc for calc's dialog.**
Calc's RT_DIALOG template names `class="SciCalc"` and passes NULL
DlgProc — real Windows resolves the dialog wndproc from the template's
class. Our `$dlg_load` skips the class field, and `$handle_CreateDialogParamA`
stored `arg3` (DlgProc = 0) into `wnd_table`. Every `SendMessage(dlg, ...)`
on the post-queue path early-returned because `wnd_table_get(dlg) == 0`,
so none of the 27 posted `WM_DRAWITEM` messages ever dispatched.

Fix: fall back to `$wndproc_addr2` / `$wndproc_addr` when the supplied
DlgProc is NULL (src/09a5-handlers-window.wat, `$handle_CreateDialogParamA`).
This assumes the app's most-recently-registered class is the dialog's
class, which is true for calc and for any app that registers its dialog
class before opening the dialog.

**2. Post-message queue was 8 slots — too small for the 30-button
owner-draw burst.** When `_drawWatChildren` sends `WM_PAINT` to each
owner-draw button, each one posts a `WM_DRAWITEM` back to the parent
via `$wnd_send_message`. With 30 buttons, 22 were silently dropped.

Fix: grew the queue from 8 → 64 slots (still well below guest memory
at WASM 0x400..0x800). Updated all five enqueue guards and the header
comment (01-header.wat, 09a-handlers.wat, 09a5-handlers-window.wat,
09c3-controls.wat ×2, 09c5-menu.wat).

### What still looks off in the PNG
- Display (result edit box) is not visible at the top of the dialog.
- Window is 262×481; the button pad only fills y≈60..260. The extra
  220px of dead space below suggests scientific-mode widgets expected
  there, or the DLU→px scale is still off vertically.
- Scientific-mode radio cluster (Dec/Hex/Oct/Bin + Degrees/Radians/
  Gradients + trig buttons) is absent — either we're loading the
  standard-mode template into a scientific-sized window, or the
  statics/radios weren't routed through the owner-draw paint path.

### Next steps
1. Figure out why the display edit is blank — is it a BS_OWNERDRAW-like
   child that we're failing to route? Or is calc not setting its text
   yet because some init step is still stalled?
2. Investigate the dialog height: compare DLU cy in the template vs.
   the rendered 481px. The "Degrees/Radians/Gradients" SetDlgItemText
   calls in the trace prove scientific-mode radios exist — they just
   don't render. Check if `ctrl_get_class` returns the right enum for
   them (kind=4 radio should go through button_wndproc's radio path,
   not owner-draw).
3. Consider whether `$dlg_load` should actually parse the template's
   class name so the CreateDialogParam fallback becomes principled
   rather than "last-registered-class wins".

### Previous status (stale, 2026-04-02)
Earlier blocker was a Newton-iteration divergence in the bignum init. That
is evidently fixed — calc now reaches CreateDialogParam and ShowWindow. The
previous investigation notes below are kept for historical reference.

---

## Previous Notes (2026-04-02) — bignum divergence

Newton iteration loop at `0x0100ced9` did not converge — numbers grew
without bound. This appears resolved now (calc reaches dialog init).

### Previously Fixed
- `imul r,[mem]` clobbered dst
- INC/DEC cleared CF
- ADC/SBB carry overflow
- MUL/IMUL flags
- Button clicks (resource parser, GetMessageA routing, IsChild)
- Arithmetic (_strrev, strchr, ADC/SBB threading)
- MSVCRT.dll auto-loading
- SAHF/LAHF
- GetSystemTimeAsFileTime

## Code Map
```
0x010119E0  WinMain (entry point)
0x01004BCD  SetPrecision (computes nPrecision=42)
0x010081BB  InitBigNumEngine(base, precision)
0x0100CED9  Newton iteration loop
0x01011506  BigNum_Multiply (O(n²) schoolbook, base 2^31)
0x01011564  BigNum_Multiply inner loop (MUL+ADC+SHRD per digit pair)
0x0100592A  SciCalc WndProc (x86, receives WM_DRAWITEM)
```
