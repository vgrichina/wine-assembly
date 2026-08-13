# WordPad (Win98) — FUNCTIONAL (static OLE images)

**Binary:** `test/binaries/win98-apps/wordpad.exe`  
**Status (2026-08-12):** FUNCTIONAL for the bounded non-OLE scope plus static
`CF_DIB` image paste, Copy/Cut/Paste, rendering, and RTF save. Fresh-process
reopen is implemented and has passed, but needs current-tip bounded
revalidation after the recent GDI/DIB changes (see **Remaining Work**).

Advanced RTF runs/paragraphs/tables, physical printing, Page Setup, multi-page
pagination, Print Preview navigation, large-document resize/edit stress,
advanced ruler/dialog commands, international UTF-16/IME commit input, and
representative complex-script behavior now have focused app-level regressions.
Suspended-thread behavior has scheduler coverage and a bounded app-level trace
now proves WordPad's real startup uses that path.
Bounded RichEdit 1.0/2.0 class, selection-message, and text-limit differences
are covered as well. The reusable OLE persistence foundation provides binary
`ILockBytes`, named `IStorage`/`IStream` children, and storage class identity.
`IStream::Clone` now shares backing bytes and size while retaining an
independent seek cursor; the clone keeps its root alive after the original
interface and owning storage are released. Truncation followed by growth
zero-fills newly exposed bytes. Nested `IStorage::CreateStorage`/`OpenStorage`
now maintain arbitrary-depth child trees with case-insensitive names and
retained-child lifetime. Rename/delete now preserve retained interfaces and
enforce the shared stream/storage namespace. Deep `CopyTo` and
identity-preserving `MoveElementTo` are now covered too. `EnumElements` returns a real snapshot
`IEnumSTATSTG` with stable names/types/sizes/CLSIDs and complete cursor methods;
deep transactional `Commit`/`Revert` checkpoints now restore mixed trees while
detaching retained pre-revert interfaces safely.
`IStream` now also has shared commit/revert checkpoints, owner-scoped region
locks across clones, lock-aware sizing, and buffered `CopyTo` with exact
partial-count and self-copy behavior.
`STATSTG` records now consistently expose owned names, object types, 64-bit
sizes, stream lock capabilities, storage CLSIDs/state bits, and
`STATFLAG_NONAME`; snapshots, deep copies, and transaction checkpoints preserve
that metadata. The focused storage/stream suite passes 68/68.
Compound-file persistence now writes and defensively reopens real CFB v3 containers,
including FAT, mini-FAT/mini-stream, nested directory trees, CLSIDs/state bits,
and small/large stream payloads. `IStorage::Commit` emits the associated
`ILockBytes`, and fresh-backed `StgOpenStorageOnILockBytes` reconstructs the
tree. The deterministic/malformed-container suite passes 22/22.
Static DIB presentations now also survive WordPad's RTF Save As and reopen path.

The next transfer layer is also present: a bounded multi-format `IDataObject`
supports `FORMATETC` matching, `GetData`/`QueryGetData`/`SetData`, stable
snapshot enumeration with complete cursor/clone methods, and eagerly owned
`STGMEDIUM` payloads. `TYMED_HGLOBAL` data such
as `CF_DIB` is copied byte-for-byte, stream/storage media retain COM ownership,
`ReleaseStgMedium` releases supported payloads, and the OLE clipboard keeps a
reference-counted current object. WordPad/RichEdit insertion and static DIB
presentation are integrated. WordPad can copy, cut, and paste an existing
inline static DIB without retaining a source-control-owned RichEdit object.
`GetDataHere` now fills caller-owned HGLOBAL, IStream, and IStorage media; it
rejects undersized globals without partial writes, preserves caller interface
ownership, and stages storage replacement atomically. The focused data-object
suite also covers exact `FORMATETC` negotiation: format/aspect/lindex/target-
device/tymed matching returns the corresponding `DV_E_*` error and keeps
distinct presentations separate. With that coverage the focused suite passes
45/45. HGLOBAL text now produces coexisting ANSI, OEM, and UTF-16 values with
canonical CRLF and exact terminating NULs, while registered RTF remains opaque
and independent. The replacement is failure-atomic. `OleFlushClipboard` now
detaches the clipboard from its former owner with deep HGLOBAL, IStream, and
recursive IStorage snapshots plus stable format enumeration. The focused suite
passes 55/55. Runtime-owned custom medium releasers now follow Windows
`ReleaseStgMedium` rules: delegated HGLOBAL payloads are not freed directly,
while stream/storage media release their interface and a distinct
`pUnkForRelease`. DLL-private releasers still require a suspended guest-callback
bridge; advisory connections remain deferred until a traced consumer needs
them.

RichEdit's first static-image clipboard route is now crash-safe. OLE32 exposes
`CoDisconnectObject`, HGLOBAL-backed `IStream` helpers,
`OleSetContainedObject`, and bounded static `IOleObject`/`IPersistStorage`
identity plus `IOleCache` and `IViewObject2` presentation contracts. A native
`CF_DIB` paste inserts and paints an inline static bitmap without terminating
WordPad; `WM_GETTEXT` preserves the surrounding document and exposes that
position as a space. `test/test-wordpad-ole-roundtrip.js` saves the object to
RTF, starts a fresh WordPad, reopens it, and asserts the restored object slot
and visible red/blue checker pixels. It has passed 17/17, but current-tip
revalidation is pending after the recent GDI/DIB changes: saving again emits
two complete presentations (5,097 bytes), while the slower fresh-process child
reaches its bounded timeout before the final state/screenshot actions. The
single-process object clipboard probe remains green at 13/13. Linked/activated
objects and non-DIB OLE servers remain outside this bounded static-image slice.

The generic persistence foundation now gives the same embedded handler a real
`IPersistStorage` state machine. It rejects repeated initialization, enforces
no-scribble and hands-off transitions, adopts replacement storage only through
`SaveCompleted`, and performs atomic full-tree Save As copies. Unknown streams,
nested storages, CLSID, and state bits survive without server-specific parsing.
The embedded cache now owns multiple exact format/aspect presentations with
stable connection IDs, independent copy/transfer semantics, targeted
replacement/removal, and deterministic CF_DIB render selection. The expanded
static-handler suite passes 42/42 and native inline-object Copy/Cut/Paste stays
green at 13/13. Cache enumeration now returns stable `IEnumSTATDATA` snapshots
with complete format, ADVF, sink, and connection fields plus deep target-device
ownership and independent clone cursors. Runtime-owned objects also convert
the entire cache to a detached `IDataObject` and atomically rebuild it through
`InitFromData`; DLL-private data objects still await the guest callback bridge.

## Remaining Work

The everyday non-OLE WordPad target is complete. Remaining work is narrower.
The ordered implementation program that can proceed independently of the
software-GDI rewrite is in the
[non-GDI work plan](../docs/non-gdi-work-plan.md); visual revalidation is kept
as a separate GDI rejoin gate there.

1. **Current-tip static-image revalidation.** Make the fresh-process half of
   `test/test-wordpad-ole-roundtrip.js` finish within a bounded emulator
   timeout, then reconfirm both reopened `U+FFFC` slots and independent
   red/blue presentation pixels. Also rerun delete/save/reopen after the
   GDI/DIB work settles. Do not weaken these to unbounded tests.
2. **General OLE objects.** Add linked and activated server objects, non-DIB
   presentation formats, general object clipboard interoperability, arbitrary
   compound-storage serialization/reopen, object verbs, in-place activation,
   and drag/drop. Static DIB presentations are the intentional current limit.
3. **High-fidelity RichEdit/RTF breadth.** Expand beyond the bounded fixtures
   to arbitrary nested styles/tables, overlapping edits, fields, picture/object
   combinations, exact printer layout, and undocumented RichEdit DLL quirks.
4. **UI polish.** Implement true disabled/hot toolbar image-list remapping and
   broader uncommon toolbar/menu/ruler state. Current fallback dimming and
   focused command coverage are functional, not exact common-controls parity.
5. **International breadth.** Add more scripts, font-fallback combinations,
   composition UI, bidi editing, and complex-cluster editing. Current tests
   cover representative input, readback, and visible shaping.
6. **Shared-code regressions.** After USER/GDI/RichEdit changes, rerun WordPad,
   Notepad, and installer license panes with visual clipping, caret, selection,
   scrolling, and toolbar assertions.

Focused inline-image clipboard probe:

```text
paste a 32x24 checker DIB, select its one-character RichEdit object slot,
then use WordPad Edit Copy/Paste followed by Edit Cut/Paste
copy:       publishes only the eager CF_DIB value, avoiding RichEdit's
            one-space ANSI/RTF projection, and duplicates a real object
cut:        WM_CLEAR removes only the selected object without corrupting the
            source RichEdit control
ownership:  DLL-private RichEdit IDataObjects are borrowed only while native
            WM_COPY runs; the durable clipboard owns text/RTF/DIB snapshots
identity:   UTF-16 RichEdit text reports U+FFFC for both object positions;
            a genuine selected space clears CF_DIB and pastes as text
pixels:     final screenshot contains two sets of red/blue checker cells
result:     PASS (13/13 object clipboard, 5/5 space discrimination)
```

The browser-style keyboard path has matching coverage. Ctrl+C/Ctrl+V
duplicates the selected inline image, Ctrl+X removes it, and WordPad's real
Ctrl+Z accelerator restores the cut object and its red/blue presentation
pixels (`test/test-wordpad-ole-keyboard-undo.js`, 10/10 checks).

WordPad opens and renders in both the CLI and browser-focused smokes:

```text
WordPad ... PASS  134 APIs, window created, 392 colors
browser: WordPad remains running with preloaded riched20.dll/usp10.dll,
         native RichEdit accepts "hello world", screenshot written
```

The browser launcher now preloads `riched20.dll` and `usp10.dll` before
WordPad startup, matching the working CLI load order. Previously the browser
advertised neither dynamically requested DLL: WordPad created its frame and
toolbar children, failed to initialize the native editor, and exited on the
third run slice. Browser keyboard events without an explicit HWND now route to
the guest focus owner, so the native `RichEdit20A` child receives `WM_CHAR`
instead of the WordPad frame. The bounded `test/test-wordpad-web.js` regression
proves the app stays alive, types `hello world`, and writes
`test/output/wordpad-web/hello-world.png`.

WordPad's menu bar now retains the Win98 `DEFAULT_GUI_FONT` (`W95FA`) instead
of changing to a wide monospace fallback during MFC startup. The GDI layer no
longer destroys process-owned stock objects when an app calls `DeleteObject`
on a temporary/stock font. The browser regression checks the selected stock
font handle and CSS family as well as capturing the corrected menu rendering.

Focused menu-font probe:

```text
startup: MFC calls DeleteObject while replacing temporary/stock fonts
GDI:     DEFAULT_GUI_FONT handle 0x30021 remains alive and selectable
menu:    bar paint selects W95FA; the second item begins at x=36 instead of
         the x=55 width produced by the 13px monospace fallback
result:  PASS for proportional Win98 menu text plus matching paint/hit-test
         geometry in the browser WordPad smoke.
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
OLE path:   native WM_COPY may exercise RichEdit structured storage, but its
            source-control-owned IDataObject is discarded after durable
            CF_TEXT/RTF snapshots are captured
result:     PASS for Edit-menu Select All / Copy / Cut / Paste plain-text
            behavior on WordPad's focused native RichEdit child. The current
            screenshot guard also confirms multiline editing no longer copies
            title/menu chrome into the toolbar/ruler band.
```

Focused Undo / Find probe:

```text
type "alpha beta", press Ctrl+Z, verify the native RichEdit buffer is empty,
retype the text, return to the document start, invoke WordPad's real MFC
Edit > Find command (57636), enter "beta", and activate Find Next
undo:       WordPad's accelerator reaches native RichEdit Undo
dialog:     the modeless common Find dialog retains its RichEdit owner even
            after MFC clears its temporary FINDREPLACE wrapper fields
message:    repeated RegisterWindowMessageA("commdlg_FindReplace") calls use
            one stable process-local message ID
selection:  Find Next selects the native RichEdit range 6..10 without moving
            focus away from the dialog
result:     PASS for WordPad Undo plus forward Find/Find Next, including the
            app command, common-dialog notification, and native selection
            paths.
```

Focused Replace / Replace All probe:

```text
type "alpha ALPHA alpha", return to the document start, invoke WordPad's real
MFC Edit > Replace command (57641), enter find="alpha" / replace="X"
export:      WordPad's dynamic GetProcAddress("ReplaceTextA") resolves through
             the normal COMDLG32-compatible API thunk instead of showing the
             missing-export MessageBox
dialog:      modeless Replace displays Find what / Replace with edits plus
             Find Next, Replace, Replace All, Match case, and Cancel controls
single:      Find Next selects 0..5; Replace produces "X ALPHA alpha" and
             advances the selection to the next case-insensitive match
match case:  after enabling Match case, Replace All produces "X ALPHA X",
             leaving the uppercase middle occurrence untouched
flags:       FINDREPLACE notifications report FR_REPLACE / FR_REPLACEALL,
             FR_MATCHCASE, and both text buffers
result:      PASS for WordPad ReplaceTextA resolution, single Replace,
             Replace All, Match Case, native RichEdit replacement, and the
             modeless common-dialog notification path.
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
           Ctrl+C/Ctrl+X/Ctrl+V paths. Static CF_DIB object Copy/Cut/Paste is
           covered separately above; linked/activated and arbitrary object
           transfer remains deferred. Advanced document RTF tables are
           covered separately below.
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
window geometry, capture on/off/on-again screenshots around the blink interval
caret:  native RichEdit creates a USER caret and sets it to x=48, y=3 after
        typing "caret"
pixels: the on frames have a dark 13px inverted vertical caret stroke at the
        expected RichEdit client coordinate; the off frame clears it
result: PASS for visible native RichEdit caret paint, blink cadence, and
        repaint-based inverted/XOR-style erasure.
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
           draw real colored button icons instead of placeholder-only squares.
           App bitmap-strip tiles use the classic `RGB(192,192,192)`
           toolbar color key instead of raw `SRCCOPY`, so strip background
           pixels do not overwrite the destination button face.
           `TB_GETBUTTON`/`TB_GETITEMRECT` dumps now expose disabled Standard
           toolbar commands, and disabled app-strip icons are visibly dimmed
           with a BTNFACE crosshatch until true disabled strips are mapped.
           The formatting toolbar surface/client width is bounded to the
           containing control bar instead of dumping/allocation as a 1512px
           child in a 394px frame. Toolbar-hosted font/size combobox fields
           now paint white interiors and show `Times New Roman` / `10`.
           Large toolbar-hosted combo item rects are width-capped for the
           narrow WordPad control bar, and hosted combo HWNDs are resized to
           those rects, so the full trailing formatting button run is visible
           instead of clipped off the right edge.
result:    PASS for ToolbarWindow32 layout, bounded formatting toolbar width,
           visible bitmap icons, populated combobox field paint, fully visible
           formatting buttons, disabled Standard toolbar icon dimming,
           command-ID-backed button hit testing, and the MFC toolbar command
           path for File New. Minimal `HINST_COMMCTRL` built-in toolbar strips
           are synthesized for other common-control toolbar callers; true
           disabled/highlight image-list remapping and advanced toolbar UI
           state remain follow-up fidelity.
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
visuals:     checked formatting-toolbar buttons paint with a sunken edge and
             shifted glyph from their stored `TBSTATE_CHECKED` state
result:      PASS for formatting-toolbar B/I/U mouse commands and checked
             toolbar button visual state. The color picker/menu route has
             separate focused coverage below.
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

Focused mixed-size selection probe:

```text
type "small large", select only "small", apply 24pt, then query
EM_GETCHARFORMAT; select the whole document and query again
uniform:     the explicitly formatted first-word selection reports yHeight=480
mixed:       the whole selection preserves RichEdit's yHeight=32767 mixed-size
             sentinel instead of being overwritten by the latest-size cache
result:      PASS for range-aware selected-size reporting. The compatibility
             cache records the explicit CFM_SIZE selection range, so toolbar
             size state no longer falsely claims a mixed selection is uniform.
scope:       this remains a bounded latest-run cache, not arbitrary per-run
             formatting storage or advanced RTF layout.
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
             paragraph-state probe. Indents, tabs, numbering, and representative
             multi-paragraph RTF now have separate focused coverage; arbitrary
             paragraph-format breadth remains follow-up work.
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
scope:       This is the basic paragraph-field path. Representative multiple
             runs and simple tables now have separate advanced-RTF coverage;
             arbitrary nested RTF and general embedded objects remain open.
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

Current evidence from the 2026-08-11 follow-up probe:

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
  frame. Toolbar `TB_ADDBITMAP` app strips now render through a
  `TransparentBlt`-style `RGB(192,192,192)` color-key path from
  `TBBUTTON.iBitmap`; minimal synthetic `HINST_COMMCTRL` standard/view/history
  strips are also available for common-control toolbar callers. Checked
  toolbar buttons now render sunken/offset from `TBSTATE_CHECKED`; true
  disabled/highlight image-list remapping and broader advanced toolbar UI state
  remain follow-up fidelity.
- The formatting toolbar now caps oversized toolbar-hosted combo item rects
  against the containing 394px control bar and resizes hosted combo HWNDs to
  their computed item rects. This keeps the size combo plus Bold / Italic /
  Underline / Color / alignment / list buttons on the row instead of clipping
  the trailing controls.
- `ToolbarWindow32` now stores the caller's `TBBUTTON` records, returns real
  `idCommand` values from `TB_GETBUTTON`, maps command IDs for state probes,
  and hit-tests mouse clicks. It also answers bounded toolbar query/setup
  messages for command rects, bitmap indexes, row/button sizes, image-list
  handles, style/extended-style, padding, and empty button text. `TB_INSERTBUTTONA`
  now shifts stored `TBBUTTON` records with overlap-safe backward copying, so
  MFC insertion cannot duplicate/corrupt later toolbar records. Clicking the
  first Standard toolbar button now opens WordPad's `New` dialog through the
  app's MFC command route. The `LockWindowUpdate` compatibility handler is a
  successful no-op so MFC's toolbar UI update cycle no longer traps.
- Formatting toolbar Bold / Italic / Underline mouse clicks now route through
  the same command path and update native RichEdit character-format state. The
  `GetDCEx` compatibility handler now allocates a client or whole-window DC
  with the existing DC allocator/clip helpers, which unblocks MFC toolbar paint
  and update paths reached by these clicks.
- Toolbar-hosted dropdown comboboxes now paint their field backgrounds from
  the combobox proc, so the WordPad font/size fields no longer show gray blank
  interiors. WAT-native `COMBOBOX` children now also run MFC's existing
  WH_CBT/HCBT_CREATEWND attach path, so the CComboBox wrappers get real HWNDs
  before startup `CB_*` setup messages. WordPad's font/size fields now populate
  as `Times New Roman` and `10`. Minimal `CB_SETITEMHEIGHT` /
  `CB_GETITEMHEIGHT` handling keeps that setup path from failing once messages
  reach the real controls.
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
  The original placeholders have since become functional memory-backed
  `ILockBytes`/`IStorage` objects with named `IStream` children. Static DIB
  transfer/rendering is now implemented; compound-file byte serialization and
  general linked/activated objects remain later layers.
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
  sentinels to `\up0` / `\fs48` from the latest explicit size hint. Immediate
  mixed-selection readback is now range-aware. The stream-out compatibility
  rewrite also preserves one explicitly sized selection against surrounding
  default-size text (`\\fs48 ... \\fs20`), with focused Save As -> New -> Open
  coverage. Multiple overlapping format edits and advanced RTF remain
  follow-up work.
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
  explicit-size value is cached per HWND and patched into
  `EM_GETCHARFORMAT` only when the queried selection exactly matches the
  formatted range. A mixed-size selection keeps RichEdit's sentinel instead
  of being misreported as uniformly 24pt.
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
- WordPad's empty-document size query and toolbar handoff now resolve to the 10pt default
  instead of exposing the native mixed-size sentinel as a literal `1638.5`
  point value. Both the browser renderer and combo `WM_GETTEXT` state report
  `10`; actual selected sizes and non-empty mixed selections remain untouched.
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
  the current native-edit path.
- The fallback class router now distinguishes Win98 `RICHEDIT` (Riched32 /
  RichEdit 1.0) from `RichEdit20A` and `RichEdit20W` (Riched20 / RichEdit
  2.0+). Both retain the common edit-message surface and 32,767-character
  initial input limit; zero `EM_LIMITTEXT` selects 64,000. Only the 2.0 class
  accepts `EM_EXGETSEL`, `EM_EXSETSEL`, and `EM_EXLIMITTEXT`, including limits
  above 64K. This is deliberately a bounded app-compatibility contract rather
  than emulation of every undocumented DLL-version quirk.
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
- Direct WAT regression test:
  `node test/test-richedit-version-compat.js` passes 11/11 for case-insensitive
  `RICHEDIT` / `RichEdit20A/W` identification, shared 1.0 selection messages,
  2.0 full-width `CHARRANGE` messages, version-gated unsupported messages, and
  the 32K/64K/greater-than-64K text-limit transitions.
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
- Direct WAT regression test: `node test/test-ole-data-object.js` passes 55/55;
  it covers owned multi-format media, stable cloned enumeration, `SetData`
  transfer semantics, independent `GetData`, and caller-owned `GetDataHere`
  transfers for HGLOBAL, IStream, and recursively copied IStorage trees. It
  also verifies exact format/aspect/lindex/target-device/tymed negotiation and
  concrete-medium enumeration, plus ANSI/OEM/Unicode/RTF coexistence and exact
  CRLF/NUL text conventions. `OleFlushClipboard` coverage proves deep HGLOBAL,
  IStream, and recursive IStorage independence from later owner mutations. It
  also covers `pUnkForRelease` transfer and dual stream/storage-plus-releaser
  release behavior.
- Regression test: `node test/test-wordpad-selection-highlight.js` passes 8/8
  and writes `test/output/wordpad-richedit/selection-highlight-plain.png` plus
  `test/output/wordpad-richedit/selection-highlight.png`; it verifies Ctrl+A
  selects the native RichEdit text and the screenshot gains a visible blue
  selection band.
- Regression test: `node test/test-wordpad-caret.js` passes 13/13 and writes
  `test/output/wordpad-richedit/caret-on.png`,
  `test/output/wordpad-richedit/caret-off.png`, and
  `test/output/wordpad-richedit/caret-on-again.png`; it verifies native
  RichEdit USER caret API calls are tracked, composited as a visible inverted
  vertical caret stroke, blink off cleanly, then return without stale
  backing-store damage.
- Regression test: `node test/test-wordpad-toolbar.js` passes 23/23 and writes
  `test/output/wordpad-richedit/toolbar-layout.png` plus
  `test/output/wordpad-richedit/toolbar-command-new.png`, covering allocation,
  layout, color-keyed bitmap-strip icon painting of the standard/formatting
  toolbar rows, disabled Standard toolbar state/dimming, populated font/size
  toolbar combo text, bounded formatting-toolbar item rects, and the first
  Standard toolbar button opening WordPad's `New` dialog. The pixel assertions
  measure only the toolbar button rows, including colored icon pixels, reduced
  disabled-button color pixels, and the full visible formatting button run so
  placeholder-only, enabled-looking disabled icons, or clipped buttons regress.
- Direct WAT regression test: `node test/test-toolbar-insert.js` passes 39/39;
  it creates a standalone `ToolbarWindow32`, adds three known `TBBUTTON`
  records, inserts one in the middle, and verifies `TB_GETBUTTON` preserves
  command/image order plus monotonic `TB_GETITEMRECT` geometry. It also covers
  `TB_ADDBITMAP` loading `HINST_COMMCTRL` standard small-color strips, command
  rect/bitmap/text queries, image-list/style/padding round-trips, and
  `TB_DELETEBUTTON`.
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
- Regression test: `node test/test-wordpad-mixed-charformat.js` passes 7/7;
  it applies 24pt to only the first word, verifies that exact selection reports
  480 twips, then verifies a whole-document mixed-size selection retains the
  native 32767 sentinel instead of being patched to a false uniform size.
- Regression test: `node test/test-wordpad-mixed-format-roundtrip.js` passes
  9/9; it saves `small` at 24pt beside default-size `large`, reopens the RTF,
  verifies the individual runs report 480/200 twips, verifies the whole
  selection clears `CFM_SIZE` as mixed, and inspects the saved stream for
  `\\fs48 ... \\fs20` without the native size sentinel.
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

The older blocker was `ResumeThread` during OLE/COM initialization. As of
2026-08-12, `CreateThread(CREATE_SUSPENDED)` atomically records the creation
flags and initial suspend count, the cooperative scheduler excludes suspended
workers, and `SuspendThread` / `ResumeThread` return the previous nested count.
Only the transition to zero makes the worker runnable.

`test/test-wordpad-thread-startup.js` provides the focused app-level proof. Its
structured lifecycle trace records WordPad's real sequence as suspended create,
`ResumeThread(previous=1, current=0)`, worker instantiation, and first worker
slice at the original entry point. The bounded regression passes 8/8 without a
pixel assertion.

## Follow-Up

The authoritative current list is in **Remaining Work** near the top. In
short, the bounded non-OLE program and static `CF_DIB` implementation are
present; current-tip fresh-process image revalidation and general OLE server
fidelity remain open.

1. Remaining OLE work is centered on linked/activated server objects,
   non-DIB presentation formats, arbitrary compound-storage persistence,
   general object clipboard interoperability, drag/drop, and in-place activation.
   Covered areas now include mixed-run size reporting, caret blink/XOR cadence,
   Font dialog
   face/style/point-size handoff, concrete latest-size `EM_GETCHARFORMAT`
   reporting, visible 24pt rendering, simple RTF face/style/size/color
   round-trip, one selected-size run against default-size text across RTF
   Save As -> New -> Open, simple paragraph center-alignment round-trip, Edit-menu
   Select All/Copy/Cut/Paste plain-text commands, menu Copy/Paste basic
   RichEdit character/paragraph-format preservation, keyboard rich-format
   clipboard shortcuts, registered non-OLE RTF clipboard data, paragraph
   indents/tabs/numbering, visible selection highlight, visible caret paint,
   toolbar row layout, first-toolbar-button command routing,
   toolbar bitmap icon rendering, formatting-toolbar B/I/U mouse commands,
   checked toolbar button visual state, visible formatting-toolbar color-button
   packing, direct RichEdit color rendering, and clipped long-text RichEdit
   painting, native Undo, forward Find/Find Next, Replace, and Replace All are
   now covered, and
   WordPad's own toolbar color UI now applies
   Blue through the covered dynamic-popup path.
2. Add richer native RichEdit state dumps if deeper assertions are needed
   (caret/selection/scroll). Current coverage reads plain text through
   `WM_GETTEXT`.
3. Keep the static-image boundary explicit: representative advanced RTF
   (including document tables), printing, layout stress, ruler/secondary UI,
   and international text have focused coverage. Static DIB save/reopen is
   implemented but needs the current-tip bounded revalidation described above;
   arbitrary OLE servers remain postponed.

Advanced RTF status (2026-08-12): WordPad now has focused Open -> Save -> Open
coverage for inherited stylesheets, multiple font/color/format runs, centered
and left paragraphs, and a visible two-cell table. The VFS presents native
RichEdit with inherited style properties as equivalent direct RTF controls;
saved files retain the table/font/color/paragraph structure. See
`test/test-wordpad-advanced-rtf.js` and
`test/output/wordpad-richedit/advanced-rtf.png`.

Printing status (2026-08-12): concrete Print and Page Setup dialogs expose page
range, copies, Letter paper, and editable margins. The default printer DC
reports 300-DPI Letter metrics and completes `StartDoc` through `EndDoc` while
cleaning up its progress dialog. Multi-page `EM_FORMATRANGE` pagination and
Print Preview first/next navigation have passing app-level coverage.

Ruler/UI status (2026-08-12): ruler dragging now has an app-level assertion
that adds a 1278-twip native RichEdit tab stop. Paragraph, Tabs, and Date/Time
dialogs open through WordPad commands, expose their expected control sets, and
render screenshots. Date/Time enumerates `1/1/01`,
`Monday, January 1, 2001`, and `12:00:00 AM`; choosing the time entry inserts
it into the document. See `test/test-wordpad-ui-advanced.js` and the UI images
under `test/output/wordpad-richedit/`.

RichEdit implementation scope is tracked in
[`docs/richedit-compat-design.md`](../docs/richedit-compat-design.md).

International-text status (2026-08-12): WordPad accepts and reads back Greek,
CJK, Hebrew, Arabic, Devanagari, and supplementary-plane emoji through native
`RichEdit20A` and UTF-16 `EM_GETTEXTEX`. Browser IME composition preserves
start/update/commit/cancel semantics at the input boundary: only the finalized
UTF-16 result is inserted, exactly once, while an empty result cancels without
changing the document. The browser owns candidate/pre-edit presentation rather
than sending the unsafe native `WM_IME_STARTCOMPOSITION` sequence without a
guest IMM module. See `test/test-wordpad-international.js` and
`test/output/wordpad-richedit/international-text.png`.

**Key files:** `lib/thread-manager.js`, `lib/renderer-input.js`,
`lib/renderer.js`, `lib/host-imports.js`, `lib/filesystem.js`,
`src/09a-handlers.wat`, `src/09a5-handlers-window.wat`,
`src/09c3-controls.wat`
