# RegEdit — Progress

**Binary:** `test/binaries/win98-apps/regedit.exe`

**Status (2026-08-10):** RegEdit now reaches the direct `test/run.js`
screenshot probe with a populated WAT-native TreeView and a stateful bounded
`SysListView32` report pane. The focused TreeView/ListView control paths reuse
shared Win98-style vertical scrollbar behavior, and the app-level smoke writes
a screenshot with the `Name` / `Data` ListView headers visible.

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
- `SysListView32` now stores report columns, fixed subitem text, item count,
  single-row selection, top index, hit-testing, `LVM_*` item/text/state queries,
  and vertical scrollbar line/page/thumb behavior through the same helpers.
- `SysListView32` is now protected from registered-class fallback, so
  `CreateWindowExA("SysListView32", ...)` routes to the WAT-native ListView
  instead of RegEdit's/COMCTL32's guest window proc.

Current gaps:

- Advanced ListView behavior remains later work: icon/small-icon/list view
  layout, image lists, sorting, custom draw, full notifications, labels edits,
  and high-fidelity header interaction.
- The current screenshot shows the root registry view with headers; deeper
  registry value enumeration/editing, context menus, and advanced ListView
  fidelity remain separate follow-up work.

Validation:

```sh
node test/test-treeview-scroll.js
node test/test-listview.js
node test/test-listbox.js
node test/test-wat-memory-map.js
bash tools/build.sh
/opt/homebrew/bin/timeout 180 node test/run.js --exe=test/binaries/win98-apps/regedit.exe --max-batches=180 --quiet-api --input=20:wait-title:Registry_Editor:1200,40:dump-windows:regedit,60:png-pixels:/private/tmp/regedit-listview-smoke.png,70:stop
```

All-EXE smoke to rerun for matrix status:

```sh
bash tools/build.sh
node test/test-all-exes.js --no-build RegEdit
```
