# Software GDI rasterizer design

## Status

Implementation started 2026-08-12. WAT now owns canonical bitmap and window
surfaces, GDI object/DC state, regions and explicit clipping, native-format
pixel access, all ROP2/ROP3 truth tables, source and stretch blits, flood fill,
and integer geometry. JavaScript retains presentation uploads/composition and
the scalable-font Canvas fallback. Installed Win16/Win9x FNT bitmap strikes
are parsed, selected, measured, and rasterized directly into the canonical WAT
surface without a Canvas glyph or destination readback.

The public compatibility surface is not complete yet. Current high-priority
gaps are DIB/pattern brushes in pattern-dependent blits, path selection,
callback APIs such as `LineDDA` and object/font enumeration, and metafile and
printer compatibility. The checked-in PE corpus has a machine-checked public
API inventory in `gdi-public-api-status.json`; its exact sorted import-set hash
prevents new application dependencies from silently expanding the
compatibility surface. All explicit gaps in that inventory must be closed
before this effort can be declared complete.

Rectangular HRGN ownership and Boolean algebra now run in WAT. WAT allocates
generation-tagged handles and owns normalization, mutation, offset, bounding
boxes, object typing, lifetime, and `RGN_AND`/`OR`/`XOR`/`DIFF`/`COPY`. Each
region has a fixed canonical arena of up to 208 sorted, disjoint half-open band
rectangles. Boolean results are constructed in alias-safe WAT scratch buffers.
JavaScript receives those rectangles only to rebuild derived Canvas clip and
window-shape presentation data. Ellipse regions use deterministic integer
pixel-center scan conversion into the same WAT arena. Polygon regions use an
exact-rational WAT scanline with half-open edges and grouped crossings for both
`ALTERNATE` and `WINDING` fill modes. The current explicit envelope is 208
vertices, 4,096 rows, and coordinates within +/-1,000,000; calls outside it
fail instead of delegating geometry to JavaScript.

Application-defined DC clips are also WAT-owned. Each live HDC entry holds a
private canonical HRGN copy, so deleting or modifying the caller's selected
region cannot change the DC. `SelectClipRgn`, `ExtSelectClipRgn`,
`IntersectClipRect`, `ExcludeClipRect`, `OffsetClipRgn`, `GetClipRgn`,
`GetClipBox`, `PtVisible`, and `RectVisible` operate on that copy. JavaScript
receives a rebuilt host-region mirror only for Canvas clipping. DC deletion and
release destroy the private region. `SaveDC`/`RestoreDC` use a WAT-owned nested
stack and take independent copies of the selected explicit clip along with the
complete hot DC record, auxiliary text/brush/arc state, color adjustment, and
selected logical palette. Absolute and relative restore indices discard the
restored snapshot and every newer snapshot. The derived system/window
visibility region remains separate follow-up work.

`CreateCompatibleBitmap` DDBs now use private 32-bpp, top-down canonical storage
in the WAT bitmap arena while preserving `BITMAP.bmBits == NULL`. Canvas remains
a derived cache: WAT raster writes upload bounded rectangles. The retained
Canvas text rasterizer receives an opaque WAT surface ID and canonical DC state,
then copies its bounded output back into canonical native storage before
returning. Deletion returns the private pages to the arena.

`LoadBitmapA/W` now materialize uncompressed `BITMAPCOREHEADER` and
`BITMAPINFOHEADER` resources plus bounded `BI_RLE4`/`BI_RLE8`
RT_BITMAP resources entirely in WAT. Encoded, absolute, end-of-line,
end-of-bitmap, and delta commands decode into canonical packed scanlines with
strict source/destination bounds. The raster core reads and writes 1-, 4-,
8-, 16-, 24-, and 32-bpp surfaces, resolves indexed colors from each bitmap's
owned RGBQUAD table (expanding core RGBTRIPLE palettes), and performs cross-format ROP blits before uploading the
result. This is sufficient for Paint's compressed tool strip and SkiFree's
indexed sprite-atlas construction, as well as Solitaire's CARDS.dll core
bitmaps. `BI_BITFIELDS` remains follow-up work. Logical palettes are canonical
WAT GDI objects with per-DC selection, mutation, resizing, nearest-color
lookup, and owned entry storage. `DIB_PAL_COLORS` bitmap creation and transient
DIB calls resolve WORD indexes through the selected logical palette; pattern
brushes preserve the indexes and resolve them against the destination DC at
sample time.

`LineTo` now uses a WAT Bresenham kernel for solid pens up to 64 pixels wide on
24- and 32-bpp DIB sections and software-backed compatible bitmaps. WAT owns logical-to-device mapping, endpoint exclusion,
canonical clip tests, all 16 `ROP2` Boolean modes, native BGR byte writes, and
dirty bounds. WAT resolves selected objects and DC state into a canonical
descriptor; JavaScript only uploads the resulting dirty rectangle to the
presentation Canvas. Wide strokes
currently use an integer square footprint with `R2_COPYPEN` under 1:1 mapping;
non-copy or transformed wide operations fail explicitly pending coverage-mask
and geometric-path kernels. Client and whole-window DCs now resolve to one
top-level, WAT-owned 32-bpp backing surface with descriptor origins for child,
client, and non-client coordinates. One-pixel dash, dot, dash-dot, and
dash-dot-dot pens use fixed
device-step WAT coverage tables. `CreatePen` dash/dot styles wider than one are
normalized to solid as Win32 specifies.

Solid, null, and all six Win32 hatch brushes are canonical WAT objects.
Rectangle, ellipse, round-rectangle, polygon, `FillRect`, and region fill paths
sample hatch masks in device coordinates, including `SetBrushOrgEx`, opaque
background color, and transparent background preservation. `GetObjectA/W`
serializes stable `LOGPEN`, `LOGBRUSH`, `BITMAP`, and `LOGFONT` structures.
Pattern-dependent `PatBlt`, `BitBlt`, `StretchBlt`, `StretchDIBits`, and flood
fill operations use the same coordinate-aware sampler. `CreatePatternBrush`
snapshots any canonical bitmap into brush-owned storage, and
`CreateDIBPatternBrushPt` copies packed `DIB_RGB_COLORS` data or preserves
`DIB_PAL_COLORS` logical indexes in the same native-format bitmap records.
Pattern pixels repeat in device coordinates with the canonical brush origin
and are sampled by every brush-dependent WAT path. Palette-index patterns are
resolved through each destination DC's selected logical palette when sampled.

Tabbed text now uses the same canonical DC-to-text binding as ordinary text.
WAT parses ANSI or UTF-16 tab characters, measures individual runs, expands
default, repeating single, or explicit multiple tab stops relative to the tab
origin, applies `TA_UPDATECP`, and constructs the packed width/height result.
Canvas remains responsible only for measuring and rasterizing each glyph run,
with the resulting pixels copied back to the authoritative WAT surface.

`Polyline` and `PolylineTo` reuse the WAT line kernel after an atomic
all-segment preflight. Cosmetic style phase continues across segment
boundaries and each shared endpoint is covered once. `Polyline` preserves the
DC current position; `PolylineTo` starts from and advances the WAT-owned
current position. Unsupported paths fail explicitly; there is no Canvas
geometry fallback.

This document describes the incremental migration from Canvas 2D vector
drawing to deterministic software rasterization implemented primarily in WAT.
It does not propose replacing Canvas as the desktop compositor or presentation
API.

The immediate drivers are visible in Win98 Paint:

- Canvas vector paths antialias lines, curves, ellipses, and rounded corners.
  `imageSmoothingEnabled = false` affects scaled images, not `stroke()` or
  `fill()` rasterization, so output differs from classic integer GDI and can
  differ between browser engines.
- The former `CreateDIBSection` Canvas shadow required guest stores, host GDI
  operations, and presentation to synchronize two pixel copies. Canonical WAT
  memory has replaced that model.
- Paint's brush-options panel is still visually incorrect. Its small bitmap and
  mask operations need exact pixel tests as part of this migration; software
  line rasterization alone will not necessarily fix it.

## Decision

GDI surfaces will use one authoritative pixel store. WAT owns GDI handles, DC
state, regions, clipping, rasterization, ROPs, and native-format pixel access.
GDI primitives read and write the authoritative store without delegating their
semantics to JavaScript. JavaScript receives dirty rectangles and remains
responsible for browser-facing presentation, final window composition,
scaling, and display.

Canvas vector paths must not be used for geometric GDI primitives whose Win32
result is defined as raster pixels. Canvas remains the layout/raster fallback
for scalable and shaped text; installed FNT bitmap faces use WAT-owned integer
metrics and exact one-bit glyph data.
JavaScript host imports are limited to facilities WebAssembly cannot directly
provide: Canvas upload/composition, browser font rasterization, audio, input,
storage, and similar platform APIs. Canvas may also remain an explicitly
documented compatibility fallback during migration, but new GDI algorithms
must not be implemented in JavaScript.

This is a staged replacement, not a flag-day rewrite.

## Invariants

1. Every bitmap or window surface has exactly one authoritative pixel store.
2. A DIB section's guest-visible bytes are its authoritative store. There is no
   second authoritative RGBA copy.
3. Canvas content is a derived presentation cache. Code never reads Canvas to
   discover the current value of a software-backed GDI surface.
4. Each GDI write presents an explicit bounded rectangle. Guest CPU writes to
   DIB memory need no write barrier because all GDI reads use those bytes
   directly; a later explicit presentation operation uploads them to Canvas.
5. GDI read/modify/write operations run against the authoritative store,
   including raster operations, flood fill, `GetPixel`, and source blits.
6. Rasterization uses integer coordinates and deterministic coverage rules.
   The same input must produce the same pixels in Safari, Chromium, and Node.
7. HDC state remains separate from surface storage. Multiple DCs may select the
   same bitmap and must observe each other's writes immediately.

## Surface model

Introduce a WAT-owned surface descriptor table below DC resolution. It exposes
bulk operations rather than a host call for every pixel.

```js
{
  id,
  width,
  height,
  format,             // bgra32, bgr24, rgb565, indexed8, mono1, ...
  stride,
  topDown,
  storage,            // guest memory view or host-owned typed array
  storageOffset,
  palette,
  dirty,
  presentation        // optional Canvas cache; never authoritative
}
```

There are two storage classes:

- **DIB surface.** References bytes in WASM linear memory allocated by
  `CreateDIBSection`. It preserves the DIB's native bit depth, stride, palette,
  channel order, and top-down/bottom-up orientation.
- **Host surface.** Owns a packed typed-array buffer for compatible bitmaps,
  window backing stores, printer pages, and other non-guest-visible targets.
  BGRA32 or RGBA32 is acceptable initially, provided conversions are explicit
  at the presentation boundary.

A memory DC has no pixels of its own. Its selected bitmap resolves to a
surface. A window DC resolves to the window backing surface plus an origin and
clip. DirectDraw surface DCs resolve through the same descriptor interface
while preserving the DirectDraw surface's native storage.

Recommended resolution API:

```js
gdi_resolve_target(hdc) -> {
  surface,
  originX,
  originY,
  clipRegion,
  dcState
}
```

The WAT rasterizer resolves this target once per GDI call. Hot loops then
operate directly on linear memory and spans without repeatedly looking up the
HDC or crossing the JS boundary.

Bitmap construction uses a separate pure parsing layer in
`src/10a-gdi-bitmap.wat`. It validates raw `BITMAPINFO`/RT_BITMAP bytes,
computes bounded palette and pixel spans, decodes bounded RLE4/RLE8 streams,
plans WORD-aligned `CreateBitmap`
storage, initializes the canonical 48-byte bitmap record, and writes Win32
`BITMAP` query structures. The parser never allocates a handle or asks
JavaScript to create a GDI object. Registry binding supplies canonical storage
and copies the validated spans in a later step.

## Implementation boundary

The end-state ownership is:

```text
WAT
  GDI handle allocation and object tables
  DC selection, mapping, colors, modes, and clip state
  DIB and host-surface descriptors
  HRGN bands and Boolean operations
  geometry coverage, pixels, spans, ROP2/ROP3, flood fill
  dirty page/rectangle bookkeeping

JavaScript
  allocate/resize Canvas presentation caches on WAT request
  upload dirty native pixels to Canvas
  composite windows and handle browser scaling
  rasterize font glyphs into scratch masks until a WAT font backend exists
  browser APIs: audio, MIDI, input, storage, clipboard, networking
```

The migration may temporarily mirror existing JS GDI handles into WAT tables,
but each milestone must move ownership toward WAT. A JS helper that implements
new region, clipping, geometry, pixel, or ROP semantics is out of scope.

### Enforced JavaScript bridge

The flag-day bridge purge makes the end-state boundary executable now, even
before every WAT replacement exists. Non-text GDI calls without a WAT
implementation fail through explicit WAT stubs; they do not regain behavior by
crossing into JavaScript. Temporary application regressions are preferable to
silently preserving two semantic implementations.

The permanent presentation-only `gdi_*` JavaScript imports are:

```text
gdi_set_region_bands   upload canonical WAT bands to a derived clip mirror
gdi_set_window_rgn     apply that mirror during browser window composition
gdi_surface_create     allocate a derived Canvas cache for WAT surface metadata
gdi_surface_attach     attach a WAT window/overlay surface to its compositor Canvas
gdi_surface_upload     upload dirty authoritative pixels to Canvas
gdi_surface_delete     discard the derived Canvas cache
```

Canvas text-policy imports are `gdi_text_bind`, `gdi_text_out`,
`gdi_ext_text_out`, and `gdi_draw_text`. Text colors, background mode,
alignment, mapping state, font selection, DC identity, bitmap selection, and
clip bands remain WAT-owned. `gdi_text_bind` exposes a canonical DC record,
clip-band snapshot, and opaque surface token without constructing a semantic
JavaScript DC mirror. Canvas output for memory, window, DirectDraw, and screen
DCs is copied synchronously into authoritative native pixels. There is no
current `gdi_*` resource exception. `LoadBitmapA/W` resolve raw RT_BITMAP bytes
through the WAT PE-resource walker, validate and copy pixels and RGBQUADs into
owned canonical storage, then publish only a derived surface presentation.

`test/test-gdi-migration-status.js` hard-codes this allowlist, verifies that
JavaScript exports no other `gdi_*` methods, checks the zero temporary-exception
budget, inventories each WAT unsupported stub, and compiles the module. The
exception ceiling may decrease but must never increase.

## DIB ownership and synchronization

For a DIB section, guest memory becomes the only pixel truth:

- Guest x86 stores write the DIB bytes directly.
- Host GDI primitives selected into the DIB write those same bytes.
- GDI reads consume those same bytes.
- Presentation converts changed native-format rows into a Canvas upload.

This removes:

- Canvas-to-DIB reconciliation;
- full-surface hashes used to detect which copy changed;
- ambiguity about whether a guest store or a host draw wins;
- full-bitmap conversion before a GDI read.

It removes guest-write dirty tracking. A raw store through the pointer returned
by `CreateDIBSection` changes canonical memory but does not itself display the
bitmap. A later `BitBlt`, `StretchBlt`, `SetDIBitsToDevice`, text operation, or
explicit presentation reads the current bytes and supplies the destination
rectangle to upload. CPU scalar/string/FPU stores therefore need no DIB range
checks or page notifications.

The dedicated DIB arena retains a 4 KB occupancy bitmap and allocation-run
table solely for allocation and reuse. These are not presentation state. GDI
operations may provide exact dirty rectangles as upload hints; JS does not
infer them by watching memory.

The Canvas cache may be discarded and rebuilt at any time. Deleting the DIB
reclaims its arena pages and its presentation cache together.

## Rasterizer organization

Implement the rasterizer as format-neutral coverage generation plus
format-specific pixel/span operations.

### Coverage and geometry

- Integer line walker with Win32-compatible endpoint rules.
- Rectangle edges and fills using half-open bounds.
- Polygon edge table with `ALTERNATE` and `WINDING` fill modes.
- Integer ellipse and arc rasterization with explicit bounding-box semantics.
- Rounded rectangles composed from spans and integer ellipse quadrants.
- Cubic Bezier flattening with a deterministic integer error bound, followed by
  the line walker.
- Cosmetic pen widths, styles, joins, caps, and brush patterns added in stages.

Do not assume textbook Bresenham output automatically matches GDI. Endpoint
exclusion, ellipse bounds, wide-pen centering, dash phase, and polygon edge
ownership must be locked with reference fixtures.

### Pixel and span operations

Each supported format supplies optimized operations such as:

```js
readPixel(x, y)
writePixel(x, y, color, rop2)
writeSolidSpan(y, x0, x1, color, rop2)
copySpan(dst, src, count, rop3)
expandMonoSpan(...)
```

The first implementation may specialize common Paint paths:

- 1, 4, 8, 24, and 32 bpp DIB access;
- solid cosmetic pens;
- solid brushes;
- `R2_COPYPEN`;
- `SRCCOPY`, `SRCAND`, `SRCPAINT`, `SRCINVERT`, `PATCOPY`, `BLACKNESS`,
  `WHITENESS`, and `DSTINVERT`.

Unsupported combinations must use a named, instrumented compatibility fallback
or fail visibly in tests. They must not silently draw with different semantics.

### Clipping

Convert the active DC clip and window visibility clip to sorted horizontal
spans or rectangle bands before rasterization. Intersect generated spans with
the clip bands. This avoids Canvas clip-path behavior and supports exact dirty
bounds.

The existing region representation can remain initially if it can enumerate
rectangles deterministically. A banded region representation is the preferred
long-term form because fills, blits, and upload bounds all consume spans.

The first migration slice handles unclipped and rectangularly clipped DIB
fills exactly. WAT now owns canonical band regions for rectangle combinations,
scan-converted polygons and ellipses, and application-defined HDC clips. The
next clipping slice separates and combines system/window visibility clips and
adds `SaveDC`/`RestoreDC` clip snapshots before raster kernels consume the
canonical intersection directly.

## Presentation

Each surface maintains an optional Canvas presentation cache. Flushing a dirty
surface performs:

1. Coalesce explicit dirty rows, tiles, or rectangles.
2. Convert native pixels and palettes to RGBA for only those areas.
3. Upload without interpolation using `putImageData`, `ImageBitmap`, or an
   unscaled `drawImage` from a staging canvas.
4. Mark the uploaded areas clean.

Window surfaces use the same rule. WAT owns a persistent surface record keyed
by the top-level HWND and recreates its linear-memory backing when renderer
geometry changes. `gdi_surface_attach` binds only the derived Canvas; bounded
uploads schedule normal renderer composition. Releasing an HDC drops its DC
record but keeps the window pixels, while destroying the owning HWND releases
both canonical pages and the presentation cache.

DirectDraw `GetDC` binds the synthetic HDC directly to the existing native
surface bytes in `DX_OBJECTS`. WAT GDI reads and writes that native format;
`ReleaseDC` deletes only the transient Canvas presentation and DC state. The
old DIB-to-Canvas-to-DIB round trip no longer exists, so stale Canvas pixels
cannot overwrite a DirectDraw surface.

`GetDC(NULL)` and `GetDC(GetDesktopWindow())` select a persistent screen-sized
32-bpp WAT bitmap. Its Canvas is attached as the renderer's desktop base layer.
The final z-order desktop image remains a derived compositor result; capturing
other windows through the screen DC is not yet implemented and must not be
emulated by reading the compositor Canvas back into GDI storage.

Popup menus use the same surface model rather than a semantic renderer
fallback. WAT owns a screen-sized bitmap selected into a persistent memory DC,
paints menu chrome in desktop coordinates, and calls `gdi_surface_attach` with
the compositor-overlay target. The renderer composites only the popup's dirty
rectangles, so opaque native bitmap storage does not cover unrelated desktop
pixels. Canvas remains the menu text rasterizer through the normal text-policy
bridge; no JavaScript menu geometry implementation remains.

The renderer then composes window caches onto the desktop Canvas as it does
today. Browser zoom or CSS scaling may affect display size but cannot change the
underlying GDI pixels.

Avoid reading the presentation Canvas in GDI code. The only readback is the
bounded rectangle produced by the Canvas text rasterizer itself, immediately
copied into the bound canonical surface. Desktop composition is one-way and
never becomes a GDI pixel source.

## Text

Text has two explicit backends. Installed FNT 2.x/3.x bitmap strikes are a
WAT-native backend; scalable faces and shaping remain on the Canvas fallback.
The selected font object determines the route before any host text binding.

Canvas must not bypass authoritative surface storage. Text operations use this
pipeline:

```text
TextOut/ExtTextOut/DrawText (scalable fallback)
        |
        v
Canvas scratch surface renders glyphs
        |
        v
coverage or RGBA rectangle is read from scratch
        |
        v
software composition applies GDI text/background colors,
clipping, opaque/transparent background mode, and supported ROP
        |
        v
authoritative GdiSurface + dirty rectangle
```

The scratch Canvas is temporary source material, not a presentation cache and
not a second owner of destination pixels. Reading it with `getImageData` is
allowed. Reading the destination's presentation Canvas to recover bitmap state
is not.

Initially, existing Canvas text output may be copied as RGBA into the surface
to reduce migration risk. The preferred follow-up is to render white glyphs on
transparent black, interpret the alpha channel as a coverage mask, and apply
the DC's text semantics in the software compositor. A compatibility option may
threshold coverage for non-antialiased Win98-style text where appropriate.

Known limitations remain explicit: browser font availability, metrics,
hinting, shaping, and antialiasing can differ between Safari, Chromium, and
Node. These differences apply only to the Canvas fallback; FNT measurements
and pixels are deterministic across those hosts.

No Canvas-only text draw may leave the authoritative surface stale when that
surface can later be observed through GDI.

### High-fidelity Win98 text backend

The deterministic bitmap-font path is implemented in `10b-gdi-font.wat`
without changing GDI callers. `AddFontResourceA` reads NE `.FON` containers or
standalone FNT 2.x/3.x resources through the VFS boundary, validates their
tables, and copies accepted strikes into WAT-managed memory. `CreateFontA/W`
and `CreateFontIndirectA/W` bind the closest installed strike by face and
height. Measurement, metrics, `TextOutA`, and plain `ExtTextOutA/W` then use
the one-bit vertical-strip glyphs and write pixels through the canonical,
format-aware GDI raster path. Unsupported formats, shaped/scalable faces, and
rectangle-option text paths continue through the Canvas fallback.

The target selection order is:

1. An exact bitmap strike from a legally supplied Windows `.FON`/`.FNT` file.
2. A pre-generated monochrome strike from a bundled open substitute.
3. Deterministic monochrome rasterization of a bundled outline font.
4. Canvas text for faces, sizes, scripts, or shaping the deterministic backend
   does not support.

The project-native WAT loader understands NE `.FON` containers with one or
more RT_FONT resources as well as standalone `.FNT` files. Node and browsers
therefore consume the same validated bytes and integer raster algorithm.
FreeType remains a possible future dependency for PCF, BDF, outline fonts,
and broader font-table coverage.

For each face/size/weight/charset strike, cache:

```text
glyph bitmap (1 bpp)
A/B/C widths or left bearing + advance
ascent, descent, internal/external leading
average/max width, first/last/default/break character
character-set/code-page mapping
kerning pairs where the source supplies them
```

Font matching should reproduce the GDI inputs that affect `CreateFont` and
`LOGFONT`: face aliases, height versus cell height, width, weight, italic,
underline, strikeout, charset, pitch/family, escapement, and orientation.
Point sizes must use the em-height and device DPI rules rather than CSS pixels.
The stock `SYSTEM_FONT`, `DEFAULT_GUI_FONT`, `ANSI_FIXED_FONT`, and
`OEM_FIXED_FONT` objects should resolve to explicit configured strikes instead
of browser fallback chains.

Raster output should be monochrome by default for the Win98 look. Glyph origins
and advances are integers; `TA_UPDATECP`, alignment, inter-character spacing,
justification, tabs, opaque backgrounds, `ETO_CLIPPED`, and `ETO_OPAQUE` are
handled above the font provider. Complex scripts may remain on the Canvas path
until a shaping engine such as HarfBuzz is introduced.

Validation requires reference captures from an actual Win98 environment at
known DPI. Test `GetTextMetrics`, `GetTextExtentPoint32`, ABC widths, dialog
layout, menu widths, edit caret placement, underline/strikeout, and exact glyph
bitmaps for the stock UI and fixed fonts. Pixel hashes should match across
Safari, Chromium, and Node when the same deterministic strike is selected.

### Font sources and licensing

The repository already bundles two open substitutes:

- **W95FA** is an OFL-licensed recreation used for MS Sans Serif/Tahoma-like UI
  text. It is an outline/web font, not the original Microsoft bitmap strikes.
- **Fixedsys Excelsior** is reported as public domain and provides a strong
  Fixedsys-style fixed-pitch fallback. It is also distributed here as an
  outline font.

Both can be rasterized once at build time into bundled strike files for the
exact pixel sizes the emulator supports. Generated strikes remain subject to
the source font's license and attribution/renaming requirements. This makes
output deterministic, but it does not make their glyphs identical to
Microsoft's originals.

Other viable open bitmap sources include Terminus (SIL OFL, fixed pitch) and
GNU Unifont (SIL OFL or GPL with font exception, broad Unicode coverage). They
are useful fallbacks for terminal text and missing scripts, not close visual
substitutes for proportional MS Sans Serif.

Do not bundle original Microsoft `SSERIFE.FON`, `VGASYS.FON`, `VGAOEM.FON`,
Tahoma, Microsoft Sans Serif, or extracted bitmap strikes without a verified
redistribution license. Converting a proprietary font to BDF, PNG, or a custom
atlas does not remove its license restrictions. Exact original fonts should be
loaded only from user-provided files or from a licensed redistributable package.
Every bundled font or generated strike must have an upstream URL, version,
license text/SPDX identifier, checksum, and generation recipe recorded under
`fonts/`.

## Migration plan

### Phase 0: lock current behavior

- Add a Paint test for the brush and airbrush options panel. Verify the number,
  placement, selected border, and masks of all option glyphs.
- Add a diagonal-line assertion that permits only foreground and background
  colors. It must fail on intermediate antialiasing colors.
- Capture fixtures for rectangles, ellipses, curves, polygons, wide lines, and
  representative ROPs in Node and the browser harness.
- Preserve the existing all-tools, file round-trip, dirty-New, large-scroll,
  flood-fill, and airbrush-position tests.

### Phase 1: surface abstraction

- Add `GdiSurface` and make compatible bitmaps and DIB sections register one.
- Route `GetPixel`, `SetPixel`, solid fill, and clear operations through it.
- Retain the current Canvas as a presentation cache and compare pixels after
  every migrated operation in a debug dual-run mode.

Exit gate: migrated reads never call `CanvasRenderingContext2D.getImageData`
for authoritative bitmap content.

### Phase 2: blits and raster operations

- Move `BitBlt`, `StretchBlt`, `PatBlt`, mono expansion, and Paint's mask paths
  to surface-to-surface operations.
- Support overlap-safe self-blits and all currently exercised ROPs.
- Diagnose the Paint brush-options panel with exact source/destination surface
  dumps; fix it before declaring this phase complete.

Exit gate: Paint tool icons, option glyphs, palette, and selection masks pass
pixel fixtures in Node and browser tests.

### Phase 3: integer drawing primitives

- Migrate `MoveToEx`/`LineTo`, polyline, rectangle, polygon, ellipse,
  round-rectangle, arc, and Bezier calls.
- Add pen width/style and brush fill incrementally, driven by executable tests.
- Move flood fill to direct surface access and remove its Canvas readback.

Exit gate: Paint drawing contains no unintended intermediate colors, and the
same operation fixtures hash identically in Safari, Chromium, and Node.

### Phase 4: window and DirectDraw surfaces

- Make window backing stores authoritative software surfaces.
- Resolve transient, synthesized, and allocated HDCs through the same target
  model.
- Integrate DirectDraw `GetDC` without DIB-to-Canvas-to-DIB round trips.

Exit gate: GDI code reads no window or bitmap presentation Canvas for state.
Text may read only its temporary scratch Canvas before committing to the
authoritative surface.

### Phase 5: remove shadow synchronization

- Delete DIB hashes and Canvas-to-DIB conversion.
- Delete compatibility paths whose callers have migrated.
- Retain bounded presentation uploads without guest-write page tracking.
- Keep Canvas vector GDI fallbacks removed.

## Testing strategy

Use three layers:

- **Rasterizer unit tests:** small buffers with exact expected byte arrays for
  endpoints, clipping, orientation, stride, palette lookup, and ROP truth
  tables.
- **GDI API tests:** create/select surfaces through host imports and verify DC
  state, aliasing, deletion, overlapping blits, and dirty rectangles.
- **Executable tests:** Paint and other real binaries exercise operation
  sequences, resource masks, window invalidation, and presentation.

Cross-engine browser tests should compare logical surface pixels or PNG hashes,
not screenshots after CSS scaling. Safari remains an important presentation
check because it exposed the original Canvas geometry and coordinate
differences.

Reference fixtures should record their source and environment. Prefer captures
from an actual Win98 system or a documented compatible GDI implementation. Do
not encode Canvas output as the expected result for operations being migrated.

## Performance constraints

- Use typed-array loops over contiguous spans, not per-pixel object allocation.
- Specialize solid fills and common ROPs; bulk operations should dominate Paint
  workloads.
- Coalesce dirty rectangles and cap their count before falling back to a full
  surface upload.
- Keep the current direct guest-memory translation fast path. DIB stores need
  no instrumentation because the DIB bytes are canonical.
- Profile before moving code into WASM. JavaScript typed arrays may be adequate
  for normal Win98 resolutions; the surface contract should permit a later
  WASM rasterizer without changing callers.

## Risks

- Exact GDI semantics are broader than Paint. Metafiles, world transforms,
  geometric pens, palette realization, printer DCs, and uncommon ROPs cannot be
  treated as incidental variants.
- Native-format DIB writes complicate every primitive. A temporary RGBA
  authoritative buffer would be simpler but would recreate synchronization for
  guest-visible DIBs, so format adapters are required.
- Window-surface conversion changes invalidation and child-window clipping. It
  should follow bitmap migration, not lead it.
- Canvas text remains engine- and font-dependent. This is an accepted fidelity
  boundary, but text must still commit into authoritative surface storage.
- A software rasterizer can regress performance if it uploads whole canvases or
  uses generic per-pixel dispatch in hot loops.

## Non-goals

- Replacing the desktop/window compositor with a software framebuffer in the
  first migration.
- Implementing the entire documented Win32 GDI API before landing useful
  phases.
- Replacing Canvas font measurement, shaping, or glyph rasterization during
  this migration.
- Treating antialiasing removal alone as proof of GDI compatibility.
- Making raw `CreateDIBSection` stores immediately visible without an explicit
  GDI transfer or presentation operation.
