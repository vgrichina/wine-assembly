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
canonical surface storage. Former imports still lacking WAT implementations
are listed under `eliminatedNonTextSemantics`; their JavaScript methods are
deleted and their callers resolve to explicit zero-return WAT stubs until real
WAT implementations replace them. Pen, solid-brush, memory-DC,
compatible-bitmap, DIB-section, window-surface, region, line, basic shape,
chrome, pixel, and core blit semantics are now WAT-owned. This intentionally
breaks unsupported application paths rather than retaining JavaScript GDI
semantics.

There are no resource-byte exceptions and the temporary non-text exception
budget is zero. `test/test-gdi-migration-status.js` owns a separate hard-coded
allowlist, verifies the exact JS exports and WAT stubs, and compiles the module.
