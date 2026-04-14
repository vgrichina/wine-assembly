# Calc.exe Execution Analysis

## Current Status (2026-04-13)

### Summary
Calc runs far enough to create its main Calculator dialog via
`CreateDialogParamA` (hwnd=0x10002) — the bignum init blocker is long past.
The dialog frame (title bar + Edit/View/Help menu) renders correctly, but
**the button/digit pad is blank**: the calculator dialog's 30 controls
(buttons + group statics) never draw.

Root cause: every button in calc is **BS_OWNERDRAW** (`style & 0xF == 0x0B`).
Our `button_wndproc` WM_PAINT handler for kind=0x0B posts a `WM_DRAWITEM`
(0x002B) message to the parent so the x86 dialog proc (SciCalc WndProc at
`0x0100592a`) can paint. Because the parent is an x86 wndproc, that message
goes through the PostMessage queue (8 slots). The app is still churning in a
LocalAlloc/LocalFree loop at `--png` snapshot time and never drains the
queue, so the buttons remain blank.

Additionally, button_wndproc only posts WM_DRAWITEM **once per button**
(guarded by ButtonState.flags bit 2 "already drawn"). After the first
repaint attempt the flag is set and subsequent WM_PAINTs return silently
— so unless those 30 queued messages all fit in the 8-slot queue AND are
dispatched, some buttons will never redraw.

### Evidence
```
[DBG] paint button h=0x10004 state=0x146a23c style=0x5000000b xy=50,119 wh=36x31
...
```
- state is allocated (WM_CREATE path works)
- style & 0xF = 0x0B (BS_OWNERDRAW)
- only 4 `gdi_fill_rect` calls observed, all for the dialog frame
  (hdc=0x50002 = dialog+0x40000), none for any button hwnd

### What the PNG shows (`--no-close`)
- Calculator title bar, "Edit View Help" menu, grey client area
- No digit pad, no display edit, no radio cluster
- Window size 262x481 (too tall — scientific calc dims may be mis-oriented)

### Suggested next steps
1. **Post queue too small for dialog load**: either grow the queue or flush
   posted WM_DRAWITEM synchronously to an x86 wndproc during render. The
   cleanest fix is to dispatch WM_DRAWITEM synchronously (SendMessage-style)
   rather than queueing — it's a paint message, not an input event.
2. **Stop early-return on "already drawn"**: the flags bit 2 gate in
   `$button_wndproc` WM_PAINT (src/09c3-controls.wat:1727) means repaints
   never re-post WM_DRAWITEM. If owner-draw buttons need to repaint (focus,
   state change), the flag needs clearing.
3. **Verify calc advances past LocalAlloc loop** — even if we dispatch
   WM_DRAWITEM correctly, the x86 wndproc only paints when the app's
   message loop pumps it. At PNG snapshot, calc is still spinning in
   LocalAlloc/LocalFree; get it to idle in GetMessage first.
4. **Dialog size** — 262x481 with button band at y=119..255 looks like the
   dialog cy came out doubled; may need re-examining DLU→pixel scaling
   for this dialog template.

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
