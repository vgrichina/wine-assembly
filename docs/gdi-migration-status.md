# GDI migration status

The machine-readable source is
[`gdi-migration-status.json`](gdi-migration-status.json). It contains the exact
keep/delete API lists for the JavaScript GDI bridge.

The permanent non-text bridge has seven presentation and cross-process
transport calls:

- `gdi_set_region_bands`
- `gdi_set_window_rgn`
- `gdi_screen_readback`
- `gdi_surface_create`
- `gdi_surface_attach`
- `gdi_surface_upload`
- `gdi_surface_delete`

Two `gdi_*` calls remain under the explicit Canvas text policy. Font handles,
LOGFONT properties, face-name storage, selection, text color, background mode,
alignment, mapping, and clipping are owned by WAT. `gdi_text_bind` exposes a
transient derived view of those properties only when `gdi_text_mask` must
rasterize an unsupported scalable face. JavaScript neither allocates font
handles nor stores authoritative dynamic font objects. Canvas returns a
bounded one-bit mask, and WAT writes memory, window, DirectDraw, and screen DC
pixels into canonical surface storage. Installed FNT 2.x/3.x strikes bypass
both calls: WAT measures and writes
their glyphs directly, including `ExtTextOut` rectangle/lpDx behavior and
`DrawText` wrapping, alignment, clipping, and calculated rectangles.
The tracked Wine System, MS Sans Serif, Fixedsys, and Courier FONs plus the
ANAKRON-derived Terminal FON are preloaded into every browser and CLI process
and installed lazily by WAT. Stock variable UI fonts, common Win9x UI aliases,
all three fixed stocks, and explicit requests for those bitmap faces therefore
use this path without calling the two Canvas text-policy imports.
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
Native Win98 DIB captures now back the `CreatePen`/`LineTo` wide-line fixture
set. Axis-aligned solid widths 2 through 5 match those captures exactly in
both directions, including endpoint-cap coverage, edge clipping, and all
`ROP2` modes through a one-write coverage region. The reusable source is
`tools/v86-reference/probes/gdi-wide-lines.c`; its capture provenance and
exact masks are checked in under `test/fixtures/gdi-wide-line-pixels.json`.
Captured diagonal cases remain reference-only while the WAT path retains its
deterministic square-stamp approximation, and widths above five, transformed
wide lines, and geometric pen cap/join semantics remain future fidelity work.
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
DirectDraw HDCs now address native WAT DIB bytes. Screen DCs select a
persistent WAT bitmap. `GetPixel` and blits that use a screen DC as their
source synchronously materialize the global renderer z-order into that bitmap.
The host copies canonical bytes directly between process memories, using a
bulk `Uint32Array` row path for 32-bit surfaces and the canonical decoder for
indexed/16/24-bit DirectDraw frames. It never samples Canvas. JS still owns no
DC handles, semantic DC records, HDC target resolution, or Canvas-to-DIB
synchronization.
Broader public GDI32 compatibility is tracked
separately from this bridge-boundary inventory.

There are no resource-byte exceptions and the temporary non-text exception
budget is zero. `test/test-gdi-migration-status.js` owns a separate hard-coded
allowlist, verifies the exact JS exports and WAT stubs, and compiles the module.

The browser's HTML desktop icons and transient Canvas-only caret/resize
feedback are not part of screen-DC captures. Guest windows, WAT popup-menu
surfaces, wallpaper, window regions, child surfaces, and canonical DirectDraw
layers are included.
