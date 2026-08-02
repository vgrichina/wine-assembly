# RichEdit Compatibility Task Design

Last updated: 2026-08-01.

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
| bounded WordPad/RichEdit probe |            | images / tables / OLE        |
| delete / enter / movement      |            | advanced RTF layout          |
| visible selection              |            | IME / bidi / complex shaping |
| scroll / wrap sanity           |            | print pagination             |
| plain text stream I/O          |            | TOM/COM / accessibility / D&D|
| basic RTF + basic formatting   |            | exact version quirks         |
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
- `ExtTextOutA/W` supports `ETO_OPAQUE` erase rectangles;
- the observed RichEdit `32767 twips` font-height sentinel no longer moves
  text far offscreen.

This does not mean RichEdit is feature complete. It only proves the first
native-editing path is alive.

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
[ ] Backspace removes the previous character
[ ] Delete removes the next character
[ ] Enter creates a visible new line
[ ] Left/Right/Home/End move the caret without corrupting text
[ ] typing over selection replaces the selected range
```

### 2. Visible selection

Expected touchpoints:

- edit selection state exports used by the test runner;
- text rendering paths in `src/09a-handlers.wat` and `lib/host-imports.js`;
- invalidation and repaint behavior for selection changes.

Acceptance:

```text
[ ] Shift+arrow produces a non-empty selection
[ ] mouse drag produces a non-empty selection
[ ] selected text is visibly highlighted in a screenshot
[ ] replacing selected text leaves the expected buffer contents
```

### 3. Scroll and wrapping

Expected touchpoints:

- `EM_GETFIRSTVISIBLELINE`, `EM_LINESCROLL`, `WM_MOUSEWHEEL`;
- child/client rect and clip calculations;
- invalidation when first visible line changes.

Acceptance:

```text
[ ] long multiline text inserts without truncation
[ ] wheel scroll changes first visible line
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

### 5. Basic formatting

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
[ ] Mouse-drag selection changes selection range
[ ] Copy/Cut/Paste work for plain text
[ ] Line wrapping and vertical scrolling stay coherent
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
5. Fix multiline wrapping, scroll, and clip invalidation.
6. Add plain text stream in/out.
7. Add basic RTF stream in/out.
8. Add basic character and paragraph formatting.
9. Re-run WordPad, Notepad, and installer RichEdit probes.
10. Update app status docs with screenshots and pass/fail state.
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
