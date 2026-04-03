# regedit.exe (Registry Editor) - Win98

**Status:** FAIL
**Crashes on:** GetCurrentObject (GDI32)
**Batch reached:** 38

## Crash Details

Regedit gets very far -- 13,052 API calls before crashing. It successfully creates windows, loads resources, draws the treeview and listview with extensive GDI operations (SelectObject, PatBlt thousands of times for drawing dotted lines/grid patterns). The crash happens when it calls `GetCurrentObject(hDC, OBJ_FONT=6)` which returns `0x0000ffff` (the "not implemented" sentinel), then uses that bad handle in subsequent calls.

EIP at crash: `0x00476943` -- after GetCurrentObject returns, code tries to use the invalid handle.

The crash is in a drawing routine that:
1. Does PatBlt x many (draws grid/tree lines with ROP PATCOPY=0xf00021)
2. Calls SelectObject to restore a brush
3. Calls GetDC on a child window
4. Calls GetCurrentObject(hDC, 6) to get current font -- CRASH

## API Call Sequence (13,052 calls before crash)

Highlights:
- Full PE load, CRT init
- RegisterClassExW, CreateWindowExW x multiple (main, treeview, listview, status bar)
- LoadMenuW, LoadAcceleratorsW, LoadStringW x many
- RegOpenKeyExW, RegEnumKeyExW, RegQueryValueExW (registry browsing)
- Extensive GDI: GetDC, SelectObject, CreateSolidBrush, PatBlt (thousands of calls)
- TextOutW, ExtTextOutW (drawing text in tree/list)
- **GetCurrentObject(hDC, OBJ_FONT=6)** -- CRASH

## What Needs to Be Implemented

`GetCurrentObject` -- needs to return the currently selected object of a given type from a DC. This requires the GDI DC state tracking to remember which font/brush/pen/etc. is currently selected into each DC. Currently returns 0xffff (unimplemented).

The GDI subsystem already tracks selected objects for SelectObject. GetCurrentObject just needs to query that state.

## Difficulty: Medium

Requires the DC state table to track the currently selected object per type (font, brush, pen, bitmap, palette, region). SelectObject already does some of this. GetCurrentObject is the read-side of that tracking. The host-imports GDI layer may need updates too.
