# RegEdit — Progress

**Binary:** `test/binaries/win98-apps/regedit.exe`

**Status (2026-08-11):** RegEdit reaches the direct `test/run.js`
screenshot probe with a populated WAT-native TreeView and a stateful bounded
`SysListView32` report pane. The focused TreeView/ListView control paths reuse
shared Win98-style vertical scrollbar behavior, and the app-level smoke writes
a screenshot with the `Name` / `Data` ListView headers visible. The standalone
TreeView regression also covers parent/child handles, `TVGN_CHILD`,
`TVGN_PARENT`, depth-first `TVGN_NEXTVISIBLE`, `TVM_GETITEMA` text buffer
copying, `TVIF_CHILDREN`, `TVM_EXPAND` expand/collapse visibility, and
`TVN_ITEMEXPANDING` / `TVN_ITEMEXPANDED` notifications. Registry root, subkey,
value enumeration, and `RegQueryInfoKey` metadata now have direct host/WAT
coverage for RegEdit and other registry-driven apps.

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
  selection, and `TVGN_FIRSTVISIBLE`. The WAT TreeView path also preserves
  parent/child links enough for `TVGN_CHILD`, `TVGN_PARENT`, `TVIF_CHILDREN`,
  depth-first `TVGN_NEXTVISIBLE`, `TVM_GETITEMA` text buffer copying,
  `TVM_EXPAND` visibility toggles, and expand/collapse notifications, with
  `dump-tree`/paint counters available in the harness for future app probes.
- `SysListView32` now stores report columns, fixed subitem text, item count,
  single-row selection, top index, hit-testing, `LVM_*` item/text/state queries,
  and vertical scrollbar line/page/thumb behavior through the same helpers.
- The bounded report-mode `SysListView32` path now also supports
  `LVM_GETCOLUMNA` / `LVM_SETCOLUMNA`, `LVM_GETITEMRECT`,
  `LVM_GETSUBITEMRECT`, and report-column subitem hit-test output for apps
  that query geometry before drawing, selecting, or dispatching context actions.
- ListView selection changes now send bounded `LVN_ITEMCHANGING` /
  `LVN_ITEMCHANGED` state notifications, and row click release sends `NM_CLICK`
  to the parent window.
- `LVM_GETHEADER` now exposes a pseudo-header message surface for common
  `HDM_GETITEMCOUNT`, `HDM_GETITEMA`, `HDM_GETITEMRECT`, and `HDM_HITTEST`
  queries against the ListView's report-column state.
- `LVM_DELETEITEM` and `LVM_DELETECOLUMN` now free shifted text buffers and keep
  count, selection, scroll, and pseudo-header state coherent after removal.
- `LVM_SETIMAGELIST` / `LVM_GETIMAGELIST` and `LVIF_IMAGE` / `LVIF_PARAM`
  now round-trip ListView image-list handles and per-item metadata, while
  report-mode drawing continues to use the existing bounded placeholder glyph.
- `SysListView32` is now protected from registered-class fallback, so
  `CreateWindowExA("SysListView32", ...)` routes to the WAT-native ListView
  instead of RegEdit's/COMCTL32's guest window proc.
- Registry storage now materializes parent keys, opens roots/subkeys
  case-insensitively, supports `RegEnumKeyA/W` and `RegEnumValueA/W` buffer
  semantics, reports `RegQueryInfoKeyA/W` counts/max lengths, and exposes
  root-handle `RegQueryValueEx` reads. A synchronous `DrawAnimatedRects`
  cosmetic stub lets selection/update paths continue.

Current gaps:

- Advanced ListView behavior remains later work: icon/small-icon/list view
  layout, real image-list rendering, sorting, custom draw, notifications beyond
  the current selection/click subset, label edits, and high-fidelity real
  Header-control interaction beyond the current pseudo-header query surface.
- The app-level regression now expands
  `HKEY_CURRENT_USER\Control Panel\Desktop`, verifies its four value rows, and
  captures both the populated pane and Registry menu. Value editing, context
  menus, and advanced ListView fidelity remain separate follow-up work.

Validation:

```sh
node test/test-treeview-scroll.js   # passes 27/27
node test/test-storage-registry.js  # passes registry root/subkey/value/info coverage
node test/test-listview.js           # passes 97/97
node test/test-listbox.js
node test/test-regedit-deep.js
node test/test-wat-memory-map.js
bash tools/build.sh
/opt/homebrew/bin/timeout 180 node test/run.js --exe=test/binaries/win98-apps/regedit.exe --max-batches=180 --quiet-api --input=20:wait-title:Registry_Editor:1200,40:dump-windows:regedit,60:png-pixels:/private/tmp/regedit-listview-smoke.png,70:stop
```

All-EXE smoke to rerun for matrix status:

```sh
bash tools/build.sh
node test/test-all-exes.js --no-build RegEdit
```
