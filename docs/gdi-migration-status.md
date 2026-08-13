# GDI migration status

The machine-readable source is
[`gdi-migration-status.json`](gdi-migration-status.json). It contains the exact
keep/delete API lists for the JavaScript GDI bridge.

The permanent non-text bridge has three presentation-only calls:

- `gdi_set_region_bands`
- `gdi_set_window_rgn`
- `gdi_present_dib_rect`

Eleven `gdi_*` calls remain under the explicit Canvas text policy. The other 70
former imports are listed under `eliminatedNonTextSemantics`; their JavaScript
methods are deleted and their callers resolve to explicit zero-return WAT stubs
until real WAT implementations replace them. This intentionally breaks
unsupported application paths rather than retaining JavaScript GDI semantics.

There are no resource-byte exceptions and the temporary non-text exception
budget is zero. `test/test-gdi-migration-status.js` owns a separate hard-coded
allowlist, verifies the exact JS exports and WAT stubs, and compiles the module.
