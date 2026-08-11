# RichEdit Compatibility Task Design

Last updated: 2026-08-10.

Status: active task design for making native RichEdit usable across WordPad,
installers, and other Win9x-era apps.

## ASCII TLDR

```text
Whole task:

  make native RichEdit app-useful inside wine-assembly
  without building a full RichEdit clone.

                       +----------------------+
Win app / installer -->| native RichEdit code |
                       +----------+-----------+
                                  |
             +--------------------+--------------------+
             |                    |                    |
             v                    v                    v
      USER messages          GDI rendering        stream callbacks
      focus / keys           text / erase         plain text / RTF
      mouse / caret          clips / scroll       save / load
             |                    |                    |
             +--------------------+--------------------+
                                  |
                                  v
                WordPad and installer license panes
                type, edit, select, scroll, save, redraw
```

```text
Implement now                                 Postpone later

+--------------------------------+            +-------------------------------+
| bounded WordPad/RichEdit probe |            | images / tables / OLE objs   |
| delete / enter / movement      |            | advanced RTF layout          |
| selection replacement          |            | IME / bidi / complex shaping |
| plain-text Ctrl+A/C/X/V bridge |            | print pagination             |
| mouse selection / wheel scroll |            | TOM/COM / accessibility / D&D|
| plain text stream I/O          |            | exact version quirks         |
| basic RTF + basic formatting   |            | rich clipboard fidelity      |
| simple paragraph alignment     |            | indents / tabs / numbering   |
| basic toolbar command fidelity |            | advanced toolbar UI state    |
| clipped ExtTextOut rendering   |            | full resize/wrap edge cases  |
| native scrollbar thumb routing |            |                               |
+--------------------------------+            +-------------------------------+
```

## Current baseline

WordPad passes the smallest useful RichEdit probe:

```text
launch WordPad -> click editor -> type "hello world"
              -> WM_GETTEXT returns "hello world"
              -> Backspace, Enter, type "again"
              -> WM_GETTEXT returns "hello worl\r\nagain"
              -> Left, Left, Delete, Home, type "X", End, type "Y"
              -> WM_GETTEXT returns "hello worl\r\nXaganY"
              -> Shift+Left twice, type "Z"
              -> EM_GETSEL reports selected range, WM_GETTEXT returns "hello worl\r\nXagaZ"
              -> Ctrl+A, Ctrl+C, End, Ctrl+V
              -> WM_GETTEXT returns "hello worl\r\nXagaZhello worl\r\nXagaZ"
              -> Ctrl+A, Ctrl+X, Ctrl+V
              -> WM_GETTEXT returns restored duplicated text
              -> mouse drag selects text
              -> 35-line text auto-scrolls, wheel changes first visible line
              -> standard/format toolbar rows are visible above the editor
              -> first Standard toolbar button opens the New dialog
              -> formatting toolbar B/I/U buttons update selected text
              -> 100 chars of WordPad text produce native line metrics and
                 paint through clipped ExtTextOut rectangles without desktop spill
              -> simple RTF save/reopen preserves Arial Bold Italic Underline
                 24pt Blue
              -> simple RTF save/reopen preserves centered paragraph alignment
              -> visible edited text appears
```

The Winamp 2.95 NSIS installer also passes the bounded installer/RichEdit
probe: its license RichEdit maps to the WAT edit path, streams license text,
renders word-wrapped text, clips scroll output to the control rect, supports
wheel/arrow/thumb/canvas scrolling, captures the license/options/folder/
installing screenshots, reaches Installing Files, extracts the expected VFS
files, and exits cleanly after the final Finish command.

Related common-control scroll status: WAT-native `SysTreeView32` now reuses the
same shared vertical scrollbar hit/drag math as the RichEdit/Edit/ListBox
paths. `SysListView32` is still a blank/minimal pane, so ListView item/header
storage should come before attempting scroll reuse there.

That means these pieces are already good enough for basic insertion:

- focus can reach the RichEdit child;
- keyboard input routes to the focused child instead of the frame;
- `WM_CHAR` insertion reaches native RichEdit;
- synchronous `WM_GETTEXT` can read the focused native RichEdit buffer through
  the test harness;
- native RichEdit USER caret API calls (`CreateCaret`, `SetCaretPos`,
  `ShowCaret`) are tracked and composited as a visible caret stroke;
- Backspace, Delete-forward, Enter, Left, Home, and End update that native
  buffer/insertion position in the current probe;
- Shift+Left selection is visible through `EM_GETSEL`, and typing replacement
  updates/collapses the selected range;
- Ctrl+A selection visibly paints white-on-blue in the WordPad RichEdit text
  band;
- plain-text Ctrl+A/C/X/V works for focused native RichEdit controls through the
  renderer-side native-text shortcut bridge;
- WordPad Edit-menu Select All / Copy / Cut / Paste command ids route through a
  plain-text WAT menu edit bridge for the focused native RichEdit child;
- mouse drag changes native RichEdit selection state;
- long multiline text inserts, auto-scrolls to the caret, and focused native
  wheel input changes `EM_GETFIRSTVISIBLELINE`;
- native RichEdit right-band scrollbar thumb drag reuses the shared scrollbar
  hit/drag math and changes `EM_GETFIRSTVISIBLELINE`;
- WordPad's standard and formatting `ToolbarWindow32` rows are visible, and the
  native RichEdit child is laid out below them;
- the first Standard toolbar button routes through WordPad/MFC and opens the
  New document-type dialog;
- formatting toolbar Bold / Italic / Underline buttons route through WordPad UI
  and update native RichEdit character-format state;
- a simple WordPad RTF Save As -> New -> Open round-trip preserves one
  selected run's face/style/size/color state: Arial / Bold Italic / Underline /
  24pt / Blue, with reopened `EM_GETCHARFORMAT` reporting `underline=1`,
  `yHeight=480`, `color=0xff0000`, and face `Arial`;
- a simple WordPad RTF Save As -> New -> Open round-trip preserves selected
  paragraph center alignment, with reopened `EM_GETPARAFORMAT` reporting
  `alignment=3`;
- keyboard routing preserves focused native RichEdit before using the WAT EDIT
  fallback, so toolbar combobox edit children do not steal document typing;
- `ExtTextOutA/W` supports `ETO_OPAQUE` erase rectangles and `ETO_CLIPPED`
  glyph clipping, including the long-line WordPad RichEdit paint path;
- the observed RichEdit `32767 twips` font-height sentinel no longer moves
  text far offscreen.

This does not mean RichEdit is feature complete. It only proves the first
native-editing path is alive.

### 2026-08-10 implementation progress

- Reused the shared Win98 vertical scrollbar helpers for WAT-native
  `SysTreeView32` overflow rows.
- TreeView line/page clicks, thumb drag, `WM_MOUSEWHEEL`, `WM_VSCROLL`,
  `TVGN_FIRSTVISIBLE`, `TVM_HITTEST`, and mouse selection now share the same
  first-visible row offset.
- Added `test/test-treeview-scroll.js`, a standalone WAT regression that creates
  a TreeView, inserts 12 rows, verifies wheel/arrow/page/thumb scroll behavior,
  hit-testing through the scroll offset, selection, and slot cleanup.
- Postponed `SysListView32` scroll reuse because the current implementation is
  still a minimal blank pane. The next useful ListView slice is item/header
  state plus a focused regression before wiring scrollbar behavior.
- Updated `apps/regedit.md` to separate focused TreeView scroll coverage from
  current app-level RegEdit screenshot status.

### 2026-08-03 implementation progress

- Routed `ExtTextOutA/W` through a shared host GDI primitive that preserves the
  existing `TextOut` rendering path while honoring `ETO_OPAQUE` and
  `ETO_CLIPPED` rectangles. `lpDx` is still ignored.
- Added direct host-GDI coverage in `test/test-gdi-exttextout-clipping.js` for
  glyph clipping and null-text opaque erases.
- Added `test/test-wordpad-richedit-clipping.js`, which types 100 chars into
  WordPad, observes native RichEdit line metrics, confirms
  `ExtTextOutA(... fuOptions=4, lprc=...)`, and captures
  `test/output/wordpad-richedit/long-line-clipped.png`.
- Stabilized the Winamp 2.95 installer RichEdit/license coverage in
  `test/test-winamp-installers.js`. The regression now waits long enough for
  the license control, asserts RichEdit id `1000` renders through
  word-wrapped `DrawText`, verifies wheel/arrow/thumb/canvas scrolling,
  captures the stage screenshots, checks native `ProgressBar`/`SysListView32`
  controls on Installing Files, and drives the interactive install to
  `[Exit] code=0` with expected VFS files.
- Fixed `test/run.js` scheduled-input wait deferral so future wait actions keep
  their `startBatch` aligned when an earlier wait shifts the timeline. This
  prevents later installer page waits from expiring immediately after the
  license page appears.

### 2026-08-02 implementation progress

- Added a renderer-side native-text shortcut bridge for focused non-WAT edit
  controls. It uses `WM_GETTEXT` / `EM_GETSEL` for copy, `EM_SETSEL` for
  select-all, and `EM_REPLACESEL` for paste/cut replacement. The bridge is
  plain text only.
- Added compatibility scaffolding for RichEdit's OLE clipboard setup:
  `GetProfileSectionA`, `GlobalFlags`, `CreateILockBytesOnHGlobal`,
  `StgCreateDocfileOnILockBytes`, `WriteClassStg`, and `WriteFmtUserTypeStg`.
  These avoid missing-export/unimplemented stops in the covered path, but they
  are intentionally not full OLE storage implementations.
- Expanded `test/test-wordpad-richedit.js` to cover Ctrl+A, Ctrl+C, End,
  Ctrl+V, Ctrl+X, and restore-paste. The bounded regression now passes 22/22
  and captures
  `test/output/wordpad-richedit/hello-world-edited.png`.
- Added renderer wheel fallback for focused native controls, key-specific
  keypress suppression for Ctrl-letter shortcuts, and
  `test/test-wordpad-richedit-scroll.js`. The bounded mouse/scroll regression
  now also covers native RichEdit scrollbar thumb drag through the shared
  scrollbar hit/drag helpers, passes 11/11, and captures
  `test/output/wordpad-richedit/mouse-scroll.png`.
- Added minimal USER clipboard APIs for plain ANSI text:
  `OpenClipboard`, `CloseClipboard`, `EmptyClipboard`, `SetClipboardData`,
  `GetClipboardData`, `IsClipboardFormatAvailable`, `CountClipboardFormats`,
  and `GetClipboardOwner`. These share the WAT edit clipboard buffer and cover
  `CF_TEXT` / `CF_OEMTEXT`. A raw native RichEdit Ctrl+C/Ctrl+V probe still
  follows RichEdit's OLE storage setup rather than the verified USER text path,
  so rich/native clipboard fidelity remains later work.
- Added a plain-text WAT menu edit-command bridge for WordPad/MFC edit command
  ids: Select All (`57642`), Copy (`57634`), Cut (`57635`), Paste (`57637`),
  plus the existing small WAT edit ids. For WordPad's focused native RichEdit
  child it uses `WM_GETTEXT`, `EM_GETSEL`, `EM_SETSEL`, and `EM_REPLACESEL`
  instead of forwarding `WM_COPY` / `WM_CUT` into RichEdit's OLE clipboard
  storage path. Added `test/test-wordpad-menu-edit-clipboard.js`; it proves
  menu Copy/Paste duplicates `menu` to `menumenu`, menu Cut clears selected
  text and menu Paste restores it, and the covered plain-text path does not
  call `CreateILockBytesOnHGlobal` or `StgCreateDocfileOnILockBytes`.
- Added `test/test-wordpad-selection-highlight.js` to make the existing
  RichEdit selection painter an explicit acceptance point. The focused probe
  types `select me`, captures a plain screenshot, sends Ctrl+A, verifies
  `EM_GETSEL` reports a non-empty selection, captures the selected screenshot,
  and asserts the RichEdit text band gains blue-dominant selection pixels.
- Added minimal USER caret state for native controls and renderer-side caret
  compositing. `CreateCaret`, `SetCaretPos`, `ShowCaret`, `HideCaret`,
  `DestroyCaret`, and `GetCaretPos` now maintain caret owner/position/size
  state; `lib/renderer.js` paints the visible caret after normal window
  back-canvas composition so native RichEdit child coordinates use the renderer
  window tree. Added `test/test-wordpad-caret.js`, which types `caret`, traces
  RichEdit's caret API calls, captures `test/output/wordpad-richedit/caret.png`,
  and verifies a dark vertical caret stroke at the expected document coordinate.
  Blink cadence and XOR-style erasure remain later fidelity work.
- Added WordPad Save As coverage and the minimal compatibility it needed:
  `GetFileTime`, `CreateFileMoniker`, `GetRunningObjectTable`, an
  `IRunningObjectTable` no-op vtable, and failure-returning storage/OLE
  placeholders (`CreateBindCtx`, `StgIsStorageFile`, `StgOpenStorage`,
  `StgCreateDocfile`, `StgOpenStorageOnILockBytes`, `ReadClassStg`,
  `ReleaseStgMedium`, `OleRegGetUserType`). The bounded regression
  `test/test-wordpad-save-as.js` proves WordPad can type text, accept the Save
  As filename, create/write/close the target file, update the title, and avoid
  the previous MFC null-ROT call. This is scoped save-path scaffolding, not full
  structured storage, moniker binding, or embedded OLE object support.
- Extended the same bounded regression to cover WordPad File New and File Open.
  `SetWindowTextA/W` now forwards `WM_SETTEXT` to native child windows with real
  wndprocs, which lets WordPad's New document-type dialog clear the RichEdit
  buffer instead of only resetting the title. The Open path now proves the
  common dialog, `CreateFileA` / `ReadFile` stream, `GetFileTitleA`, title
  update, and native RichEdit readback for `sources.md`.
- Fixed `wvsprintfA` to pass the `va_list` as a guest address to the shared
  formatter. The previous host-pointer conversion made RichEdit stream corrupt
  RTF with `(null)` placeholders in the header during WordPad Save As. Added
  `test/test-wordpad-reopen-saved.js`, which proves simple text saved by
  WordPad reopens as editor text instead of raw corrupted RTF.
- Added a real `Files of type` combobox to the WAT Open/Save common dialog.
  It is populated from `OPENFILENAME.lpstrFilter` and writes the selected
  1-based index back to `OPENFILENAME.nFilterIndex` on OK. Added
  `test/test-wordpad-plain-text-filter.js`, which proves WordPad's
  `Text Document` filter shows the expected warning, writes exact plain-text
  bytes, and reopens the saved `.txt` as native RichEdit text.
- Added modifier-aware accelerator matching in `TranslateAcceleratorA/W`.
  Accelerator entries now require exact Shift/Ctrl/Alt state, which lets
  WordPad's Ctrl+B / Ctrl+I / Ctrl+U commands reach the frame instead of being
  swallowed as plain RichEdit keydowns. Added `dump-focus-charformat` to
  `test/run.js` and `test/test-wordpad-format-accelerators.js`; the focused
  probe confirms selected native RichEdit text reports bold, italic, and
  underline effects through `EM_GETCHARFORMAT(SCF_SELECTION)`, and now compares
  plain/formatted screenshots to assert visible B/I/U text pixels.
- Added `test/test-wordpad-format-roundtrip.js`, which now proves a simple
  WordPad RTF Save As -> New -> Open round-trip preserves selected text plus
  selected-run face/style/size/color state. The focused probe applies Arial /
  Bold Italic / 24pt through Format > Font, applies underline through
  WordPad's accelerator path, applies Blue through `EM_SETCHARFORMAT(CFM_COLOR)`,
  and verifies reopened native RichEdit reports `underline=1`, `yHeight=480`,
  `color=0xff0000`, and face `Arial`.
- Expanded the WAT `ChooseFontA` dialog writeback from size-only to full
  face/style/size output through `CHOOSEFONT` and `LOGFONT`, including
  `iPointSize`, `nFontType`, `lpszStyle`, `lfFaceName`, `lfWeight`, and
  `lfItalic`. Added `test/test-wordpad-font-dialog.js`; it proves WordPad's
  Format > Font path can select Arial / Bold Italic / 24pt, send
  `EM_SETCHARFORMAT(yHeight=480, effects=bold|italic, face="Arial")`, and leave
  native RichEdit reporting the selected face/style/size with visible pixel
  changes. A follow-up GDI/RichEdit font-size hint records the latest explicit
  `CFM_SIZE` twips value and uses it only when native RichEdit later asks GDI to
  create the known sentinel-derived huge font height. The same per-HWND latest
  size cache now patches `EM_GETCHARFORMAT` output, so the font dialog
  regression asserts `yHeight=480` after applying 24pt. This is still not a
  full mixed-run format model.
- Added a focused `set-focus-charformat-color` harness action and
  `test/test-wordpad-richedit-color.js`. The bounded probe applies
  `EM_SETCHARFORMAT(CFM_COLOR)` directly to the focused WordPad RichEdit child,
  verifies `EM_GETCHARFORMAT` reports `color=0xff0000` with autocolor cleared,
  sees `SetTextColor(..., 0xff0000)`, and compares screenshots to assert blue
  text pixels. This proves the native RichEdit color/rendering path
  independently from WordPad's toolbar/menu color UI, which has separate
  coverage below.
- Added a minimal WAT-native `ToolbarWindow32` common-control default proc
  (control class 21). It handles the layout-facing `TB_*` messages WordPad/MFC
  sends through `CallWindowProcA` after subclassing, including button counts,
  item rectangles, button/bitmap sizes, rows, autosize, basic state probes, and
  placeholder painting. The renderer composites toolbar child surfaces. Added
  `test/test-wordpad-toolbar.js`, which proves WordPad's Standard and
  Formatting toolbars are visible, have real 32px surfaces, and place RichEdit
  below them.
- Extended that `ToolbarWindow32` subset with a 20-byte `TBBUTTON` backing
  store, `TB_GETBUTTON` command IDs, command-ID state lookup/update, mouse
  hit-testing, and synchronous `WM_COMMAND` delivery to the parent. Added a
  successful no-op `LockWindowUpdate` handler for MFC's toolbar UI update
  cycle. `test/test-wordpad-toolbar.js` now passes 13/13 and also captures
  `test/output/wordpad-richedit/toolbar-command-new.png`, proving the first
  Standard toolbar button opens WordPad's `New` dialog.
- Added minimal `GetDCEx` support on top of the existing host DC allocator and
  client/whole-window clip helpers. Added
  `test/test-wordpad-toolbar-format-buttons.js`, which passes 10/10 and
  captures `test/output/wordpad-richedit/toolbar-format-buttons.png`, proving
  formatting-toolbar Bold / Italic / Underline mouse clicks route through
  WordPad UI and update native RichEdit charformat state.
- Added WAT-backed dynamic popup menu state for `CreatePopupMenu` plus
  `AppendMenuA/W` owner-draw items and `TrackPopupMenu` painting/hit-testing.
  WordPad's formatting-toolbar color button now opens the 17-row temporary
  color popup (`0x800e..0x801e`). Because `TrackPopupMenu` is still async in the
  emulator and WordPad destroys the temporary MFC menu immediately after
  opening it, `menu_try_edit_command` has a narrow fallback for those ids that
  applies the selected Win32 `COLORREF` directly to the WordPad RichEdit child.
  `test/test-wordpad-toolbar-color-menu.js` passes 13/13 and captures
  `toolbar-color-menu-popup.png` plus `toolbar-color-menu-blue.png`, proving
  the toolbar color UI route applies Blue (`COLORREF 0x00ff0000`).
- Added ANSI `EnumFontFamiliesExA` / `EnumFontFamiliesA` callback support with
  the same one-face `Arial` enumeration as the Unicode path. This unblocks the
  formatting toolbar's ANSI font-list setup after the MFC toolbar subclass is
  allowed to install.
- Tightened renderer keyboard routing so focused native child windows keep
  keyboard input on the queued native-focus path. This avoids routing document
  typing into WordPad's toolbar combobox inner `EDIT` after a RichEdit click,
  while preserving the existing Notepad WAT-edit fallback.
- Added focused API trace formatting for `SendMessageA/W` calls carrying
  `EM_GETCHARFORMAT` / `EM_SETCHARFORMAT`, so future WordPad/RichEdit probes
  show decoded CHARFORMAT fields instead of only raw pointers.
- Added a VFS write-boundary patch for native RichEdit stream-out's known
  single-run RTF size sentinels. When a latest explicit `CFM_SIZE` hint is
  available, `WriteFile` data replaces `\up3276` / `\fs3277` with `\up0` /
  `\fsNN` before the bytes enter the virtual filesystem. This fixes the simple
  WordPad font-size round-trip without claiming a full mixed-run RTF model.
- Added `dump-focus-paraformat` and `set-focus-paraformat-align` harness
  actions for focused native RichEdit controls, then added
  `test/test-wordpad-paragraph-align.js`. The bounded probe verifies WordPad's
  Ctrl+E command path sets `EM_GETPARAFORMAT` alignment from left (`1`) to
  center (`3`), screenshots show the typed word moving from x=17..40 to
  x=287..310, the exported saved RTF contains `\qc`, and
  Save As -> New -> Open preserves the centered paragraph in simple RTF.
  No emulator RichEdit format code change was needed for this
  slice; the native control already handles the covered
  `EM_SETPARAFORMAT`/`EM_GETPARAFORMAT` and `\qc` round-trip path.

### 2026-08-01 implementation progress

- Added cross-instance thunk metadata sync for worker-thread WASM instances, so
  stale worker globals cannot allocate a dynamic thunk over DLL import thunks
  created later by the main instance.
- Added minimal `EnumFontFamiliesExW` / `EnumFontFamiliesW` callback support
  with one `Arial` face. This unblocks WordPad's startup font enumeration path
  before `ShowWindow`.
- Added `test/run.js` `dump-focus-text`, which reads WAT EDIT controls directly
  and native controls through `WM_GETTEXT`.
- Expanded `test/test-wordpad-richedit.js`, a bounded regression covering
  launch, RichEdit focus, `hello world` typing, native text readback,
  Backspace, Delete-forward, Enter/newline, Left/Home/End insertion movement,
  Shift+Left selection/replacement, and visible text paint.

## Problem statement

Several important Win9x apps do not use the plain EDIT control for document text.
They use RichEdit directly or through dialogs. WordPad is the obvious example,
and installers commonly use RichEdit for license text.

The emulator already runs native RichEdit code. The remaining work is mostly the
compatibility layer around it:

- USER focus, keyboard, mouse, child-window, and message-order behavior;
- GDI text drawing, clipping, erase, metrics, and scroll invalidation;
- stream callbacks and text/RTF transfer messages;
- enough formatting messages for visible WordPad toolbar actions.
- enough common-control behavior for app toolbars to participate in layout.

The target is app-useful compatibility, not exact implementation parity with
every RichEdit version.

## Goals

- WordPad supports everyday text editing:
  typing, deletion, newlines, navigation, selection, wrapping, scrolling, and
  visible caret/selection behavior.
- WordPad can save and reopen plain text, then simple RTF.
- Basic formatting is visible:
  bold, italic, underline, font size, font face, and text color.
- Installer license RichEdit panes render, clip, and scroll reliably.
- The behavior is covered by bounded tests and screenshots so later GDI/USER
  changes do not silently regress it.

## Non-goals for the next phase

These are valid RichEdit features, but they should not block the next app-status
push:

- embedded OLE objects and in-place activation;
- image rendering/editing through `\pict`, metafiles, or bitmap objects;
- tables, high-fidelity layout, and complex RTF style sheets;
- IME composition, bidi layout, complex script shaping, and script-specific
  line breaking;
- print layout, pagination, rulers, and printer-device metric fidelity;
- TOM/COM surfaces, deep accessibility, and drag/drop editing;
- exact behavioral differences between RichEdit 1.0, 2.0, 3.0, and later.

## Suggested implementation slice

Implement the next part as a bounded probe plus the first failing edit fixes.
This gives a stable loop before touching more RichEdit internals.

```text
Part A: test harness

  test/test-wordpad-richedit.js
       |
       v
  test/run.js --exe=test/binaries/win98-apps/wordpad.exe
       |
       v
  scheduled input:
    click editor
    type text
    Backspace / Delete / Enter
    Arrow / Home / End
    Shift+arrow
    drag selection
    png snapshots
    dump visible edit state
       |
       v
  assertions:
    text state changed correctly
    selection/caret/scroll state sane
    screenshots written
    no crash / no UNIMPLEMENTED API
```

### Deliverables for Part A

- Add `test/test-wordpad-richedit.js`, modeled on
  `test/test-notepad-editing.js`.
- Use `test/run.js` scheduled input instead of manual interaction.
- Capture screenshots under `test/output/` or `/private/tmp/`.
- Keep a wall-clock timeout inside the Node test because emulator tests can
  hang.
- Update `apps/wordpad.md` with the current pass/fail state after the probe.

### Existing test-runner pieces to reuse

`test/run.js` already supports most of the required input actions:

- `focus-main-window`;
- `keypress:CODE`;
- `keydown:VK` / `keyup:VK`;
- `click:X:Y`, `mousedown:X:Y`, `mousemove:X:Y`, `mouseup:X:Y`;
- `dump-main-edit-state[:LABEL]`;
- `drag-main-edit:X1:Y1:X2:Y2`;
- `wheel-main-edit:DELTA`;
- `png:PATH`.

The first version should reuse these. If WordPad needs better targeting, add a
generic selector action instead of a WordPad-specific hack. Example:

```text
focus-visible-edit
dump-visible-edit-state[:LABEL]
drag-visible-edit:X1:Y1:X2:Y2
```

The selector should find the visible native edit/RichEdit child under the active
top-level window, not hard-code `0x10002`.

### Initial probe flow

```text
1. Launch WordPad.
2. Click inside the RichEdit client area.
3. Type: alpha beta
4. Dump state: text should be "alpha beta".
5. Press Backspace.
6. Dump state: text should be "alpha bet".
7. Press Enter, type gamma.
8. Dump state: multiline text should include alpha bet + gamma.
9. Ctrl+A, type delta.
10. Dump state: text should be "delta".
11. Shift+Left a few chars.
12. Dump state: cursor and selection should differ.
13. Capture screenshot for text/caret/selection evidence.
14. Run no-crash/no-unimplemented checks.
```

Command shape:

```text
node test/test-wordpad-richedit.js
```

The test itself should call `test/run.js` with a bounded child-process timeout,
for example `execSync(cmd, { timeout: 120000 })`.

## Fixes likely needed after the probe

### 1. Delete, Enter, and navigation

Expected touchpoints:

- `lib/renderer-input.js` for key event normalization and focus routing;
- `src/09a5-handlers-window.wat` for window message dispatch;
- EDIT/RichEdit message handlers in WAT for `WM_KEYDOWN`, `WM_CHAR`, and
  `EM_*` behavior;
- `test/run.js` only if the harness cannot observe the needed state generically.

Acceptance:

```text
[x] Backspace removes the previous character
[x] Delete removes the next character
[x] Enter creates a visible new line
[x] Left/Right/Home/End move the caret without corrupting text
[x] typing over selection replaces the selected range
```

### 2. Visible selection

Expected touchpoints:

- edit selection state exports used by the test runner;
- text rendering paths in `src/09a-handlers.wat` and `lib/host-imports.js`;
- invalidation and repaint behavior for selection changes.

Acceptance:

```text
[x] Shift+arrow produces a non-empty selection
[x] mouse drag produces a non-empty selection
[x] selected text is visibly highlighted in a screenshot
[x] replacing selected text leaves the expected buffer contents
```

### 3. Scroll and wrapping

Expected touchpoints:

- `EM_GETFIRSTVISIBLELINE`, `EM_LINESCROLL`, `WM_MOUSEWHEEL`;
- child/client rect and clip calculations;
- invalidation when first visible line changes.

Acceptance:

```text
[x] long multiline text inserts without truncation
[x] wheel scroll changes first visible line
[x] long WordPad RichEdit text paints through clipped ExtTextOut rectangles
[x] glyph drawing stays inside the tested RichEdit/outer-window paint band
[x] scrollbar thumb drag changes first visible line
[ ] full wrapping + clip invalidation stays coherent across resize/scroll edges
```

### 4. Text I/O

Expected message surface:

- `WM_GETTEXT`, `WM_SETTEXT`, `WM_GETTEXTLENGTH`;
- `EM_GETTEXTEX`, `EM_SETTEXTEX`, `EM_GETTEXTRANGE`;
- `EM_STREAMIN`, `EM_STREAMOUT`;
- selection range queries and CR/LF normalization.

Acceptance:

```text
[x] WordPad saved RTF reopens with simple plain text content
[x] plain text save/reopen through the text filter works in WordPad
[x] basic RTF save/reopen preserves bold/italic/underline charformat
[x] basic RTF save/reopen preserves one selected run's font face/size/color
[x] basic RTF save/reopen preserves selected paragraph center alignment
[x] installer license RichEdit text streams in and scrolls
```

### 5. Plain-text clipboard shortcuts

Expected message surface:

- renderer shortcut routing for focused native text controls;
- WAT menu edit-command routing for WordPad/MFC edit ids;
- `WM_GETTEXT`, `EM_GETSEL`, `EM_SETSEL`, and `EM_REPLACESEL`;
- later: rich USER clipboard formats and RichEdit/OLE clipboard fidelity.

Acceptance:

```text
[x] Ctrl+A selects all focused native RichEdit text
[x] Ctrl+C captures the selected native RichEdit text as plain text
[x] Ctrl+V inserts the captured plain text through `EM_REPLACESEL`
[x] Ctrl+X cuts selected native RichEdit text
[x] menu Edit Select All/Copy/Cut/Paste routes work without the keyboard bridge
[ ] rich clipboard formats preserve RTF/objects
```

### 6. Basic formatting

Expected message surface:

- `EM_SETCHARFORMAT` / `EM_GETCHARFORMAT`;
- `EM_SETPARAFORMAT` / `EM_GETPARAFORMAT`;
- basic font, size, bold, italic, underline, color, and alignment fields.

Acceptance:

```text
[x] WordPad Ctrl+B / Ctrl+I / Ctrl+U toggle RichEdit charformat effects
[x] bold / italic / underline have explicit visual/pixel assertions
[x] WordPad Format > Font dialog writes selected face/style/point size back to
    WordPad's `EM_SETCHARFORMAT`
[x] WordPad Font dialog face/style application has visible/pixel assertions
[x] WordPad Font dialog 24pt selection visibly increases text height
[x] `EM_GETCHARFORMAT` reports concrete selected size instead of the sentinel
[x] text color renders through direct focused RichEdit `EM_SETCHARFORMAT`
[x] WordPad standard/format toolbars are visible and layout RichEdit below them
[x] WordPad first Standard toolbar button opens the New dialog through app UI
[x] WordPad formatting toolbar B/I/U buttons route through app UI
[x] WordPad toolbar/menu color command route applies Blue through app UI
[x] simple RTF round-trips without losing basic character-format effects
[x] simple RTF round-trips one selected run's font size/color
[x] simple RTF round-trips selected paragraph center alignment
[ ] paragraph indents/tabs/numbering round-trip correctly
```

## Whole-task acceptance matrix

```text
[x] WordPad accepts focus and inserts visible "hello world"
[x] Automated WordPad/RichEdit probe exists
[x] Backspace edits visible text correctly
[x] Delete-forward edits visible text correctly
[x] Enter creates a visible new line
[x] Arrow/Home/End movement tracks insertion position
[x] Visible caret paint is covered
[ ] Caret blink/XOR cadence stays coherent
[x] Shift+arrow selection changes replacement range
[x] Visible selection highlight renders coherently
[x] Mouse-drag selection changes selection range
[x] Plain-text Ctrl+A/C/X/V work for native RichEdit focus
[x] Menu Copy/Cut/Paste has explicit coverage
[x] Native RichEdit wheel changes first visible line
[x] Long WordPad RichEdit text paints through clipped ExtTextOut rectangles
[x] Native RichEdit scrollbar thumb drag changes first visible line
[ ] Full wrapping/clip invalidation stays coherent across resize/scroll edges
[x] WordPad saved RTF reopens with simple plain text content
[x] Plain text save/reopen through the text filter works
[x] Basic RTF save/reopen preserves bold/italic/underline styling state
[x] Basic RTF save/reopen preserves selected font size/color state
[x] Basic RTF save/reopen preserves selected paragraph alignment state
[x] Bold/italic/underline command state toggles in WordPad
[x] Bold/italic/underline are visibly asserted in WordPad
[x] Font dialog face/style handoff is visibly asserted in WordPad
[x] Font-size layout is visibly asserted in WordPad
[x] RichEdit selected-size reporting returns concrete `yHeight`
[x] Direct RichEdit text color rendering is visibly asserted in WordPad
[x] WordPad standard/format toolbar layout is visibly asserted
[x] WordPad first Standard toolbar command route is explicitly covered
[x] WordPad formatting toolbar B/I/U click route is explicitly covered
[x] WordPad toolbar/menu color route has explicit coverage
[x] Installer/license RichEdit panes render and scroll
[x] WAT TreeView reuses shared vertical scrollbar hit/drag math
[ ] SysListView32 has item/header state and reusable scrollbar behavior
[x] App status docs are updated from current screenshots/probes
```

## Implementation order

```text
1. Add `test/test-wordpad-richedit.js` and capture baseline screenshots.
2. Add generic test-runner targeting if existing edit-state actions are not
   enough for WordPad.
3. Fix Backspace, Delete, Enter, and caret navigation.
4. Fix visible selection rendering and replacement.
5. Add plain-text keyboard clipboard bridge for focused native RichEdit.
6. Add mouse-selection and focused-wheel scroll coverage.
7. Fix clipped RichEdit text rendering.
8. Add plain text stream in/out.
9. Add basic RTF stream in/out.
10. Add basic character and paragraph formatting.
11. Fix remaining full wrapping/clip invalidation edge cases.
12. Re-run WordPad, Notepad, and installer RichEdit probes.
13. Update app status docs with screenshots and pass/fail state.
```

## Risk controls

- Keep compatibility fixes generic unless traces prove an app-specific exception
  is required.
- Avoid broad GDI metric clamps. The observed `MulDiv(32767, 96, 1440)` clamp is
  a narrow compatibility guard for a RichEdit sentinel; wider math changes need
  regression evidence.
- Run Notepad editing coverage after RichEdit text changes because both share
  lower-level edit, input, and GDI paths.
- Keep screenshots for visual assertions. Text dumps do not catch erase,
  clipping, caret, or selection-paint bugs.
- Do not make emulator tests unbounded. Use explicit timeouts around scripts
  that launch apps.
