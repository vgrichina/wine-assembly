# WordPad (Win98) — PARTIAL

**Binary:** `test/binaries/win98-apps/wordpad.exe`  
**Status (2026-08-02):** PARTIAL.

WordPad opens and renders in the focused smoke:

```text
WordPad ... PASS  134 APIs, window created, 392 colors
```

Focused typing probe:

```text
click editor, type "hello world", Backspace, Enter, type "again",
Left, Left, Delete, Home, type "X", End, type "Y",
Shift+Left, Shift+Left, type "Z",
Ctrl+A, Ctrl+C, End, Ctrl+V
Ctrl+A, Ctrl+X, Ctrl+V
focus: RichEdit child hwnd=0x10002
text:  "hello worl\r\nXagaZhello worl\r\nXagaZ" via WM_GETTEXT
result: PASS for basic text entry/editing — typed text, Backspace, and Enter
        update the native RichEdit buffer, and Delete/Home/End/Left update the
        insertion position. Shift+Left updates `EM_GETSEL`, and typing replaces
        the selected range. Plain-text Ctrl+A/C/X/V works for focused native
        RichEdit controls.
```

Focused Edit-menu clipboard probe:

```text
type "menu", invoke WordPad/MFC Edit command ids through the WAT menu edit
bridge: Select All (57642), Copy (57634), Paste (57637), Cut (57635)
copy/paste: selected "menu" copies and menu Paste duplicates it to "menumenu"
cut/paste:  selected "menu" cuts to an empty buffer, then menu Paste restores
            "menu"
OLE path:   CreateILockBytesOnHGlobal / StgCreateDocfileOnILockBytes are not
            reached in this plain-text menu bridge path
result:     PASS for Edit-menu Select All / Copy / Cut / Paste plain-text
            behavior on WordPad's focused native RichEdit child.
```

Focused toolbar layout/command probe:

```text
startup, dump windows, capture toolbar-layout screenshot,
click first Standard toolbar button, capture toolbar-command screenshot
toolbars:  Standard and Formatting are visible `ToolbarWindow32` children
           with WAT control class 21 and independent back-surfaces
layout:    MFC control-bar sizing now places RichEdit at y=89, below the two
           toolbar rows and the ruler/status bands
command:   first Standard toolbar button opens WordPad's "New" dialog
result:    PASS for ToolbarWindow32 layout/painting, command-ID-backed button
           hit testing, and the MFC toolbar command path for File New.
```

Focused mouse/scroll probe:

```text
click editor, type "mouse select", drag across the first line,
Ctrl+A, type 35 lines, wheel up over the editor
selection: non-empty `EM_GETSEL` range after mouse drag
scroll:    `EM_GETFIRSTVISIBLELINE` changes from 28 to 22 after wheel input
result:    PASS for native RichEdit mouse selection, long multiline insertion,
           focused native wheel routing, and scrolled screenshot capture.
```

Focused Save As probe:

```text
type "save me", invoke command 57604 (Save As), pick wordpad-save-probe.txt
file path: CreateFileA -> GetFileTime -> non-empty WriteFile -> CloseHandle
OLE path:  CreateFileMoniker -> GetRunningObjectTable -> ROT Register/Release
title:     "wordpad-save-probe.txt - WordPad"
then File New, accept the "New document type" dialog, verify RichEdit len=0
then File Open, pick sources.md, verify ReadFile streaming and loaded text
result:    PASS for Save As, New/clear, and Open/load through WordPad's MFC
           command paths without missing exports or null ROT calls.
```

Focused saved-document reopen probe:

```text
type "save me", Save As wordpad-reopen-saved.txt, File New, then File Open
the saved document again
formatter: wvsprintfA va_list arguments stay in guest-address space while
           RichEdit streams RTF out
result:    PASS: reopened RichEdit text is exactly "save me"; the previous
           raw "{\(null)..." corrupted RTF header is no longer exposed.
```

Focused plain-text filter Save/Open probe:

```text
type "plain text", Save As, select "Text Document" in Files of type,
confirm WordPad's text-only warning, File New, then reopen the saved file
dialog:   common Open/Save dialog mirrors the filter combobox selection into
          OPENFILENAME.nFilterIndex
result:   PASS: WriteFile writes exactly 10 plain-text bytes, not an RTF-sized
          payload, and reopened RichEdit text is exactly "plain text".
```

Focused formatting accelerator probe:

```text
type "style", Ctrl+A, then Ctrl+B / Ctrl+I / Ctrl+U
accelerator: TranslateAcceleratorA now matches Ctrl/Shift/Alt modifier bits
RichEdit:    EM_GETCHARFORMAT reports bold=1, italic=1, underline=1
pixels:      plain vs formatted screenshots differ in the typed-word band
result:      PASS for WordPad formatting command dispatch, native RichEdit
             CHARFORMAT state, and visible B/I/U text rendering. Paragraph
             alignment has separate focused coverage below.
```

Focused formatting toolbar-button probe:

```text
type "style", Ctrl+A, click Formatting toolbar Bold / Italic / Underline
buttons, refocus editor, reselect text, read EM_GETCHARFORMAT
toolbar:     clicks at the formatting toolbar button centers route through
             ToolbarWindow32 -> MFC -> EM_SETCHARFORMAT
RichEdit:    EM_GETCHARFORMAT reports bold=1, italic=1, underline=1 after
             the three toolbar clicks
result:      PASS for formatting-toolbar B/I/U mouse commands. The color
             picker/menu route has separate focused coverage below.
```

Focused formatting round-trip probe:

```text
type "style", Ctrl+A, Format > Font..., pick Arial / Bold Italic / 24pt,
apply Underline and Blue, Save As .rtf, File New, then reopen the saved .rtf
result:      PASS: reopened text is "style" and EM_GETCHARFORMAT on the
             selected reopened text reports bold=1, italic=1, underline=1,
             yHeight=480, color=0xff0000, and face="Arial".
scope:       The VFS write boundary rewrites RichEdit's native RTF sentinels
             `\up3276` / `\fs3277` to `\up0` / `\fs48` from the latest
             explicit 24pt size hint. This is a simple selected-run path, not
             a full mixed-run formatting model.
```

Focused paragraph alignment round-trip probe:

```text
type "align", Ctrl+A, Ctrl+E, Save As .rtf, File New, then reopen the saved
.rtf and reselect the text
RichEdit:    EM_GETPARAFORMAT reports alignment=1 before the command and
             alignment=3 after Ctrl+E, after Save As, and after reopening
RTF:         the saved stream preserves centered paragraph state (`\qc`)
pixels:      centered screenshot shifts the typed-word band from x=17..40 to
             x=287..310 relative to the left-aligned screenshot
result:      PASS for WordPad paragraph center alignment dispatch,
             native RichEdit PARAFORMAT state, visible centered rendering, and
             simple RTF paragraph alignment round-trip.
```

Focused Font dialog probe:

```text
type "font", Ctrl+A, Format > Font..., pick Arial / Bold Italic / 24pt, OK
dialog:      WAT ChooseFontA exposes face/style/size listboxes and writes the
             selected values back to CHOOSEFONT/LOGFONT
handoff:     WordPad sends EM_SETCHARFORMAT with effects=bold|italic,
             yHeight=480, and face="Arial"
RichEdit:    EM_GETCHARFORMAT reports bold=1, italic=1, yHeight=480,
             and face="Arial"
pixels:      before/after screenshots differ in the typed-word band
size:        a GDI/RichEdit font-size hint maps the sentinel-derived font
             create back to the latest explicit CFM_SIZE value; a per-window
             CHARFORMAT cache also patches EM_GETCHARFORMAT size reporting.
             The screenshot ink box grows from 20px to 37px after choosing 24pt
result:      PASS for Font dialog face/style/point-size handoff and visible
             face/style/24pt rendering, including concrete selected-size
             reporting for this latest-size path.
```

Focused direct RichEdit color probe:

```text
type "color", Ctrl+A, apply EM_SETCHARFORMAT(CFM_COLOR) directly to the
focused native RichEdit child
RichEdit:    EM_GETCHARFORMAT reports effects=0 and color=0xff0000
renderer:    SetTextColor sees COLORREF 0x00ff0000, which is blue in Win32
             0x00BBGGRR order
pixels:      before/after screenshots differ in the typed-word band, with
             blue pixels appearing only after the format apply
result:      PASS for the native RichEdit color/rendering path. This bypasses
             WordPad's toolbar/menu color UI; that route has separate focused
             coverage below.
```

Focused formatting toolbar color-menu probe:

```text
type "color", Ctrl+A, click Formatting toolbar color button, inspect popup,
choose Blue from the dynamic owner-draw popup
menu:        CreatePopupMenu/AppendMenuA owner-draw popup exposes 17 color
             command rows (`0x800e..0x801e`) at the TrackPopupMenu anchor
RichEdit:    EM_GETCHARFORMAT reports effects=0 and color=0xff0000 after
             choosing row `#801a` / Blue
renderer:    SetTextColor sees COLORREF 0x00ff0000
pixels:      before/after screenshots differ in the typed-word band, with
             94 blue-dominant pixels after the toolbar color command
result:      PASS for WordPad's toolbar color picker opening, hit-testing, and
             applying the selected color to native RichEdit text.
```

Current evidence from the 2026-08-02 follow-up probe:

- Mouse click now focuses the RichEdit child, so keyboard routing is no longer
  the blocker.
- The standard and formatting toolbars now create as WAT-native
  `ToolbarWindow32` controls, paint visible button placeholders, and report
  enough `TB_*` layout state for WordPad/MFC to size the toolbar rows. The
  native RichEdit child is laid out below them instead of overlapping the top
  of the document area.
- `ToolbarWindow32` now stores the caller's `TBBUTTON` records, returns real
  `idCommand` values from `TB_GETBUTTON`, maps command IDs for state probes,
  and hit-tests mouse clicks. Clicking the first Standard toolbar button now
  opens WordPad's `New` dialog through the app's MFC command route. The
  `LockWindowUpdate` compatibility handler is a successful no-op so MFC's
  toolbar UI update cycle no longer traps.
- Formatting toolbar Bold / Italic / Underline mouse clicks now route through
  the same command path and update native RichEdit character-format state. The
  `GetDCEx` compatibility handler now allocates a client or whole-window DC
  with the existing DC allocator/clip helpers, which unblocks MFC toolbar paint
  and update paths reached by these clicks.
- Renderer keyboard routing now preserves focus on native child controls such
  as WordPad's `RichEdit20A` before falling back to the first WAT `EDIT`. This
  prevents the formatting toolbar's combobox edit child from stealing typing
  after the editor is clicked.
- `WM_CHAR` inserts through the native RichEdit path.
- The test harness can now dump focused native-control text through
  synchronous `WM_GETTEXT`, so WordPad assertions no longer rely only on
  screenshot pixels for the editor buffer.
- Backspace, Delete-forward, Enter, Left, Home, and End update the native
  RichEdit text buffer/insertion position in the current probe.
- Shift+Left selection is observable through `EM_GETSEL`, and typed replacement
  collapses the selection to the expected caret position.
- Ctrl+A selects the native RichEdit buffer, Ctrl+C copies plain text through
  the renderer-side native-text shortcut bridge, Ctrl+X cuts the selected text,
  and Ctrl+V pastes/restores it through `EM_REPLACESEL`.
- Minimal USER clipboard APIs now back `CF_TEXT` / `CF_OEMTEXT`
  (`OpenClipboard`, `CloseClipboard`, `EmptyClipboard`, `SetClipboardData`,
  `GetClipboardData`, `IsClipboardFormatAvailable`, `CountClipboardFormats`,
  `GetClipboardOwner`) using the shared WAT edit clipboard buffer. This is
  generic plain-text infrastructure. WordPad's Edit-menu/MFC ids for Select
  All, Copy, Cut, and Paste now route through a WAT menu edit-command bridge
  for the focused native RichEdit child, using `WM_GETTEXT`, `EM_GETSEL`,
  `EM_SETSEL`, and `EM_REPLACESEL` instead of native RichEdit's rich/OLE
  clipboard storage path. Rich clipboard formats remain later work.
- Mouse drag over the native RichEdit child produces a non-empty `EM_GETSEL`
  range.
- Long multiline insertion produces 35 RichEdit lines and auto-scrolls to the
  caret. Wheel input over the editor now routes through the renderer to the
  focused native RichEdit child and changes `EM_GETFIRSTVISIBLELINE`.
- RichEdit's OLE clipboard setup no longer stops on missing profile/storage
  helpers in the covered path (`GetProfileSectionA`, `GlobalFlags`,
  `CreateILockBytesOnHGlobal`, `StgCreateDocfileOnILockBytes`,
  `WriteClassStg`, `WriteFmtUserTypeStg`). This is compatibility scaffolding,
  not full OLE storage or rich clipboard support.
- WordPad Save As now reaches the common dialog, accepts a picked filename,
  creates/writes/closes the target file, updates the top-level title, and
  returns focus to the native RichEdit child. The MFC/OLE save bookkeeping path
  is covered with minimal `CreateFileMoniker`, `GetRunningObjectTable`, and
  `IRunningObjectTable` scaffolding. This is not full structured storage or
  moniker binding support.
- WordPad File New now clears the native RichEdit buffer after the app's
  document-type dialog is accepted. The fix is generic: `SetWindowTextA/W` now
  forwards `WM_SETTEXT` to native child windows with real wndprocs, rather than
  treating class-0 children as title-only windows.
- WordPad File Open can load an existing text file through the common dialog,
  `CreateFileA` / `ReadFile` streaming, and `GetFileTitleA`; the native
  RichEdit buffer then contains the opened file text and the title updates to
  the opened filename.
- WordPad can reopen a document saved through its own Save As path for simple
  typed text. The blocking bug was `wvsprintfA`: it passed a `va_list` through
  `g2w` even though the shared formatter reads guest addresses with `gl32`,
  corrupting RichEdit's streamed RTF header with `(null)` placeholders.
- WordPad Ctrl+B / Ctrl+I / Ctrl+U now reach the app's accelerator table and
  dispatch Bold / Italic / Underline commands. The generic fix is in
  `TranslateAcceleratorA`: it now matches `FVIRTKEY` entries with exact
  Shift/Ctrl/Alt modifier state instead of skipping modifier accelerators.
  `EM_GETCHARFORMAT(SCF_SELECTION)` confirms the selected native RichEdit text
  has bold, italic, and underline effects after the shortcuts. The focused
  regression also compares plain/formatted editor screenshots and confirms the
  typed-word pixels visibly change.
- WordPad can save and reopen a simple RTF document with selected-run
  face/style/size/color state preserved in RichEdit charformat state. The
  focused round-trip now covers Arial / Bold Italic / Underline / 24pt / Blue.
  The VFS write boundary rewrites RichEdit's native `\up3276` / `\fs3277`
  sentinels to `\up0` / `\fs48` from the latest explicit size hint; mixed-size
  runs and advanced RTF remain follow-up work.
- WordPad paragraph center alignment now routes through the app command path
  and survives a simple RTF Save As -> New -> Open round-trip. The focused
  regression verifies `EM_GETPARAFORMAT` reports `alignment=3` after Ctrl+E,
  after Save As, and after reopening; the saved stream includes centered
  paragraph state and screenshot pixels show the word shifted to the centered
  page position. Indents, tabs, numbering, and advanced paragraph formatting
  remain follow-up work.
- WordPad Format > Font now opens the WAT `ChooseFontA` dialog and returns the
  selected face/style/size through `CHOOSEFONT`/`LOGFONT`. In the focused probe,
  selecting Arial / Bold Italic / 24pt makes WordPad send
  `EM_SETCHARFORMAT(yHeight=480, effects=bold|italic, face="Arial")`; native
  RichEdit then reports bold/italic, `yHeight=480`, and face `Arial`. A narrow
  GDI/RichEdit font-size hint uses the latest explicit `CFM_SIZE` value when
  native RichEdit later asks GDI for the known sentinel-derived huge font
  height, so the before/after editor screenshots visibly show 24pt text. The
  same latest-size value is cached per HWND and patched into
  `EM_GETCHARFORMAT`; mixed-size run reporting remains later work.
- A direct focused RichEdit color probe now applies
  `EM_SETCHARFORMAT(CFM_COLOR)` to the selected WordPad text. Native RichEdit
  reports `color=0xff0000` with autocolor cleared, `SetTextColor` receives that
  COLORREF, and the screenshot shows blue text pixels. This validates the
  RichEdit color/rendering path independently from WordPad's own UI.
- WordPad's formatting-toolbar color button now opens its temporary owner-draw
  popup through WAT-backed dynamic HMENU state. `CreatePopupMenu` allocates a
  menu record, `AppendMenuA(MF_OWNERDRAW)` stores the 17 color command ids, and
  `TrackPopupMenu` synthesizes a transient dropdown blob for WAT painting and
  hit-testing. Because the emulator's `TrackPopupMenu` is asynchronous while
  WordPad destroys the temporary MFC menu state immediately after opening it,
  `menu_try_edit_command` has a narrow fallback for `0x800e..0x801e` that
  applies the selected Win32 `COLORREF` directly to WordPad's `RichEdit20A`
  child (`id=0xE900`).
- The shared Open/Save dialog now exposes a `Files of type` combobox from
  `OPENFILENAME.lpstrFilter` and writes the selected item back to
  `OPENFILENAME.nFilterIndex`. WordPad's `Text Document` selection shows the
  expected text-only warning, writes the exact plain-text byte count, and
  reopens through File Open as native RichEdit text.
- Worker-thread thunk metadata is synchronized before/after thread slices, so a
  worker can no longer allocate a stale `GetProcAddress` thunk over RichEdit's
  imported KERNEL32 thunk table.
- `EnumFontFamiliesExA/W` / `EnumFontFamiliesA/W` now enumerate one basic
  TrueType-style `Arial` face through the app callback. This unblocks WordPad's
  font-list startup path before `ShowWindow` and the ANSI font enumeration path
  used while creating the visible formatting toolbar.
- The `32767 twips` RichEdit sentinel is clamped during the exact screen-DPI
  `MulDiv(32767, 96, 1440)` conversion, so text no longer paints at a large
  negative y coordinate.
- `ExtTextOutA/W` now honors `ETO_OPAQUE` rect fills, so RichEdit's erase bands
  clear to the DC background instead of leaving black memory-DC strips.
- Regression test: `node test/test-wordpad-richedit.js` passes 22/22 and
  writes `test/output/wordpad-richedit/hello-world-edited.png`, which shows
  visible edited text in the editor.
- Regression test: `node test/test-wordpad-menu-edit-clipboard.js` passes 17/17
  and writes `test/output/wordpad-richedit/menu-edit-copy-paste.png` plus
  `test/output/wordpad-richedit/menu-edit-cut-paste.png`; it covers WordPad
  Edit-menu Select All / Copy / Cut / Paste command ids through the WAT menu
  edit bridge, with Copy/Paste duplicating `menu` to `menumenu`, Cut/Paste
  restoring cut text, and no RichEdit OLE clipboard-storage calls on this
  plain-text path.
- Regression test: `node test/test-wordpad-toolbar.js` passes 13/13 and writes
  `test/output/wordpad-richedit/toolbar-layout.png` plus
  `test/output/wordpad-richedit/toolbar-command-new.png`, covering visible
  standard/formatting toolbars and the first Standard toolbar button opening
  WordPad's `New` dialog.
- Regression test: `node test/test-wordpad-richedit-scroll.js` passes 10/10
  and writes `test/output/wordpad-richedit/mouse-scroll.png`, which shows
  visible scrolled multiline text in the editor.
- Regression test: `node test/test-wordpad-save-as.js` passes 32/32 and covers
  WordPad's Save As, New/clear, and Open/load command/file/OLE bookkeeping
  paths.
- Regression test: `node test/test-wordpad-reopen-saved.js` passes 22/22 and
  covers Save As -> New -> Open of the saved simple RichEdit document.
- Regression test: `node test/test-wordpad-plain-text-filter.js` passes 22/22
  and writes `test/output/wordpad-richedit/plain-text-filter.png`; it covers
  WordPad Save As -> `Text Document` filter -> text-only warning -> exact
  plain-text write -> New -> Open of the saved `.txt`.
- Regression test: `node test/test-wordpad-format-accelerators.js` passes 13/13
  and writes `test/output/wordpad-richedit/format-accelerators-plain.png` plus
  `test/output/wordpad-richedit/format-accelerators.png`; the typed-word band
  shows 155 changed pixels and 58 more dark pixels after B/I/U formatting.
- Regression test: `node test/test-wordpad-toolbar-format-buttons.js` passes
  10/10 and writes
  `test/output/wordpad-richedit/toolbar-format-buttons-plain.png` plus
  `test/output/wordpad-richedit/toolbar-format-buttons.png`; it covers
  formatting-toolbar Bold / Italic / Underline mouse clicks without relying on
  keyboard accelerators.
- Regression test: `node test/test-wordpad-format-roundtrip.js` passes 20/20
  and writes `test/output/wordpad-richedit/format-roundtrip.png`; it covers
  Save As -> New -> Open of a simple RTF document with Arial / Bold Italic /
  Underline / 24pt / Blue preserved on the reopened selected text.
- Regression test: `node test/test-wordpad-paragraph-align.js` passes 26/26
  and writes `test/output/wordpad-richedit/paragraph-align-left.png`,
  `test/output/wordpad-richedit/paragraph-align-center.png`, and
  `test/output/wordpad-richedit/paragraph-align-reopen.png`; it covers Ctrl+E
  center alignment, `EM_GETPARAFORMAT` readback, visible centered rendering, and
  Save As -> New -> Open of a simple RTF document with paragraph center
  alignment preserved.
- Regression test: `node test/test-wordpad-font-dialog.js` passes 16/16 and
  writes `test/output/wordpad-richedit/font-dialog-plain.png` plus
  `test/output/wordpad-richedit/font-dialog.png`; the typed-word band shows
  1779 changed pixels, 510 more dark pixels, and ink height growing from 20px
  to 37px after applying Arial Bold Italic 24pt through Format > Font.
- Regression test: `node test/test-wordpad-richedit-color.js` passes 12/12 and
  writes `test/output/wordpad-richedit/richedit-color-plain.png` plus
  `test/output/wordpad-richedit/richedit-color-blue.png`; the typed-word band
  shows 96 changed pixels and 94 blue-dominant pixels after applying direct
  `CFM_COLOR`.
- Regression test: `node test/test-wordpad-toolbar-color-menu.js` passes 13/13
  and writes `test/output/wordpad-richedit/toolbar-color-menu-plain.png`,
  `test/output/wordpad-richedit/toolbar-color-menu-popup.png`, and
  `test/output/wordpad-richedit/toolbar-color-menu-blue.png`; it covers the
  formatting-toolbar color popup's dynamic owner-draw commands and Blue color
  application through the WordPad UI route.

## Write Launcher

**Binary:** `test/binaries/win98-apps/write.exe`
**Status (2026-07-14):** PASS in the all-EXE smoke matrix.

The Win98 `write.exe` binary is only a compatibility launcher. It calls
`ShellExecuteA(..., "wordpad.exe", ...)` and exits cleanly without drawing its
own window, so the smoke harness validates the `ShellExecuteA` call and skips
the blank-canvas gate for this case.

## Threading Note

The older blocker was `ResumeThread` during OLE/COM initialization. The current
handler returns a previous suspend count and advances the stack, which is enough
for the WordPad startup smoke. Thread creation still does not fully model
`CREATE_SUSPENDED`; that is a fidelity issue, not a current WordPad startup
blocker.

## Follow-Up

1. Add true `CREATE_SUSPENDED` handling in `lib/thread-manager.js` if another
   app depends on threads staying suspended until `ResumeThread`.
2. Extend `$handle_ResumeThread` to call a host unsuspend import once the thread
   manager tracks suspend counts.
3. Expand WordPad coverage beyond basic insertion/deletion/newline/navigation:
   visible caret assertions, visible selection highlight, scrollbar drag,
   wrapping, advanced toolbar UI state, mixed-run size reporting, and paragraph
   indents/tabs/numbering still need focused probes. Font dialog
   face/style/point-size handoff, concrete latest-size `EM_GETCHARFORMAT`
   reporting, visible 24pt rendering, simple RTF face/style/size/color
   round-trip, simple paragraph center-alignment round-trip, Edit-menu
   Select All/Copy/Cut/Paste plain-text commands, visible toolbar layout,
   first-toolbar-button command routing, formatting-toolbar B/I/U mouse
   commands, and direct RichEdit color rendering are now covered, and WordPad's
   own toolbar color UI now applies Blue through the covered dynamic-popup path.
4. Add richer native RichEdit state dumps if deeper assertions are needed
   (caret/selection/scroll). Current coverage reads plain text through
   `WM_GETTEXT`.
5. Treat images, tables, embedded OLE objects, and advanced RTF layout as later
   RichEdit work; the current target is app-useful plain-text editing.

RichEdit implementation scope is tracked in
[`docs/richedit-compat-design.md`](../docs/richedit-compat-design.md).

**Key files:** `lib/thread-manager.js`, `lib/renderer-input.js`,
`lib/renderer.js`, `lib/host-imports.js`, `lib/filesystem.js`,
`src/09a-handlers.wat`, `src/09a5-handlers-window.wat`,
`src/09c3-controls.wat`
