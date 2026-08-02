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
file path: CreateFileA -> GetFileTime -> WriteFile(0x97 bytes) -> CloseHandle
OLE path:  CreateFileMoniker -> GetRunningObjectTable -> ROT Register/Release
title:     "wordpad-save-probe.txt - WordPad"
then File New, accept the "New document type" dialog, verify RichEdit len=0
then File Open, pick sources.md, verify ReadFile streaming and loaded text
result:    PASS for Save As, New/clear, and Open/load through WordPad's MFC
           command paths without missing exports or null ROT calls.
```

Current evidence from the 2026-08-02 follow-up probe:

- Mouse click now focuses the RichEdit child, so keyboard routing is no longer
  the blocker.
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
  generic plain-text infrastructure; raw native RichEdit Ctrl+C/Ctrl+V still
  travels through RichEdit's OLE storage setup in the current probe, so the
  verified WordPad clipboard path remains the renderer-side shortcut bridge.
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
- Worker-thread thunk metadata is synchronized before/after thread slices, so a
  worker can no longer allocate a stale `GetProcAddress` thunk over RichEdit's
  imported KERNEL32 thunk table.
- `EnumFontFamiliesExW` / `EnumFontFamiliesW` now enumerate one basic
  TrueType-style `Arial` face through the app callback. This unblocks WordPad's
  font-list startup path before `ShowWindow`.
- The `32767 twips` RichEdit sentinel is clamped during the exact screen-DPI
  `MulDiv(32767, 96, 1440)` conversion, so text no longer paints at a large
  negative y coordinate.
- `ExtTextOutA/W` now honors `ETO_OPAQUE` rect fills, so RichEdit's erase bands
  clear to the DC background instead of leaving black memory-DC strips.
- Regression test: `node test/test-wordpad-richedit.js` passes 22/22 and
  writes `test/output/wordpad-richedit/hello-world-edited.png`, which shows
  visible edited text in the editor.
- Regression test: `node test/test-wordpad-richedit-scroll.js` passes 10/10
  and writes `test/output/wordpad-richedit/mouse-scroll.png`, which shows
  visible scrolled multiline text in the editor.
- Regression test: `node test/test-wordpad-save-as.js` passes 32/32 and covers
  WordPad's Save As, New/clear, and Open/load command/file/OLE bookkeeping
  paths.

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
   wrapping, formatting changes, and reopen-saved-file still need focused
   probes.
4. Add richer native RichEdit state dumps if deeper assertions are needed
   (caret/selection/scroll). Current coverage reads plain text through
   `WM_GETTEXT`.
5. Treat images, tables, embedded OLE objects, and advanced RTF layout as later
   RichEdit work; the current target is app-useful plain-text editing.

RichEdit implementation scope is tracked in
[`docs/richedit-compat-design.md`](../docs/richedit-compat-design.md).

**Key files:** `lib/thread-manager.js`, `lib/renderer-input.js`,
`lib/host-imports.js`, `src/09a-handlers.wat`, `src/09a5-handlers-window.wat`
