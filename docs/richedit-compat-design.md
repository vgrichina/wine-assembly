# RichEdit Compatibility Task Design

Last updated: 2026-08-02.

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
              -> visible edited text appears
```

That means these pieces are already good enough for basic insertion:

- focus can reach the RichEdit child;
- keyboard input routes to the focused child instead of the frame;
- `WM_CHAR` insertion reaches native RichEdit;
- synchronous `WM_GETTEXT` can read the focused native RichEdit buffer through
  the test harness;
- Backspace, Delete-forward, Enter, Left, Home, and End update that native
  buffer/insertion position in the current probe;
- Shift+Left selection is visible through `EM_GETSEL`, and typing replacement
  updates/collapses the selected range;
- plain-text Ctrl+A/C/X/V works for focused native RichEdit controls through the
  renderer-side native-text shortcut bridge;
- mouse drag changes native RichEdit selection state;
- long multiline text inserts, auto-scrolls to the caret, and focused native
  wheel input changes `EM_GETFIRSTVISIBLELINE`;
- `ExtTextOutA/W` supports `ETO_OPAQUE` erase rectangles;
- the observed RichEdit `32767 twips` font-height sentinel no longer moves
  text far offscreen.

This does not mean RichEdit is feature complete. It only proves the first
native-editing path is alive.

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
  passes 10/10 and captures `test/output/wordpad-richedit/mouse-scroll.png`.
- Added minimal USER clipboard APIs for plain ANSI text:
  `OpenClipboard`, `CloseClipboard`, `EmptyClipboard`, `SetClipboardData`,
  `GetClipboardData`, `IsClipboardFormatAvailable`, `CountClipboardFormats`,
  and `GetClipboardOwner`. These share the WAT edit clipboard buffer and cover
  `CF_TEXT` / `CF_OEMTEXT`. A raw native RichEdit Ctrl+C/Ctrl+V probe still
  follows RichEdit's OLE storage setup rather than the verified USER text path,
  so rich/native clipboard fidelity remains later work.
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
[ ] selected text is visibly highlighted in a screenshot
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
[ ] scrollbar drag changes first visible line
[ ] text stays clipped to the RichEdit client rect
```

### 4. Text I/O

Expected message surface:

- `WM_GETTEXT`, `WM_SETTEXT`, `WM_GETTEXTLENGTH`;
- `EM_GETTEXTEX`, `EM_SETTEXTEX`, `EM_GETTEXTRANGE`;
- `EM_STREAMIN`, `EM_STREAMOUT`;
- selection range queries and CR/LF normalization.

Acceptance:

```text
[ ] plain text save/reopen works in WordPad
[ ] basic RTF save/reopen preserves simple formatting
[ ] installer license RichEdit text streams in and scrolls
```

### 5. Plain-text clipboard shortcuts

Expected message surface:

- renderer shortcut routing for focused native text controls;
- `WM_GETTEXT`, `EM_GETSEL`, `EM_SETSEL`, and `EM_REPLACESEL`;
- later: real USER clipboard and RichEdit/OLE clipboard fidelity.

Acceptance:

```text
[x] Ctrl+A selects all focused native RichEdit text
[x] Ctrl+C captures the selected native RichEdit text as plain text
[x] Ctrl+V inserts the captured plain text through `EM_REPLACESEL`
[x] Ctrl+X cuts selected native RichEdit text
[ ] menu Edit/Copy/Paste routes work without the keyboard bridge
[ ] rich clipboard formats preserve RTF/objects
```

### 6. Basic formatting

Expected message surface:

- `EM_SETCHARFORMAT` / `EM_GETCHARFORMAT`;
- `EM_SETPARAFORMAT` / `EM_GETPARAFORMAT`;
- basic font, size, bold, italic, underline, color, and alignment fields.

Acceptance:

```text
[ ] bold / italic / underline are visible
[ ] font size changes affect layout predictably
[ ] text color renders
[ ] simple RTF round-trips without losing basic formatting
```

## Whole-task acceptance matrix

```text
[x] WordPad accepts focus and inserts visible "hello world"
[x] Automated WordPad/RichEdit probe exists
[x] Backspace edits visible text correctly
[x] Delete-forward edits visible text correctly
[x] Enter creates a visible new line
[x] Arrow/Home/End movement tracks insertion position
[ ] Visible caret paint and blink stay coherent
[x] Shift+arrow selection changes replacement range
[ ] Visible selection highlight renders coherently
[x] Mouse-drag selection changes selection range
[x] Plain-text Ctrl+A/C/X/V work for native RichEdit focus
[ ] Menu Copy/Cut/Paste has explicit coverage
[x] Native RichEdit wheel changes first visible line
[ ] Line wrapping and scrollbar scrolling stay coherent
[ ] Plain text save/reopen works
[ ] Basic RTF save/reopen works without data loss for simple styling
[ ] Bold/italic/underline/font-size/color are visible in WordPad
[ ] Installer/license RichEdit panes render and scroll
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
7. Fix wrapping, scrollbar drag, and clip invalidation.
8. Add plain text stream in/out.
9. Add basic RTF stream in/out.
10. Add basic character and paragraph formatting.
11. Re-run WordPad, Notepad, and installer RichEdit probes.
12. Update app status docs with screenshots and pass/fail state.
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
