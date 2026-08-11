# WordPad (Win98) — PARTIAL

**Binary:** `test/binaries/win98-apps/wordpad.exe`  
**Status (2026-08-11):** PARTIAL.

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
            behavior on WordPad's focused native RichEdit child. The current
            screenshot guard also confirms multiline editing no longer copies
            title/menu chrome into the toolbar/ruler band.
```

Focused rich clipboard probe:

```text
type "café\r\ntwo", Select All, apply Blue plus basic paragraph numbering /
indents / tab, then Copy / Clear / Paste through both menu and keyboard paths
clipboard: registered non-OLE "Rich Text Format" is stable, advertised by
           CountClipboardFormats/IsClipboardFormatAvailable, and returned by
           GetClipboardData alongside CF_TEXT
RTF:       generated RTF escapes ANSI high-byte text and CRLF
           (`caf\'e9\par two`)
format:    Paste restores selected character color plus paragraph numbering,
           start/right indents, first-line offset, and first tab stop after
           insertion formatting is reset
result:    PASS for same-session non-OLE RTF clipboard data plus basic
           RichEdit character/paragraph-format preservation on menu and
           Ctrl+C/Ctrl+X/Ctrl+V paths. Embedded objects, OLE storage transfer,
           images, tables, and advanced RTF remain deferred.
```

Focused selection-highlight probe:

```text
type "select me", screenshot plain text, Ctrl+A, read `EM_GETSEL`, screenshot
selected text
selection: `EM_GETSEL` reports a non-empty selected range
pixels:    selected screenshot gains ~1.9k blue-dominant pixels in the
           RichEdit text band versus the plain screenshot
result:    PASS for visible native RichEdit selection highlight.
```

Focused caret probe:

```text
type "caret", trace CreateCaret / SetCaretPos / ShowCaret, dump RichEdit
window geometry, capture screenshot
caret:  native RichEdit creates a USER caret and sets it to x=48, y=3 after
        typing "caret"
pixels: screenshot has a dark 13px vertical caret stroke at the expected
        RichEdit client coordinate
result: PASS for visible native RichEdit caret paint. Blink/XOR cadence is
        still deferred.
```

Focused toolbar layout/command probe:

```text
startup, dump windows, capture toolbar-layout screenshot,
click first Standard toolbar button, capture toolbar-command screenshot
toolbars:  Standard and Formatting `ToolbarWindow32` children exist with WAT
           control class 21 and reserve the expected rows below the menu
layout:    MFC control-bar sizing now places RichEdit at y=89, below the two
           toolbar rows and the ruler/status bands
command:   first Standard toolbar button opens WordPad's "New" dialog
visuals:   nested toolbar child surfaces now composite through the MFC
           `AfxControlBar42` container, and `TB_ADDBITMAP` app strips now
           blit real colored button icons instead of placeholder-only squares
           The formatting toolbar surface/client width is bounded to the
           containing control bar instead of dumping/allocation as a 1512px
           child in a 394px frame. Toolbar-hosted font/size combobox fields
           now paint white interiors.
result:    PASS for ToolbarWindow32 layout, bounded formatting toolbar width,
           visible bitmap icons, combobox field paint, command-ID-backed
           button hit testing, and the MFC toolbar command path for File New.
           Common-control built-in strips, masked transparency/color remapping,
           and populated toolbar font/size text remain follow-up fidelity.
```

Focused mouse/scroll probe:

```text
click editor, type "mouse select", drag across the first line,
Ctrl+A, type 35 lines, wheel up over the editor, drag the scrollbar thumb
selection: non-empty `EM_GETSEL` range after mouse drag
scroll:    `EM_GETFIRSTVISIBLELINE` changes after wheel input and again after
           right-band scrollbar thumb drag
result:    PASS for native RichEdit mouse selection, long multiline insertion,
           focused native wheel/thumb routing, and scrolled screenshot capture.
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
.rtf
RichEdit:    EM_GETPARAFORMAT reports alignment=1 before the command and
             alignment=3 after Ctrl+E and after Save As
RTF:         the saved stream preserves centered paragraph state (`\qc`)
pixels:      centered screenshot shifts the typed-word band from x=17..40 to
             x=287..310 relative to the left-aligned screenshot
result:      PASS for WordPad paragraph center alignment dispatch,
             native RichEdit PARAFORMAT state, visible centered rendering,
             saved centered RTF, and reopening the saved file as text.
scope:       The bounded test no longer waits for an extra post-open
             paragraph-state probe; indents, tabs, numbering, and more complex
             paragraph RTF remain follow-up work.
```

Focused paragraph field RTF round-trip probe:

```text
type "para", Ctrl+A, apply PARAFORMAT2 fields directly to the focused
native RichEdit child, Save As .rtf, File New, then reopen the saved .rtf
RichEdit:    EM_GETPARAFORMAT reports numbering=1, dxStartIndent=720,
             dxRightIndent=360, dxOffset=-240, tabCount=1, tab0=1440
             before Save As, after Save As, and after reopening
RTF:         the saved stream contains bullet paragraph controls, `\fi240`,
             `\li480`, `\ri360`, and `\tx1440`
result:      PASS for basic paragraph numbering/indent/tab RTF round-trip.
scope:       Advanced paragraph layout, multiple paragraph runs, tables, and
             embedded objects remain follow-up work.
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
  `ToolbarWindow32` controls and report enough `TB_*` layout state for
  WordPad/MFC to size the toolbar rows. The native RichEdit child is laid out
  below them instead of overlapping the top of the document area. The renderer
  now recurses through non-own-surface MFC containers such as `AfxControlBar42`
  and clips oversized child canvases to the top-level window, so nested toolbar
  child surfaces are visible and do not spill outside WordPad. Formatting
  toolbar child surfaces/client rects are also bounded to the containing
  control bar, avoiding the previous 1512px-wide child allocation in a 394px
  frame. Toolbar `TB_ADDBITMAP` app strips now render through centered SRCCOPY
  blits from `TBBUTTON.iBitmap`; common-control built-in strips and masked
  transparency/color remapping remain follow-up fidelity.
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
- Toolbar-hosted dropdown comboboxes now paint their field backgrounds from
  the combobox proc, so the WordPad font/size fields no longer show gray blank
  interiors. The fields are still visually empty because WordPad's startup font
  combo initialization is currently observed sending selection/text messages to
  hwnd=0; populated toolbar font/size text remains a follow-up control-attach
  task.
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
- Ctrl+A selection now has focused screenshot coverage: the selected RichEdit
  text renders white-on-blue, with the selected screenshot gaining blue-dominant
  pixels in the document text band.
- Ctrl+A selects the native RichEdit buffer, Ctrl+C copies plain text through
  the renderer-side native-text shortcut bridge, Ctrl+X cuts the selected text,
  and Ctrl+V pastes/restores it through `EM_REPLACESEL`.
- Minimal USER clipboard APIs now back `CF_TEXT` / `CF_OEMTEXT`
  (`OpenClipboard`, `CloseClipboard`, `EmptyClipboard`, `SetClipboardData`,
  `GetClipboardData`, `IsClipboardFormatAvailable`, `CountClipboardFormats`,
  `GetClipboardOwner`) using emulator-owned buffers. `RegisterClipboardFormatA/W`
  now gives `"Rich Text Format"` a stable registered id, and
  `SetClipboardData`/`GetClipboardData`/availability/count queries expose a
  non-OLE RTF byte stream alongside plain text. WordPad's Edit-menu/MFC ids for
  Select All, Copy, Cut, and Paste route through a WAT edit-command bridge for
  the focused native RichEdit child, and renderer Ctrl+C/Ctrl+X/Ctrl+V now use
  the same backend. The bridge snapshots basic selected `CHARFORMAT` /
  `PARAFORMAT` state on Copy/Cut and reapplies it to the inserted Paste range
  after querying RichEdit's post-paste `EM_GETSEL`, so CRLF/ANSI caret
  semantics stay owned by RichEdit. Embedded objects, OLE storage transfer, and
  advanced RTF/image/table fidelity remain later work.
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
- WordPad paragraph center alignment now routes through the app command path.
  The focused regression verifies `EM_GETPARAFORMAT` reports `alignment=3`
  after Ctrl+E and after Save As; the saved stream includes centered paragraph
  state (`\qc`), reopening restores the saved text, and screenshot pixels show
  the word shifted to the centered page position.
- Focused RichEdit paragraph-field round-trip now covers directly-set
  PARAFORMAT2 numbering, start/right indents, first-line offset, and first tab
  stop. Native RichEdit streams those fields to RTF (`\pn*`, `\fi240`,
  `\li480`, `\ri360`, `\tx1440`) and restores them after Save As -> New ->
  Open. The per-window test-bridge format cache now clears on full text
  replacement (`WM_SETTEXT` / `EM_STREAMIN`) so post-open readback is not stale.
  Advanced paragraph RTF remains follow-up work.
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
- `ExtTextOutA/W` now honors `ETO_OPAQUE` rect fills and `ETO_CLIPPED` glyph
  clipping, so RichEdit's erase bands clear to the DC background and long-line
  paints stay constrained to the native paint rectangle.
- `ScrollWindow` / `ScrollWindowEx` now scroll only the target window's client
  rectangle in the backing store, and explicit scroll/clip `RECT` arguments are
  intersected in client coordinates for both host copy/fill and WAT update
  invalidation. This fixes the WordPad multiline edit path where RichEdit's
  line-scroll operation had copied top-level title/menu pixels into the
  toolbar/ruler band, while keeping the scroll primitive reusable for other
  child controls.
- The shared WAT multiline `EDIT` / RichEdit-compatible path now recalculates
  wrapped visual lines on `WM_SIZE` and clamps stale first-visible-line state to
  the resized scroll range. This covers the bounded resize/wrap edge used by
  the current native-edit path; broader RichEdit layout/version quirks remain
  follow-up work.
- Direct GDI regression test:
  `node test/test-gdi-exttextout-clipping.js` verifies clipped glyph drawing
  and null-text opaque erases on a surface DC.
- Direct GDI regression test:
  `node test/test-gdi-scroll-window-rect.js` verifies that default scrolling
  does not move non-client chrome and that `ScrollWindowEx`-style scroll/clip
  rectangles bound both the copied pixels and exposed white strip.
- Direct WAT regression test:
  `node test/test-edit-wrap-resize.js` verifies narrow wrapped multiline edit
  layout, scroll range, wheel-to-bottom behavior, resize to a smaller maximum,
  and `WM_SIZE` clamping of `EM_GETFIRSTVISIBLELINE`.
- Regression test: `node test/test-wordpad-richedit.js` passes 23/23 and
  writes `test/output/wordpad-richedit/hello-world-edited.png`, which shows
  visible edited text in the editor and asserts there is no duplicated
  title/menu chrome in the toolbar/ruler band.
- Regression test: `node test/test-wordpad-richedit-clipping.js` passes 11/11
  and writes `test/output/wordpad-richedit/long-line-clipped.png`; it types
  100 chars, observes native RichEdit line metrics, confirms
  `ExtTextOutA(... fuOptions=4, lprc=...)`, and checks that glyphs do not spill
  into the desktop band outside WordPad.
- Regression test: `node test/test-wordpad-menu-edit-clipboard.js` passes 17/17
  and writes `test/output/wordpad-richedit/menu-edit-copy-paste.png` plus
  `test/output/wordpad-richedit/menu-edit-cut-paste.png`; it covers WordPad
  Edit-menu Select All / Copy / Cut / Paste command ids through the WAT menu
  edit bridge, with Copy/Paste duplicating `menu` to `menumenu`, Cut/Paste
  restoring cut text, and no RichEdit OLE clipboard-storage calls on this
  plain-text path.
- Regression test: `node test/test-wordpad-rich-clipboard-format.js` passes
  21/21; it covers WordPad menu Copy/Clear/Paste of selected native RichEdit
  text containing ANSI high-byte `é` plus CRLF, verifies the pasted caret stays
  at RichEdit's logical CRLF position, verifies CF_TEXT plus registered
  non-OLE RTF clipboard data is advertised/readable, and proves basic selected
  character color plus paragraph numbering/indent/tab fields survive Paste even
  after the insertion formatting is reset before paste.
- Regression test:
  `node test/test-wordpad-keyboard-rich-clipboard-format.js` passes 19/19; it
  covers Ctrl+C/Ctrl+X/Ctrl+V on the focused native RichEdit child, including
  registered non-OLE RTF clipboard data, ANSI high-byte/CRLF escaping, logical
  CRLF caret positioning, and basic character/paragraph-format preservation.
- Direct WAT regression test: `node test/test-clipboard-rtf-api.js` passes
  13/13; it covers stable ANSI/Unicode `"Rich Text Format"` registration,
  distinct ids for unrelated registered formats, RTF availability/count/handle
  queries, byte round-trip, and `EmptyClipboard` clearing.
- Regression test: `node test/test-wordpad-selection-highlight.js` passes 8/8
  and writes `test/output/wordpad-richedit/selection-highlight-plain.png` plus
  `test/output/wordpad-richedit/selection-highlight.png`; it verifies Ctrl+A
  selects the native RichEdit text and the screenshot gains a visible blue
  selection band.
- Regression test: `node test/test-wordpad-caret.js` passes 11/11 and writes
  `test/output/wordpad-richedit/caret.png`; it verifies native RichEdit USER
  caret API calls are tracked and composited as a visible vertical caret
  stroke in the document band.
- Regression test: `node test/test-wordpad-toolbar.js` passes 16/16 and writes
  `test/output/wordpad-richedit/toolbar-layout.png` plus
  `test/output/wordpad-richedit/toolbar-command-new.png`, covering allocation,
  layout, visible bitmap-strip icon painting of the standard/formatting
  toolbar rows, and the first Standard toolbar button opening WordPad's `New`
  dialog. The pixel assertions measure only the toolbar button rows, including
  colored icon pixels so placeholder-only buttons regress.
- Regression test: `node test/test-wordpad-richedit-scroll.js` passes 11/11
  and writes `test/output/wordpad-richedit/mouse-scroll.png`, which shows
  visible scrolled multiline text in the editor after wheel and thumb-drag
  routing.
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
- Regression test: `node test/test-wordpad-paragraph-align.js` passes 17/17
  and writes `test/output/wordpad-richedit/paragraph-align-left.png`,
  and `test/output/wordpad-richedit/paragraph-align-center.png`; it covers
  Ctrl+E center alignment, `EM_GETPARAFORMAT` readback before/after Save As,
  visible centered rendering, saved `\qc` RTF, and reopening that document as
  RichEdit text.
- Regression test: `node test/test-wordpad-paraformat-fields.js` passes 13/13;
  it covers focused RichEdit PARAFORMAT2 readback for directly-set numbering,
  start/right indents, first-line offset, and the first tab stop.
- Regression test: `node test/test-wordpad-paraformat-roundtrip.js` passes
  20/20; it covers saved RTF bullet/indent/tab controls and reopened
  `EM_GETPARAFORMAT` state for the same paragraph fields.
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
   caret blink/XOR cadence, broader RichEdit wrapping/layout edge cases,
   advanced toolbar UI state, mixed-run size reporting, and embedded
   OLE/object clipboard fidelity still need focused probes. Font dialog
   face/style/point-size handoff, concrete latest-size `EM_GETCHARFORMAT`
   reporting, visible 24pt rendering, simple RTF face/style/size/color
   round-trip, simple paragraph center-alignment round-trip, Edit-menu
   Select All/Copy/Cut/Paste plain-text commands, menu Copy/Paste basic
   RichEdit character/paragraph-format preservation, keyboard rich-format
   clipboard shortcuts, registered non-OLE RTF clipboard data, paragraph
   indents/tabs/numbering, visible selection highlight, visible caret paint,
   toolbar row layout, first-toolbar-button command routing,
   toolbar bitmap icon rendering, formatting-toolbar B/I/U mouse commands,
   direct RichEdit color rendering, and clipped long-text RichEdit painting
   are now covered, and WordPad's own toolbar color UI now applies Blue through
   the covered dynamic-popup path.
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
