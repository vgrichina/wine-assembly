# GDI migration status

The machine-readable source is
[`gdi-migration-status.json`](gdi-migration-status.json). It contains the exact
keep/delete API lists for the JavaScript GDI bridge.

The permanent non-text bridge has six presentation-only calls:

- `gdi_set_region_bands`
- `gdi_set_window_rgn`
- `gdi_surface_create`
- `gdi_surface_attach`
- `gdi_surface_upload`
- `gdi_surface_delete`

Four `gdi_*` calls remain under the explicit Canvas text policy. Text color,
background mode, alignment, mapping, and selected font state are owned by the
canonical WAT DC record; `gdi_text_bind` exposes that record to the retained
Canvas text rasterizer and writes memory and window DC text pixels back to
canonical surface storage. Every non-text semantic call removed in the
flag-day bridge purge now has a WAT implementation; both unsupported-stub
inventories are empty. Pen, solid-brush, memory-DC,
compatible-bitmap, DIB-section, window-surface, region painting, line, basic
shape, chrome, pixel, core blit, transparent image, disabled image, and DC
mapping semantics are now WAT-owned. This includes `GetDIBits`, `SetDIBits`,
`GetDIBColorTable`, and `StretchDIBits` conversion across canonical indexed
and true-color bitmap descriptors, plus rounded rectangles, Bezier curves,
arcs, and window scrolling. Broader public GDI32 compatibility is tracked
separately from this bridge-boundary inventory.

There are no resource-byte exceptions and the temporary non-text exception
budget is zero. `test/test-gdi-migration-status.js` owns a separate hard-coded
allowlist, verifies the exact JS exports and WAT stubs, and compiles the module.
