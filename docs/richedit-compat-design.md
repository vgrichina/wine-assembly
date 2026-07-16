# RichEdit Compatibility Design

Status: active design note for the next RichEdit work after WordPad basic text
entry started working.

## ASCII TLDR

```text
Goal: make native RichEdit useful for real Win9x apps without pretending this is
      a full RichEdit clone.

                 implement now                            postpone later
        +--------------------------------+        +--------------------------------+
        | app-visible editor basics      |        | full RichEdit fidelity         |
        |                                |        |                                |
App --> | focus / keys / mouse           |        | OLE embedded objects           |
        | insertion / delete / enter     |        | tables, images, advanced RTF   |
        | caret / selection / scrolling  |        | IME, bidi, complex shaping     |
        | opaque text erase / clipping   |        | print layout / pagination      |
        | plain text + basic RTF I/O     |        | TOM/COM, accessibility, D&D    |
        | simple font/size/color style   |        | high-fidelity undo/layout      |
        +--------------------------------+        +--------------------------------+
                         |
                         v
              WordPad and installer text panes
              should type, edit, select, save, and redraw correctly.
```

Runtime shape:

```text
Win app / installer / WordPad
        |
        v
native RichEdit window proc
        |
        +--> WM_* / EM_* messages --------> USER/window state shims
        |
        +--> GDI text + erase calls ------> JS canvas renderer
        |
        +--> stream callbacks ------------> host memory/file bridge
        |
        +--> font + metric queries -------> bounded GDI metric compatibility
```

## Current baseline

WordPad now passes the smallest useful RichEdit probe:

```text
click editor -> type "hello world" -> visible text in editor
```

That validates focus handoff, keyboard routing, `WM_CHAR` insertion through the
native RichEdit path, `ETO_OPAQUE` erase fills, and the specific RichEdit
`32767 twips` font-height sentinel that previously moved text offscreen.

This is not feature complete. The next work should target the editor behaviors
that users and installers actually exercise before chasing full RichEdit parity.

## Implement now

### 1. Focused RichEdit test harness

Add a bounded probe that can run WordPad and a minimal RichEdit fixture with
screenshots and text-state checks. The probe should cover:

- click-to-focus and keyboard focus transfer;
- typing printable ASCII;
- Backspace, Delete, Enter, arrow keys, Home, End;
- Shift+arrow selection and mouse-drag selection;
- copy, cut, paste if clipboard plumbing is cheap enough to expose;
- save/reopen for plain text and basic RTF;
- screenshot assertions for caret, selection, wrapping, and redraw.

Emulator-style probes should use explicit timeouts because these are the tests
most likely to hang.

### 2. Editing and selection semantics

Keep using native RichEdit for the real edit buffer. Fill in the surrounding
message behavior it expects from USER/GDI:

- route keyboard and mouse messages to the RichEdit child consistently;
- verify `WM_KEYDOWN`, `WM_CHAR`, `WM_LBUTTON*`, `WM_SETFOCUS`, and
  `WM_KILLFOCUS` order;
- support deletion, newline insertion, caret movement, and scroll-to-caret;
- implement enough selection state rendering for selected text to be visible;
- avoid app-specific hooks unless a trace proves there is no generic behavior.

### 3. Paint and layout support

The recent `ETO_OPAQUE` and font-height fixes are the start, not the end.
Continue with the GDI behaviors RichEdit leans on:

- honor text clip rectangles and update regions;
- keep memory-DC erase/fill behavior coherent with the target DC background;
- support the `ExtTextOut` flags RichEdit uses in traces;
- handle `lpDx` spacing well enough for proportional fonts;
- regression-test Notepad and WordPad after every GDI text change.

### 4. Text I/O and streaming

Many apps use RichEdit as a document or license viewer. Implement the common
message surface first:

- `EM_GETTEXTEX`, `EM_SETTEXTEX`, `EM_GETTEXTRANGE`;
- `EM_STREAMIN` and `EM_STREAMOUT` for plain text and basic RTF;
- text length and selection range queries;
- CR/LF normalization compatible with Win9x-era controls.

The goal is enough fidelity for WordPad save/load and installer license text,
not a complete RTF engine.

### 5. Basic formatting

Implement the visible formatting subset that WordPad and common apps expose:

- `EM_SETCHARFORMAT` / `EM_GETCHARFORMAT`;
- `EM_SETPARAFORMAT` / `EM_GETPARAFORMAT`;
- font face, size, bold, italic, underline, text color;
- paragraph alignment and simple bullets if traces show WordPad needs them.

Prefer trace-driven support. If a formatting field is not rendered yet, preserve
it through stream out when practical so files do not lose data unnecessarily.

## Postpone later

These are real RichEdit features, but they should not block the next app-status
push:

- OLE embedded objects and in-place activation;
- tables, images, hyperlinks, and high-fidelity RTF import/export;
- complex text shaping, IME composition, bidi layout, and script-specific line
  breaking;
- printing, pagination, ruler fidelity, and printer-device metrics;
- TOM/COM interfaces and deep accessibility integration;
- drag/drop editing and rich clipboard formats beyond plain text/basic RTF;
- high-fidelity undo grouping and advanced layout edge cases;
- exact version differences across RichEdit 1.0, 2.0, 3.0, and later.

## Acceptance matrix

```text
[x] WordPad accepts focus and inserts visible "hello world"
[ ] Backspace/Delete edit visible text correctly
[ ] Enter creates a visible new line
[ ] Arrow/Home/End movement tracks the caret
[ ] Shift+arrow and mouse-drag selection render visibly
[ ] Copy/Cut/Paste work for plain text
[ ] Line wrapping and vertical scrolling stay coherent
[ ] Plain text save/reopen works
[ ] Basic RTF save/reopen works without data loss for simple styling
[ ] Bold/italic/underline/font-size/color are visible in WordPad
[ ] Installer/license RichEdit panes render and scroll
```

## Implementation order

```text
1. Add bounded RichEdit/WordPad probes with screenshots.
2. Fix deletion, Enter, caret navigation, and scroll-to-caret.
3. Add visible selection rendering.
4. Add plain text stream in/out, then basic RTF.
5. Add basic character formatting and paragraph formatting.
6. Re-check broader EXE matrix and update app status docs.
```

## Compatibility constraints

- Treat this as compatibility around native RichEdit, not a greenfield editor.
- Keep hacks narrow. The existing `MulDiv(32767, 96, 1440)` clamp is acceptable
  as a compatibility guard for the observed RichEdit sentinel, but broad GDI
  math clamps should require trace evidence.
- Prefer app-agnostic USER/GDI/message fixes over WordPad-specific branches.
- Every text-rendering fix needs Notepad and WordPad regression coverage because
  both exercise the same lower-level paths.
- Keep screenshots as evidence for visual behavior. Text-state probes alone will
  miss paint, erase, caret, and selection bugs.

