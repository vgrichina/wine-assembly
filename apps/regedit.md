# RegEdit — Progress

**Binary:** `test/binaries/win98-apps/regedit.exe`

**Status (2026-08-10):** RegEdit has a populated WAT-native TreeView and a
visible minimal `SysListView32` pane. The focused TreeView control path now has
shared Win98-style scrollbar behavior, but the current direct RegEdit
`test/run.js` screenshot probe exits before scheduled screenshot capture, so
this page should not be read as "RegEdit fully fixed."

Previous app-smoke status (2026-06-14): promoted out of `knownBadRender` in the
all-EXE smoke matrix. RegEdit opened with the real `Registry Editor` title, a
populated registry TreeView, and a visible empty ListView pane.

Key fixes:

- `FormatMessageA(FORMAT_MESSAGE_FROM_STRING)` now copies resource strings instead of returning the generic `"Error"` fallback. RegEdit uses this for the main window title.
- WAT-native controls repaint immediately after `SetWindowPos` / `DeferWindowPos` gives them nonzero geometry. This lets the TreeView redraw after RegEdit creates it at `0x0` and later resizes it.
- TreeView/ListView children use their own renderer surfaces so parent repaints do not clear their content.
- Unpainted `SysListView32` children get a renderer fallback surface matching the minimal white Win98 ListView pane.
- `SysTreeView32` overflow rows now reuse the shared vertical scrollbar helpers
  for line/page clicks, thumb drag, `WM_MOUSEWHEEL`, `WM_VSCROLL`, hit-testing,
  selection, and `TVGN_FIRSTVISIBLE`.

Current gaps:

- `SysListView32` is still a blank/minimal pane. Item storage, headers,
  selection, and ListView scrolling remain later work.
- A direct RegEdit screenshot smoke attempted on 2026-08-10 exited before the
  scheduled input/screenshot steps. Use the standalone TreeView regression as
  the current focused scroll gate until the app-level RegEdit exit is fixed.

Validation:

```sh
node test/test-treeview-scroll.js
node test/test-listbox.js
node test/test-wat-memory-map.js
```

App-level smoke to rerun after the early-exit issue is fixed:

```sh
bash tools/build.sh
node test/test-all-exes.js --no-build RegEdit
```
