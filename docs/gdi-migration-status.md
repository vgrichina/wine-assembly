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
Canvas text rasterizer and writes memory, window, DirectDraw, and screen DC
text pixels back to canonical surface storage using WAT-owned clip bands.
Installed FNT 2.x/3.x strikes bypass all four calls: WAT measures and writes
their glyphs directly, including `ExtTextOut` rectangle/lpDx behavior and
`DrawText` wrapping, alignment, clipping, and calculated rectangles.
The tracked Wine System, MS Sans Serif, Fixedsys, and Courier FONs plus the
ANAKRON-derived Terminal FON are preloaded into every browser and CLI process
and installed lazily by WAT. Stock variable UI fonts, common Win9x UI aliases,
all three fixed stocks, and explicit requests for those bitmap faces therefore
use this path without calling the four Canvas text-policy imports.
`OEM_FIXED_FONT` selects the open Terminal 8x12 strike, whose complete byte
range is generated through CP437 and marked `OEM_CHARSET`. Explicit
scalable/document faces and shaped text retain the Canvas fallback. See
[`bitmap-font-review.md`](bitmap-font-review.md) for the candidate and license
audit.
Every non-text semantic call removed in the
flag-day bridge purge now has a WAT implementation; both unsupported-stub
inventories are empty. Pen, solid-brush, memory-DC,
compatible-bitmap, DIB-section, window-surface, region painting, line, basic
shape, chrome, pixel, core blit, transparent image, disabled image, and DC
mapping and save-stack semantics are now WAT-owned. `SaveDC`/`RestoreDC`
preserve nested hot and auxiliary state, selected palettes, color adjustment,
and independent explicit-clip snapshots. This includes `GetDIBits`, `SetDIBits`,
`GetDIBColorTable`, `SetDIBColorTable`, and `StretchDIBits` conversion across
canonical indexed and true-color bitmap descriptors, plus logical palette
objects, per-DC palette selection, `DIB_PAL_COLORS` resolution, rounded
rectangles, Bezier curves, arcs, and window scrolling.
Public bitmap access (`CreateBitmapIndirect`, `GetBitmapBits`, and
`SetBitmapBits`), rounded and multi-polygon regions, `GetRegionData`,
`PtInRegion`, and ROP4 `MaskBlt` also route through canonical WAT storage.
Graphics mode, system-palette policy, palette animation, GDI batch-limit
state, gamma-ramp bytes, and the single software RGBA pixel-format contract
are likewise WAT-owned. Pixel-format selection is immutable after the first
successful `SetPixelFormat`, and `SwapBuffers` uses only the raw surface
presentation boundary.
`GetTextExtentExPointA/W`, `GetCharABCWidthsA`, and `GetGlyphOutlineA`
delegate glyph measurement to the allowed Canvas policy while WAT owns prefix
fitting and Win32 result structures. Font enumeration and resource/table
fallback contracts are exposed without adding another JavaScript bridge.
All named GDI32 imports in the checked-in PE corpus are now exposed. Classic
and enhanced metafiles have WAT-owned byte objects, deep-copy/lifetime,
header/query, and valid empty conversion-stream semantics; drawing-record
capture and replay remain explicitly partial.
DirectDraw HDCs now address native WAT DIB bytes,
screen DCs select a persistent WAT bitmap, and JS no longer owns DC handles,
semantic DC records, HDC target resolution, or Canvas-to-DIB synchronization.
Broader public GDI32 compatibility is tracked
separately from this bridge-boundary inventory.

There are no resource-byte exceptions and the temporary non-text exception
budget is zero. `test/test-gdi-migration-status.js` owns a separate hard-coded
allowlist, verifies the exact JS exports and WAT stubs, and compiles the module.

The remaining desktop limitation is semantic rather than an ownership split:
the screen DC exposes the canonical desktop base bitmap but does not capture
the renderer's derived cross-window z-order composite.
