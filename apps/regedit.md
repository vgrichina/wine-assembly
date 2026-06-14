# RegEdit — Progress

**Binary:** `test/binaries/win98-apps/regedit.exe`

**Status (2026-06-14):** Promoted out of `knownBadRender` in the all-EXE smoke matrix. RegEdit now opens with the real `Registry Editor` title, a populated registry TreeView, and a visible empty ListView pane.

Key fixes:

- `FormatMessageA(FORMAT_MESSAGE_FROM_STRING)` now copies resource strings instead of returning the generic `"Error"` fallback. RegEdit uses this for the main window title.
- WAT-native controls repaint immediately after `SetWindowPos` / `DeferWindowPos` gives them nonzero geometry. This lets the TreeView redraw after RegEdit creates it at `0x0` and later resizes it.
- TreeView/ListView children use their own renderer surfaces so parent repaints do not clear their content.
- Unpainted `SysListView32` children get a renderer fallback surface matching the minimal white Win98 ListView pane.

Validation:

```sh
bash tools/build.sh
node test/test-all-exes.js --no-build RegEdit
```
