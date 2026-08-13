# RichEdit Compatibility Task Design

Last updated: 2026-08-12.

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
| non-OLE RTF clipboard data     |            | embedded/OLE clipboard objs  |
| mouse selection / wheel scroll |            | TOM/COM / accessibility / D&D|
| plain text stream I/O          |            | exact version quirks         |
| basic RTF + basic formatting   |            | image/table clipboard data   |
| simple paragraph alignment     |            | indents / tabs / numbering   |
| basic toolbar command fidelity |            | advanced toolbar UI state    |
| clipped ExtTextOut rendering   |            | full resize/wrap edge cases  |
| native scrollbar thumb routing |            |                               |
| bounded resize/wrap clamp      |            |                               |
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
              -> menu and keyboard Copy/Cut advertise CF_TEXT plus registered
                 non-OLE "Rich Text Format" data for selected text
              -> menu and keyboard Paste restore basic selected char/paragraph
                 formatting for the bounded same-session clipboard path
              -> mouse drag selects text
              -> 35-line text auto-scrolls, wheel changes first visible line
              -> standard/format toolbar rows are allocated above the editor
              -> toolbar app bitmap strips render visible color-keyed icons
              -> formatting toolbar packs combo/button items so the color
                 button remains visible in the narrow WordPad control bar
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

Related common-control scroll status: WAT-native `SysTreeView32` and the
bounded report-style `SysListView32` subset now reuse the same shared vertical
scrollbar hit/drag math as the RichEdit/Edit/ListBox paths. The ListView
subset also has bounded report-column get/set, item/subitem rectangle queries,
subitem hit-test output, selection/click notifications, and a pseudo-header
query surface for RegEdit/installer-style report panes, including header item
set/get, layout, hit-test, rect, and identity order-array queries. It also
covers common query/invalidation messages used by report-pane callers: string width,
find-by-text/lParam, item position, origin/view rect, spacing, update, and
redraw. ListView background/text color messages round-trip and feed bounded
report-mode row painting, including `CLR_NONE` text-background handling.
Single row/column deletion keeps the bounded report state coherent, and
ListView image-list handles plus per-item image/lParam metadata now round-trip.
The report painter also draws in-range items from bounded bitmap-strip image
lists through color-keyed `TransparentBlt`, without claiming full icon-mode
rendering.

That means these pieces are already good enough for basic insertion:

- focus can reach the RichEdit child;
- keyboard input routes to the focused child instead of the frame;
- `WM_CHAR` insertion reaches native RichEdit;
- synchronous `WM_GETTEXT` can read the focused native RichEdit buffer through
  the test harness;
- native RichEdit USER caret API calls (`CreateCaret`, `SetCaretPos`,
  `ShowCaret`) are tracked and composited as an inverted blinking caret stroke;
- Backspace, Delete-forward, Enter, Left, Home, and End update that native
  buffer/insertion position in the current probe;
- Shift+Left selection is visible through `EM_GETSEL`, and typing replacement
  updates/collapses the selected range;
- Ctrl+A selection visibly paints white-on-blue in the WordPad RichEdit text
  band;
- Ctrl+A/C/X/V works for focused native RichEdit controls through the
  renderer-side native-text shortcut bridge, with Copy/Cut publishing CF_TEXT
  plus registered non-OLE RTF data and Paste restoring the bounded same-session
  char/paragraph-format snapshot;
- WordPad Edit-menu Select All / Copy / Cut / Paste command ids route through a
  WAT menu edit bridge for the focused native RichEdit child, including the
  same CF_TEXT plus registered non-OLE RTF clipboard data and bounded
  same-session char/paragraph-format restoration;
- mouse drag changes native RichEdit selection state;
- long multiline text inserts, auto-scrolls to the caret, and focused native
  wheel input changes `EM_GETFIRSTVISIBLELINE`;
- native RichEdit right-band scrollbar thumb drag reuses the shared scrollbar
  hit/drag math and changes `EM_GETFIRSTVISIBLELINE`;
- WordPad's standard and formatting `ToolbarWindow32` rows are allocated, and
  the native RichEdit child is laid out below them;
- WordPad toolbar app bitmap strips render colored icons through a
  `TransparentBlt`-style `RGB(192,192,192)` color-key path instead of
  placeholder-only buttons or raw `SRCCOPY` tiles;
- WordPad's formatting toolbar child surface/client width is bounded to the
  containing MFC control bar, and toolbar-hosted font/size combo fields paint
  white interiors with populated `Times New Roman` / `10` text;
- oversized toolbar-hosted combo item rects are capped against the containing
  control bar, keeping WordPad's Bold / Italic / Underline / Color buttons
  fully visible on the 394px formatting row;
- the first Standard toolbar button routes through WordPad/MFC and opens the
  New document-type dialog;
- formatting toolbar Bold / Italic / Underline buttons route through WordPad UI
  and update native RichEdit character-format state;
- a simple WordPad RTF Save As -> New -> Open round-trip preserves one
  selected run's face/style/size/color state: Arial / Bold Italic / Underline /
  24pt / Blue, with reopened `EM_GETCHARFORMAT` reporting `underline=1`,
  `yHeight=480`, `color=0xff0000`, and face `Arial`;
- WordPad paragraph center alignment routes through the app command path,
  reports `alignment=3` before/after Save As, emits `\qc` in the saved RTF,
  and reopens that saved document as RichEdit text;
- keyboard routing preserves focused native RichEdit before using the WAT EDIT
  fallback, so toolbar combobox edit children do not steal document typing;
- `ExtTextOutA/W` supports `ETO_OPAQUE` erase rectangles and `ETO_CLIPPED`
  glyph clipping, including the long-line WordPad RichEdit paint path;
- the observed RichEdit `32767 twips` font-height sentinel no longer moves
  text far offscreen.
- wrapped multiline Edit/RichEdit controls recompute visual line count from the
  current control geometry on `WM_SIZE` and clamp `EM_GETFIRSTVISIBLELINE` to
  the resized scroll range in the bounded WAT path.

This does not mean RichEdit is feature complete. It only proves the first
native-editing path is alive.

### 2026-08-10 implementation progress

- Added registered non-OLE `"Rich Text Format"` clipboard support on top of
  the existing USER clipboard subset. `RegisterClipboardFormatA/W` now returns
  a stable RTF id, and `SetClipboardData`, `GetClipboardData`,
  `IsClipboardFormatAvailable`, `CountClipboardFormats`, and `EmptyClipboard`
  share emulator-owned CF_TEXT/CF_OEMTEXT plus RTF buffers.
- Added a bounded RTF generator for native RichEdit copy paths. It emits
  simple `{\rtf1\ansi ...}` text RTF, escapes `\`, `{`, `}`, ANSI high-byte
  bytes as `\'xx`, and CRLF/LF/CR as `\par `. This is enough for non-OLE
  text-transfer interoperability; it does not claim image/table/OLE coverage.
- Routed renderer Ctrl+C/Ctrl+X/Ctrl+V for focused native RichEdit through the
  WAT clipboard helpers, matching the WordPad menu bridge instead of keeping a
  separate JS-only plain-text buffer.
- Extended `test/run.js` with `dump-clipboard`, then added
  `test/test-clipboard-rtf-api.js`,
  `test/test-wordpad-keyboard-rich-clipboard-format.js`, and extra assertions
  in `test/test-wordpad-rich-clipboard-format.js` for RTF format count,
  availability, handles, ANSI high-byte/CRLF escaping, and basic RichEdit
  char/paragraph-format preservation.
- Reused the shared Win98 vertical scrollbar helpers for WAT-native
  `SysTreeView32` overflow rows.
- TreeView line/page clicks, thumb drag, `WM_MOUSEWHEEL`, `WM_VSCROLL`,
  `TVGN_FIRSTVISIBLE`, `TVM_HITTEST`, and mouse selection now share the same
  first-visible row offset. The same standalone coverage now also asserts
  parent/child links through `TVGN_CHILD` / `TVGN_PARENT`, depth-first
  `TVGN_NEXTVISIBLE`, `TVM_GETITEMA` caller-buffer text copying, and collapsed
  versus expanded visibility through `TVM_EXPAND`.
- Added `test/test-treeview-scroll.js`, a standalone WAT regression that creates
  a TreeView, inserts 12 rows, verifies wheel/arrow/page/thumb scroll behavior,
  hit-testing through the scroll offset, selection, hierarchy expand/collapse,
  `TVIF_CHILDREN`, `TVM_GETITEMA` text copying, depth-first visible order,
  expand/collapse notifications, and slot cleanup.
  `test/run.js` can dump TreeView item state plus paint counters for future
  app-level probes.
- Added bounded report-style `SysListView32` state: columns, fixed 8-subitem
  row text, item count, single-row selection, top index, `LVM_GETITEMTEXTA`,
  `LVM_SETITEMTEXTA`, `LVM_HITTEST`, `LVM_ENSUREVISIBLE`, `LVM_SCROLL`, and
  `LVM_*ITEMSTATE` coverage.
- Reused the shared vertical scrollbar helpers for ListView wheel,
  `WM_VSCROLL`, arrow/page clicks, and thumb drag.
- Added `test/test-listview.js`, a standalone WAT regression that creates a
  ListView, inserts report columns plus 12 rows, verifies text/subitem
  round-trips, hit-testing through the scroll offset, selection, scrollbar
  behavior, bounded query/invalidation messages, color messages/paint use,
  bounded report-mode image-list strip painting, and cleanup.
- Protected `SysListView32` from registered-class fallback so RegEdit routes
  `CreateWindowExA("SysListView32", ...)` to the WAT-native ListView instead
  of its guest/COMCTL32 window proc.
- Rebuilt and reran the direct RegEdit screenshot smoke; it now reaches the
  scheduled input steps, classifies the ListView as `ctrlClass=18`, and writes
  `/private/tmp/regedit-listview-smoke.png` with the `Name` / `Data` headers
  visible.
- Registry storage now has direct coverage for materialized parent keys,
  case-insensitive root/subkey open, root-handle queries, `RegEnumKeyA/W`, and
  `RegEnumValueA/W` buffer semantics, plus `RegQueryInfoKeyA/W` counts and max
  lengths. `DrawAnimatedRects` is handled as a synchronous cosmetic success so
  controls can continue their update paths.
- Fixed the host `ScrollWindow` / `ScrollWindowEx` backing-store approximation
  so it scrolls only the target window's client rectangle instead of the whole
  top-level back-canvas. This removes the WordPad multiline-edit artifact where
  RichEdit copied title/menu chrome into the toolbar/ruler band.
- Extended the same scroll primitive to honor client-relative scroll and clip
  `RECT` pointers, with a direct host regression
  `test/test-gdi-scroll-window-rect.js`. This keeps the behavior reusable for
  controls that provide narrower invalidation/scroll regions.
- Matched WAT `ScrollWindowEx` update invalidation to the same scroll/clip
  intersection and returns `NULLREGION` for empty intersections.
- Added `WM_SIZE` handling for WAT multiline `EDIT` / RichEdit-compatible
  controls so wrapped layouts recalculate from current width/height and clamp a
  stale first-visible line after resize.
- Added `test/test-edit-wrap-resize.js`, a standalone WAT regression that
  creates a narrow wrapped multiline edit, scrolls to the bottom, widens/tallens
  it, and verifies `WM_SIZE` clamps `EM_GETFIRSTVISIBLELINE` to the new maximum.
- Expanded `test/test-wordpad-richedit.js` to 23/23 with a screenshot guard
  that counts duplicated title-bar-blue pixels in the toolbar/ruler band; the
  regenerated `hello-world-edited.png` has zero such pixels.
- Kept advanced ListView behavior postponed: icon/small-icon/list layouts,
  richer image-list composition, sorting, custom draw, label edit, full
  notifications, and high-fidelity header interaction.
- Updated `apps/regedit.md` with the current app-level RegEdit screenshot
  status.

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
  select-all, and `EM_REPLACESEL` for paste/cut replacement. The initial bridge
  was plain text only; the later 2026-08-10 slice routes RichEdit Copy/Cut/Paste
  through the shared WAT clipboard backend and adds registered non-OLE RTF data.
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
  `CF_TEXT` / `CF_OEMTEXT`. The later 2026-08-10 slice extends the same USER
  path with registered non-OLE RTF data for native RichEdit Copy/Cut/Paste;
  embedded-object/OLE clipboard fidelity remains later work.
- Added a plain-text WAT menu edit-command bridge for WordPad/MFC edit command
  ids: Select All (`57642`), Copy (`57634`), Cut (`57635`), Paste (`57637`),
  plus the existing small WAT edit ids. For WordPad's focused native RichEdit
  child it uses `WM_GETTEXT`, `EM_GETSEL`, `EM_SETSEL`, and `EM_REPLACESEL`
  instead of forwarding `WM_COPY` / `WM_CUT` into RichEdit's OLE clipboard
  storage path. Added `test/test-wordpad-menu-edit-clipboard.js`; it proves
  menu Copy/Paste duplicates `menu` to `menumenu`, menu Cut clears selected
  text and menu Paste restores it, and the covered plain-text path does not
  call `CreateILockBytesOnHGlobal` or `StgCreateDocfileOnILockBytes`.
- Added a bounded basic-format layer on top of that WordPad menu bridge:
  Copy/Cut snapshots selected `CHARFORMAT` and supported `PARAFORMAT` fields,
  Paste inserts text first, queries `EM_GETSEL` after `EM_REPLACESEL`, applies
  the copied formatting to the inserted RichEdit range, then restores the
  caret/selection. This deliberately avoids deriving positions from byte
  length, so CRLF and ANSI high-byte text stay aligned with RichEdit's logical
  selection semantics. Added `test/test-wordpad-rich-clipboard-format.js`;
  it covers `café\r\ntwo`, verifies pasted caret position `8..8`, resets
  insertion formatting before paste, and proves pasted character color plus
  paragraph numbering/indent/tab fields are restored. The later 2026-08-10
  slice adds USER-level registered `Rich Text Format` handles; OLE/object
  transfer remains deferred.
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
  RichEdit's caret API calls, captures on/off/on-again screenshots under
  `test/output/wordpad-richedit/`, and verifies an inverted vertical caret
  stroke blinks off and returns without stale backing-store damage.
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
  create the known sentinel-derived huge font height. The per-HWND fallback
  also records the explicit selection range before patching
  `EM_GETCHARFORMAT`, so the font dialog regression reports `yHeight=480` for
  that exact run while a larger mixed-size selection retains the native 32767
  sentinel. `test/test-wordpad-mixed-format-roundtrip.js` extends this bounded
  cache through RTF stream-out: one explicitly sized range gets `\\fs48` and
  surrounding default text is restored to `\\fs20`; reopening reports the
  individual runs as 480/200 twips and clears `CFM_SIZE` for the mixed whole
  selection. Multiple overlapping explicit-size edits are still not a full
  mixed-run format model.
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
  fallback painting hooks. The renderer composites toolbar child surfaces.
  Added `test/test-wordpad-toolbar.js`, which proves WordPad's Standard and
  Formatting toolbar rows are allocated with real child surfaces and place
  RichEdit below them. A later fix made the renderer recurse through
  non-own-surface MFC containers such as `AfxControlBar42`, clip oversized
  child surfaces to the top-level window, and expose visible toolbar buttons
  instead of a blank gray band. The formatting toolbar child surface/client
  width is now bounded to its containing `AfxControlBar42`, preventing a
  1512px-wide child dump/allocation inside WordPad's 394px frame. The toolbar
  now remembers `TB_ADDBITMAP` app bitmap strips, draws `TBBUTTON.iBitmap`
  icons during `WM_PAINT` through a `TransparentBlt`-style
  `RGB(192,192,192)` color key, and the regression asserts colored icon pixels
  instead of placeholder-only squares. The harness can dump
  `ToolbarWindow32` button records/rects, and WordPad's disabled Standard
  toolbar commands are now both state-asserted and visually dimmed with a
  BTNFACE crosshatch. Minimal synthetic `HINST_COMMCTRL` standard/view/history
  toolbar strips are available for common-control toolbar callers. Checked
  toolbar buttons now paint with a sunken edge and shifted glyph from
  `TBSTATE_CHECKED`; true disabled/highlight image-list remapping and broader
  advanced toolbar UI state remain follow-up fidelity.
- Added width-aware packing for large toolbar-hosted combo item rects. This
  mirrors the bounded native-common-control behavior WordPad relies on: the
  toolbar item rect is capped inside the 394px formatting control bar and
  hosted combo HWNDs are resized to those computed rects, so the size combo and
  full trailing formatting button run fit in one row. The toolbar layout
  regression now asserts all formatting button rects stay inside the narrow
  control bar instead of accepting right-edge clipping.
- Extended that `ToolbarWindow32` subset with a 20-byte `TBBUTTON` backing
  store, `TB_GETBUTTON` command IDs, command-ID state lookup/update, mouse
  hit-testing, and synchronous `WM_COMMAND` delivery to the parent. Added a
  successful no-op `LockWindowUpdate` handler for MFC's toolbar UI update
  cycle. `TB_INSERTBUTTONA` now shifts stored `TBBUTTON` records with
  overlap-safe backward copying, preventing MFC toolbar insertion from
  duplicating later records when source and destination ranges overlap. The
  bounded toolbar query surface also covers command rects, bitmap indexes,
  empty button text, rows/button size, image-list handles, style/extended-style,
  padding, and deletion. `test/test-toolbar-insert.js` covers these with
  overlap-safe insertion plus `TB_ADDBITMAP` loading a colored
  `HINST_COMMCTRL` standard small-color strip.
  `test/test-wordpad-toolbar.js` captures
  `test/output/wordpad-richedit/toolbar-command-new.png`, proving the first
  Standard toolbar button opens WordPad's `New` dialog.
- Fixed toolbar-hosted combobox visibility and placement. `GetWindowRect` now
  reports screen coordinates for child HWNDs by using the WAT parent/client
  tree, `COMBOBOX` controls get own child surfaces for composition above
  toolbar surfaces, `ToolbarWindow32` item rectangles honor separator widths,
  and toolbar-hosted combo creation flows later same-origin combo fields after
  earlier combo siblings. `test/test-wordpad-toolbar.js` now asserts the
  WordPad formatting toolbar's font and size comboboxes are visible,
  non-negative, separated, have bounded client widths, and paint white field
  interiors with populated `Times New Roman` / `10` text. The fix lets
  WAT-native `COMBOBOX` children run MFC's existing WH_CBT/HCBT_CREATEWND
  attach path, so CComboBox wrappers hold real HWNDs before startup `CB_*`
  setup messages. Minimal `CB_SETITEMHEIGHT` / `CB_GETITEMHEIGHT` support keeps
  the now-live setup path from failing. Toolbar autosize now also resizes
  hosted combo HWNDs to the capped separator item rects, which keeps the
  compressed font/size fields from overlapping the trailing formatting buttons.
- Added minimal `GetDCEx` support on top of the existing host DC allocator and
  client/whole-window clip helpers. Added
  `test/test-wordpad-toolbar-format-buttons.js`, which passes 10/10 and
  captures `test/output/wordpad-richedit/toolbar-format-buttons.png`, proving
  formatting-toolbar Bold / Italic / Underline mouse clicks route through
  WordPad UI and update native RichEdit charformat state. The final screenshot
  uses the harness pixel-capture path and the test requires the capture log, so
  a stale PNG cannot satisfy the visual assertion.
- Added WAT-backed dynamic popup menu state for `CreatePopupMenu` plus
  `AppendMenuA/W` owner-draw items and `TrackPopupMenu` painting/hit-testing.
  WordPad's formatting-toolbar color button now opens the 17-row temporary
  color popup (`0x800e..0x801e`). Because `TrackPopupMenu` is still async in the
  emulator and WordPad destroys the temporary MFC menu immediately after
  opening it, `menu_try_edit_command` has a narrow fallback for those ids that
  applies the selected Win32 `COLORREF` directly to the WordPad RichEdit child.
  `test/test-wordpad-toolbar-color-menu.js` passes 13/13 and captures
  `toolbar-color-menu-popup.png` plus `toolbar-color-menu-blue.png`, proving
  the toolbar color UI route applies Blue (`COLORREF 0x00ff0000`). The final
  blue screenshot is also log-required and pixel-captured to avoid accepting
  stale output from a prior emulator run.
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
  Save As -> New -> Open restores the saved text from that centered RTF.
  No emulator RichEdit format code change was needed for this
  slice; the native control already handles the covered
  `EM_SETPARAFORMAT`/`EM_GETPARAFORMAT` and `\qc` stream-out path.
- Added a narrow per-window PARAFORMAT2 cache for explicitly set paragraph
  fields on the exported RichEdit test bridge, plus
  `test/test-wordpad-paraformat-fields.js`. The probe directly sets and reads
  back numbering, start/right indents, first-line offset, and the first tab
  stop, then verifies a later alignment set preserves those cached fields.
  Follow-up cache lifecycle work now clears the char/para caches on full text
  replacement (`WM_SETTEXT` / `EM_STREAMIN`), so post-open paragraph readback
  cannot be satisfied by stale bridge state.
- Added `test/test-wordpad-paraformat-roundtrip.js`. Native RichEdit already
  streams the directly-set paragraph fields to RTF as bullet controls plus
  `\fi240`, `\li480`, `\ri360`, and `\tx1440`; after Save As -> New -> Open,
  reopened `EM_GETPARAFORMAT` reports the original numbering, start/right
  indents, first-line offset, and first tab stop.

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

The browser launcher must preload the native `riched20.dll` plus `usp10.dll`
for WordPad. Dynamic discoverability alone is too late for WordPad's document
view initialization. HWND-less browser keyboard events are resolved to the
guest focus owner at the host input boundary, matching the CLI harness and
allowing the native RichEdit child to receive `WM_CHAR`.

The target is app-useful compatibility, not exact implementation parity with
every RichEdit version.

## Goals

- WordPad supports everyday text editing:
  typing, deletion, newlines, navigation, selection, wrapping, scrolling, and
  visible caret/selection behavior.
- WordPad can save and reopen plain text, then simple RTF.
- WordPad can copy/cut/paste selected RichEdit text through CF_TEXT plus
  registered non-OLE RTF data for the bounded same-session formatting path.
- Basic formatting is visible:
  bold, italic, underline, font size, font face, and text color.
- Installer license RichEdit panes render, clip, and scroll reliably.
- The behavior is covered by bounded tests and screenshots so later GDI/USER
  changes do not silently regress it.

## Expanded non-OLE completion program

The 2026-08-12 expansion promotes the following former non-goals into active
work. Each area needs an app-level WordPad probe, state assertions, and a
screenshot where the result is visual.

```text
1. Advanced RTF
   [x] multiple character and paragraph runs survive Open -> Save -> Open
   [x] stylesheet/font/color-table references resolve without flattening
   [x] simple tables preserve cell boundaries and visible row layout
   [x] tabs, indents, spacing, alignment, and wrapping coexist across paragraphs

2. Printing
   [x] Page Setup edits margins and returns stable PAGESETUPDLG state
   [x] Print returns a printer DC plus Win98-compatible PRINTDLG fields
   [x] StartDoc/StartPage/EndPage/EndDoc execute in the expected order
   [x] EM_FORMATRANGE paginates a multi-page document using printer metrics
   [x] Print Preview displays the preview frame and page-view surface
   [x] Print Preview advances between pages

3. Editing and layout stress
   [x] large multi-paragraph documents remain editable and scrollable
   [x] repeated narrow/wide resize recomputes layout without stale pixels
   [x] selection, replacement, and undo work across paragraph line breaks
   [x] find/replace works across multiline native RichEdit documents
   [x] RichEdit 1.0/2.0 class and message differences have bounded probes

4. WordPad UI fidelity
   [x] ruler tab interaction updates native paragraph state
   [x] toolbar checked/disabled state is covered by focused visual regressions
   [x] Paragraph, Tabs, and Date/Time dialogs route commands correctly

5. International text
   [x] Unicode input/readback covers BMP and surrogate-pair characters
   [x] browser IME start/update/commit/cancel preserves finalized UTF-16 text
   [x] bidi paragraphs have stable logical readback and visible ordering
   [x] complex-script shaping is covered by a visible WordPad regression

6. Thread fidelity
   [x] CREATE_SUSPENDED creates a non-runnable worker with suspend count one
   [x] SuspendThread/ResumeThread return previous nested suspend counts
   [x] only the final ResumeThread makes a worker runnable
   [x] invalid/exited handles return 0xFFFFFFFF
   [x] app-level WordPad startup regression covers the real ResumeThread path
```

Still postponed because it is OLE/object work: embedded objects, in-place
activation, structured-storage object persistence, and object clipboard
transfer. TOM/COM, deep accessibility, and drag/drop editing are also outside
this non-OLE completion program unless one of the probes proves they are a
hard dependency.

### 2026-08-12 OLE storage foundation

The first post-non-OLE slice replaces the inert RichEdit clipboard-storage
objects with heap-backed COM implementations. `ILockBytes` supports binary
`ReadAt`/`WriteAt`, resizing, stat, and independent offsets. Root `IStorage`
objects hold a persistent CLSID and case-insensitive named `IStream` children;
streams support binary read/write/seek, sizing, commit/stat, and reference-counted
storage ownership. `StgCreateDocfileOnILockBytes` associates the root storage
with its lock-bytes object, and `StgOpenStorageOnILockBytes` can reopen that
live in-memory root.

`test/test-ole-storage.js` provides direct coverage for object creation,
binary round-trip including compound-file-signature bytes, EOF semantics,
case-insensitive stream lookup, CLSID persistence, and COM lifetime ownership.
This does not yet serialize a Compound File Binary container, expose an
`IDataObject`, insert a `REOBJECT`, or render/activate an OLE server. Those are
the next WordPad layers.

### 2026-08-12 OLE data-transfer foundation

A bounded, single-format `IDataObject` now owns a `FORMATETC` plus copied
`STGMEDIUM`. It supports `QueryGetData`, `GetData`, `SetData`, and one-entry
`IEnumFORMATETC`; advisory connections remain explicitly unsupported.
`TYMED_HGLOBAL` payloads, including opaque `CF_DIB` bytes, are duplicated for
each receiver. `TYMED_ISTREAM`/`TYMED_ISTORAGE` retain COM references, and
`ReleaseStgMedium` now releases supported media and clears the structure.
`OleSetClipboard`, `OleGetClipboard`, `OleFlushClipboard`, and
`OleIsCurrentClipboard` provide bounded reference-counted clipboard ownership.

`test/test-ole-data-object.js` covers format acceptance/rejection, independent
HGLOBAL copies, binary DIB preservation, medium release, OLE clipboard
lifetime, and stream-medium AddRef/Release behavior. The next integration step
is a WordPad-visible static object representation: bridge DIB clipboard data
into a RichEdit object slot, paint it inline, and then persist that object
through RTF/storage save and reopen.

The first native integration probe now publishes a valid 32x24 24-bpp `CF_DIB`
and delivers `WM_PASTE` to Win98 RichEdit. This exposed and then closed dynamic
export crash paths including:
`CoDisconnectObject`, `CreateStreamOnHGlobal` (with HGLOBAL recovery), and
`OleCreateDefaultHandler` and `OleSetContainedObject`. A bounded in-process
static handler now exposes shared `IOleObject`/`IPersistStorage` identity,
client-site/extent state, and storage ownership. RichEdit inserts and paints
the static DIB without exiting WordPad; `WM_GETTEXT` preserves the surrounding text and
represents its inline object position as a space. `test/test-ole-storage.js` covers caller-
owned and COM-created HGLOBAL stream lifetime, `test/test-ole-static-handler.js`
covers handler identity/refcounts/storage ownership, and the browser smoke
covers native CF_DIB insertion plus visible red/blue presentation pixels.

The persistence follow-up is complete for this same static-DIB scope. RichEdit
requires `IOleCache` to retain the streamed RTF presentation, `IViewObject2`
for extent negotiation, and `OleDraw` to paint it; the bounded handler now owns
the copied `STGMEDIUM` and exposes those contracts. `OleUIUpdateLinksA` returns
the successful no-links result for static pictures. The focused
`test/test-wordpad-ole-roundtrip.js` regression pastes a 32x24 checker DIB,
saves/exports the native `\pict\dibitmap0` RTF, imports it into a fresh WordPad,
and verifies both the restored inline-object position and rendered red/blue
pixels (14/14 checks). This does not claim linked objects, executable OLE
servers, in-place activation, drag/drop, or arbitrary compound-file fidelity.

The static-image clipboard follow-up is also complete. WordPad Edit Copy and
Cut preserve the eager `CF_DIB` presentation of a selected inline picture;
Paste reconstructs a new RichEdit object and Cut removes the original with
`WM_CLEAR`. RichEdit's DLL-private clipboard `IDataObject` is deliberately
treated as borrowed: native `WM_COPY` may create it and exercise structured
storage, but the emulator clears that pointer after capturing durable
CF_TEXT/RTF/DIB values. This prevents a later Clear/Cut from leaving the
clipboard pointed at an object whose source control has destroyed it.
`test/test-wordpad-ole-clipboard.js` covers Copy/Paste duplication, Cut/Paste
restoration, object-position counts, and visible red/blue presentation pixels
(11/11 checks).

### 2026-08-12 advanced RTF slice

`test/test-wordpad-advanced-rtf.js` imports a handcrafted Win98-era RTF through
the VFS, opens it through WordPad's real File Open path, saves it under a new
name, reopens it, and verifies range-specific character/paragraph state. The
fixture covers an inherited stylesheet heading, two fonts, two colors, mixed
inline bold, multiple paragraph alignments, a two-cell table with an italic
cell, and a trailing paragraph. Native RichEdit already preserves the direct
run/table model. A bounded VFS read projection expands `\sN` stylesheet
inheritance to equivalent direct controls, including `\plain` at style
boundaries, while leaving stored bytes unchanged. The 17-point acceptance
matrix passes against the saved artifact and screenshot
`test/output/wordpad-richedit/advanced-rtf.png`.

### 2026-08-12 printing slice

WordPad now receives a stable default `Web Printer` through `PrintDlgA`, with
Letter paper, portrait orientation, page range/copy fields, a canvas-backed
printer DC, 300-DPI metrics, and 0.25-inch physical offsets. The interactive
Print form exposes page range and copies; Page Setup exposes four editable
inch margins and commits them to `PAGESETUPDLG`. The accepted forms were
visually verified in `/private/tmp/wordpad-print-dialog.png` and
`/private/tmp/wordpad-page-setup.png`.

The GDI print lifecycle now validates `StartDoc` -> `StartPage` -> `EndPage` ->
`EndDoc`, and `EM_FORMATRANGE` returns a bounded next-character index derived
from the requested twip rectangle instead of leaking the native structure
pointer. Print Preview reaches WordPad's real preview mode: it hides the edit
view and normal bars, creates the preview toolbar, and installs an
`AfxFrameOrView42` page surface. Preview also drove implementation of the DC
state queries `GetBkMode`, `Get/SetPolyFillMode`, and `GetStretchBltMode`.

The printing acceptance matrix is now complete. MFC's abort procedure exposed
a queue-fidelity bug: `PeekMessage(PM_NOREMOVE)` could expose a native-control
paint which `GetMessage` then retired internally and blocked behind. Native
control paints are now retired before both peek variants select an observable
message. The physical route reaches `EndDoc`, destroys its progress dialog,
returns the printer state to idle, and re-enables the WordPad frame.

`test/test-wordpad-printing.js` also opens a 9,673-character fixture and proves
monotonic `EM_FORMATRANGE` page boundaries through EOF. Print Preview's Next
command now renders through legacy Win9x `Escape` printer queries
(`GETPHYSPAGESIZE`, `GETPRINTINGOFFSET`, and `GETSCALINGFACTOR`) without a fatal
stub. The expanded 14-point regression captures the first and next preview
pages and passes without an unimplemented API or crash.

### 2026-08-12 editing/layout stress slice

`test/test-wordpad-layout-stress.js` opens an 80-paragraph, 10,158-character
plain-text document through WordPad's real File Open path. It proves dynamic
full-buffer `WM_GETTEXT` readback beyond the old 8,191-byte test ceiling,
downward wheel scrolling, guest `WM_SIZE` relayout at 320x240 and 640x480,
replacement across a CRLF paragraph boundary, and complete native Undo. The
test writes and visually verifies narrow/wide screenshots under
`test/output/wordpad-richedit/`. The reusable `main-resize` harness action
commits top-level geometry and delivers the same resize messages as an
interactive frame drag.

### 2026-08-12 ruler and secondary UI slice

`test/test-wordpad-ui-advanced.js` drives WordPad's real ruler and three less-used
dialogs in bounded, isolated emulator runs. Dragging on the ruler changes the
focused native RichEdit paragraph from zero tab stops to one 1278-twip stop.
The Paragraph dialog exposes left/right/first-line indentation and alignment;
the Tabs dialog exposes Set, Clear, and Clear All; and Date and Time enumerates
stable short-date, long-date, and time choices. Selecting the time entry and
accepting the dialog inserts `12:00:00 AM` into the document. Locale-format
enumeration, resource-language enumeration, and dialog tab-order traversal now
cover the APIs needed by these MFC surfaces. The 9-point regression writes
`paragraph-dialog.png`, `tabs-dialog.png`, and `date-time-dialog.png` under
`test/output/wordpad-richedit/`.

### 2026-08-12 international text slice

`test/test-wordpad-international.js` inserts Greek, CJK, Hebrew, Arabic,
Devanagari, and a supplementary-plane emoji into WordPad's native
`RichEdit20A`, then reads the buffer through `EM_GETTEXTEX` code page 1200.
The browser composition bridge tracks start/update/end, inserts finalized
UTF-16 code units exactly once, and treats an empty result as cancellation.
The browser continues to own pre-edit and candidate UI: dispatching
`WM_IME_STARTCOMPOSITION` to this Win98 RichEdit without a guest IMM module
corrupts its native text state, so guest-owned underlined pre-edit/candidate
rendering is intentionally outside the bounded bridge. Logical RTL order and
complex-script/RTL rendering are captured in
`test/output/wordpad-richedit/international-text.png`. The nine-point
regression passes, including surrogate-pair, commit-once, and cancellation
assertions.

### 2026-08-12 RichEdit version-compatibility slice

The WAT fallback now distinguishes the Win98 `RICHEDIT` class (Riched32 /
RichEdit 1.0) from `RichEdit20A` and `RichEdit20W` (Riched20 / RichEdit 2.0+)
without changing WordPad's native `RichEdit20A` execution path. Both fallback
generations share the edit-control-compatible selection surface and begin with
the documented 32,767-character input limit. A zero legacy `EM_LIMITTEXT`
selects the 64,000-character RichEdit compatibility limit. The 2.0 fallback
additionally supports full-width `EM_EXGETSEL` / `EM_EXSETSEL` `CHARRANGE`
fields and `EM_EXLIMITTEXT` values above 64K; those extended messages remain
unsupported on the 1.0 fallback.

`test/test-richedit-version-compat.js` passes 11/11 across exact and
case-insensitive class recognition, shared versus version-gated selection
messages, and the 32K/64K/greater-than-64K limit transitions. The real WordPad
editing regression remains green at 23/23. Exhaustive undocumented DLL-version
quirks are not part of the non-OLE compatibility target.

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
[x] bounded wrapping + clip invalidation stays coherent across resize/scroll
    edges for the WAT edit/RichEdit-compatible path
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
[x] basic RTF save/reopen preserves one selected-size run against surrounding
    default-size text and reports the reopened whole selection as mixed
[x] basic RTF save emits selected paragraph center alignment and reopens text
[x] focused PARAFORMAT2 numbering/indents/tabs read back through RichEdit bridge
[x] basic RTF save/reopen preserves paragraph numbering/indents/tabs
[x] installer license RichEdit text streams in and scrolls
```

### 5. Clipboard shortcuts and non-OLE RTF data

Expected message surface:

- renderer shortcut routing for focused native text controls;
- WAT menu edit-command routing for WordPad/MFC edit ids;
- `WM_GETTEXT`, `EM_GETSEL`, `EM_SETSEL`, and `EM_REPLACESEL`;
- registered non-OLE `Rich Text Format` clipboard data;
- static-DIB object clipboard fidelity; arbitrary/activated objects later.

Acceptance:

```text
[x] Ctrl+A selects all focused native RichEdit text
[x] Ctrl+C captures the selected native RichEdit text as plain text
[x] Ctrl+V inserts the captured plain text through `EM_REPLACESEL`
[x] Ctrl+X cuts selected native RichEdit text
[x] menu Edit Select All/Copy/Cut/Paste routes work without the keyboard bridge
[x] menu Copy/Paste preserves basic selected RichEdit char/paragraph formatting
    with CRLF and ANSI high-byte text
[x] menu Copy advertises CF_TEXT plus registered non-OLE RTF clipboard data
[x] keyboard Ctrl+C/Ctrl+X/Ctrl+V preserve basic selected RichEdit
    char/paragraph formatting with CRLF and ANSI high-byte text
[x] keyboard Copy advertises CF_TEXT plus registered non-OLE RTF clipboard data
[x] static CF_DIB embedded-object Copy/Cut/Paste preserves object presentation
[ ] linked/activated and arbitrary non-DIB clipboard objects preserve fidelity
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
[x] mixed-size selections retain RichEdit's mixed sentinel instead of being
    overwritten by the latest explicit selected-size fallback
[x] text color renders through direct focused RichEdit `EM_SETCHARFORMAT`
[x] WordPad standard/format toolbar rows are allocated and layout RichEdit below them
[x] WordPad toolbar app bitmap strips render visible color-keyed icon pixels
[x] ToolbarWindow32 can load minimal `HINST_COMMCTRL` built-in color strips
[x] WordPad disabled Standard-toolbar commands are state-dumped and visibly dimmed
[x] WordPad checked formatting-toolbar buttons are visibly sunken
[x] WordPad toolbar fallback buttons remain visibly composited through nested
    MFC control-bar containers when no strip is available
[x] WordPad formatting toolbar font/size comboboxes are visible, separated, and populated
[x] WordPad first Standard toolbar button opens the New dialog through app UI
[x] WordPad formatting toolbar B/I/U buttons route through app UI
[x] WordPad toolbar/menu color command route applies Blue through app UI
[x] simple RTF round-trips without losing basic character-format effects
[x] simple RTF round-trips one selected run's font size/color
[x] simple RTF round-trips one selected-size run against default-size text
[x] simple RTF stream-out records selected paragraph center alignment
[x] focused paragraph indents/tabs/numbering read back through RichEdit bridge
[x] paragraph indents/tabs/numbering RTF round-trip correctly
```

## Whole-task acceptance matrix

```text
[x] WordPad accepts focus and inserts visible "hello world"
[x] Browser WordPad preloads native RichEdit, stays running, and inserts
    visible "hello world" through focus-routed browser keyboard events
[x] Automated WordPad/RichEdit probe exists
[x] Backspace edits visible text correctly
[x] Delete-forward edits visible text correctly
[x] Enter creates a visible new line
[x] Arrow/Home/End movement tracks insertion position
[x] Visible caret paint is covered
[x] Caret blink/XOR cadence stays coherent
[x] Shift+arrow selection changes replacement range
[x] Visible selection highlight renders coherently
[x] Mouse-drag selection changes selection range
[x] Plain-text Ctrl+A/C/X/V work for native RichEdit focus
[x] Menu Copy/Cut/Paste has explicit coverage
[x] Native RichEdit Undo works through WordPad's Ctrl+Z accelerator
[x] WordPad Edit > Find opens the modeless common dialog
[x] Find Next selects the matching native RichEdit range while the dialog
    retains focus
[x] FINDMSGSTRING registration and modeless notification routing are stable
[x] WordPad Replace / Replace All common-dialog paths are covered
[x] ReplaceTextA resolves dynamically and exposes the modeless Win98 control set
[x] Single Replace advances to the next native RichEdit match
[x] Replace All and Match Case behavior are asserted with mixed-case text
[x] Native RichEdit wheel changes first visible line
[x] Long WordPad RichEdit text paints through clipped ExtTextOut rectangles
[x] Native RichEdit scrollbar thumb drag changes first visible line
[x] Bounded wrapping/clip invalidation stays coherent across resize/scroll
    edges for the WAT edit/RichEdit-compatible path
[x] WordPad saved RTF reopens with simple plain text content
[x] Plain text save/reopen through the text filter works
[x] Basic RTF save/reopen preserves bold/italic/underline styling state
[x] Basic RTF save/reopen preserves selected font size/color state
[x] Basic RTF save/reopen preserves one selected-size run against default text
[x] Basic RTF save emits selected paragraph alignment state and reopens text
[x] Focused RichEdit PARAFORMAT2 fields read back for numbering/indents/tabs
[x] Basic paragraph numbering/indents/tabs round-trip through WordPad RTF
[x] WordPad menu Copy/Paste preserves basic selected RichEdit formatting
    without byte-counting CRLF positions
[x] WordPad menu Copy advertises registered non-OLE RTF clipboard data
[x] WordPad keyboard Copy/Cut/Paste preserves basic selected RichEdit
    formatting and registered non-OLE RTF clipboard data
[x] Static CF_DIB clipboard insertion, rendering, RTF save, and fresh reopen
    preserve the inline object and presentation
[x] Static CF_DIB object Copy/Cut/Paste preserves object count and presentation
[ ] Linked/activated and arbitrary non-DIB OLE objects preserve full fidelity
[x] Bold/italic/underline command state toggles in WordPad
[x] Bold/italic/underline are visibly asserted in WordPad
[x] Font dialog face/style handoff is visibly asserted in WordPad
[x] Font-size layout is visibly asserted in WordPad
[x] RichEdit selected-size reporting returns concrete `yHeight`
[x] Direct RichEdit text color rendering is visibly asserted in WordPad
[x] WordPad standard/format toolbar row layout is asserted
[x] WordPad nested toolbar child surfaces visibly composite and clip to WordPad
[x] WordPad toolbar bitmap icon pixels are explicitly asserted
[x] ToolbarWindow32 `TB_ADDBITMAP` covers `HINST_COMMCTRL` built-in strips
[x] WordPad disabled toolbar icon dimming is explicitly asserted
[x] WordPad checked toolbar button visual state is explicitly asserted
[x] WordPad formatting toolbar combo fields are visibly asserted
[x] WordPad formatting toolbar font/size combo text is populated and asserted
[x] Empty-document font-size toolbar pixels and `WM_GETTEXT` report 10pt
    instead of rendering the native mixed-size sentinel as `1638.5`
[x] WordPad formatting toolbar full button run is visible in the narrow row
[x] ToolbarWindow32 `TB_INSERTBUTTONA` preserves stored TBBUTTON order
[x] ToolbarWindow32 bounded query/style/image-list/padding/delete messages are asserted
[x] WordPad first Standard toolbar command route is explicitly covered
[x] WordPad formatting toolbar B/I/U click route is explicitly covered
[x] WordPad toolbar/menu color route has explicit coverage
[x] Installer/license RichEdit panes render and scroll
[x] WAT TreeView reuses shared vertical scrollbar hit/drag math
[x] WAT TreeView parent/child links and expand/collapse visibility are asserted
[x] WAT TreeView depth-first visible order is asserted
[x] WAT TreeView `TVM_GETITEMA` text buffer copying is asserted
[x] WAT TreeView expand/collapse notifications and `TVIF_CHILDREN` are asserted
[x] Registry root/subkey/value enumeration and metadata are covered for RegEdit-style probes
[x] SysListView32 has bounded report item/header state and reusable scrollbar behavior
[x] SysListView32 report column get/set, item/subitem rects, and subitem hit-test are asserted
[x] SysListView32 selection/click notifications are asserted
[x] SysListView32 pseudo-header query messages are asserted
[x] SysListView32 pseudo-header set/layout/identity-order messages are asserted
[x] SysListView32 row/column deletion is asserted
[x] SysListView32 image-list handles, LVIF_IMAGE/LVIF_PARAM metadata, and bounded report-mode image painting are asserted
[x] SysListView32 report query/invalidation messages are asserted
[x] SysListView32 background/text color messages and paint use are asserted
[ ] Advanced ListView modes/notifications/header fidelity are implemented
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
11. Fix bounded wrapping/clip invalidation resize edges.
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
