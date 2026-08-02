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
- RichEdit's OLE clipboard setup no longer stops on missing profile/storage
  helpers in the covered path (`GetProfileSectionA`, `GlobalFlags`,
  `CreateILockBytesOnHGlobal`, `StgCreateDocfileOnILockBytes`,
  `WriteClassStg`, `WriteFmtUserTypeStg`). This is compatibility scaffolding,
  not full OLE storage or rich clipboard support.
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
   visible caret assertions, visible selection highlight, mouse-drag selection,
   scrolling/wrapping, formatting changes, and save/load still need focused
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
