# Software GDI rasterizer design

## Status

Implementation started 2026-08-12. `lib/gdi-surface.js` provides native-format
canonical pixel access, palette handling, orientation/stride handling, solid
rectangles, RGBA extraction, and dirty-rectangle coalescing. DIB-backed memory
DCs use it for `GetPixel`, unclipped `SetPixel`, `FillRect`, and source-less
solid `BitBlt` operations (`BLACKNESS`, `WHITENESS`, and `PATCOPY`). Rectangle
clip regions are intersected in integer surface coordinates. Complex regions,
all geometric primitives, source blits, window surfaces, and text still use
the existing Canvas paths. Canvas text remains intentional policy, as
described below.

Rectangular HRGN ownership moved into WAT in the first architecture-boundary
milestone. WAT now allocates generation-tagged region handles and owns rectangle
normalization, mutation, offset, bounding-box queries, intersection, object
typing, and lifetime. Each record temporarily carries a private JS mirror for
Canvas-facing compatibility calls. Complex Boolean results are explicitly
tagged as legacy mirrors until WAT band storage replaces that fallback.

This document describes the incremental migration from Canvas 2D vector
drawing to deterministic software rasterization implemented primarily in WAT.
It does not propose replacing Canvas as the desktop compositor or presentation
API.

The immediate drivers are visible in Win98 Paint:

- Canvas vector paths antialias lines, curves, ellipses, and rounded corners.
  `imageSmoothingEnabled = false` affects scaled images, not `stroke()` or
  `fill()` rasterization, so output differs from classic integer GDI and can
  differ between browser engines.
- A `CreateDIBSection` currently has guest-visible bytes plus a Canvas shadow.
  Guest stores, host GDI operations, and presentation must keep the two copies
  synchronized. Dirty-page tracking improved this path, but the two-copy model
  remains more complex than necessary.
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
result is defined as raster pixels. Text is the deliberate exception: Canvas
remains the font-layout and glyph-rasterization backend for this redesign.
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
4. Every write marks a bounded dirty area. Guest CPU writes to DIB memory may
   initially provide page-level dirtiness; GDI operations provide rectangles.
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
clip. DirectDraw surface DCs should eventually resolve through the same
interface, while preserving the DirectDraw surface's native storage.

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

It does **not** remove dirty tracking. Guest stores still need to notify the
presentation cache that DIB bytes changed. The existing 4 KB DIB page states
can serve as the first implementation:

- `0`: free page;
- `1`: allocated and presentation-clean;
- `2`: guest-dirty.

When presenting a DIB, map dirty pages to affected row ranges, convert only
those rows, upload the resulting rectangles, and return the pages to clean.
GDI writes can mark exact dirty rectangles as well as the overlapping pages.
Later, a per-surface row/tile bitset can reduce overdraw for wide DIBs without
changing CPU-store instrumentation.

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
long-term form because fills, blits, and dirty tracking all consume spans.

The first migration slice handles unclipped and rectangularly clipped DIB
fills exactly. The next clipping milestone will add a WAT-owned canonical
band/span representation for rectangle combinations and rasterized
polygon/ellipse regions. Until then, complex regions remain on the named
Canvas compatibility path and are not treated as canonical software output.

## Presentation

Each surface maintains an optional Canvas presentation cache. Flushing a dirty
surface performs:

1. Coalesce dirty pages, rows, tiles, or rectangles.
2. Convert native pixels and palettes to RGBA for only those areas.
3. Upload without interpolation using `putImageData`, `ImageBitmap`, or an
   unscaled `drawImage` from a staging canvas.
4. Mark the uploaded areas clean.

The renderer then composes window caches onto the desktop Canvas as it does
today. Browser zoom or CSS scaling may affect display size but cannot change the
underlying GDI pixels.

Avoid reading the presentation Canvas in GDI code. Screen capture and desktop
composition may read the composed desktop, but bitmap/DC semantics must remain
surface-backed.

## Text

Canvas is the selected text backend for the initial software-GDI design. It
continues to provide font selection, fallback, shaping, kerning, measurement,
and glyph rasterization. Replacing it with a font engine or period-correct
bitmap fonts is outside the active migration plan.

Canvas must not bypass authoritative surface storage. Text operations use this
pipeline:

```text
TextOut/ExtTextOut/DrawText
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
Node. These differences are accepted for text during this redesign; geometric
primitives and bitmap operations must still be deterministic.

No Canvas-only text draw may leave the authoritative surface stale when that
surface can later be observed through GDI.

### Future high-fidelity Win98 text backend

After the surface migration is stable, an optional deterministic font backend
can replace Canvas for classic raster-font cases without changing any GDI
callers. The font backend returns glyph masks and metrics; the existing
software text compositor applies colors, clipping, background mode, and ROPs.

The target selection order is:

1. An exact bitmap strike from a legally supplied Windows `.FON`/`.FNT` file.
2. A pre-generated monochrome strike from a bundled open substitute.
3. Deterministic monochrome rasterization of a bundled outline font.
4. Canvas text for faces, sizes, scripts, or shaping the deterministic backend
   does not support.

The loader should understand NE `.FON` containers with one or more Windows FNT
resources as well as standalone `.FNT` files. FreeType is a viable future
dependency because it supports Windows FNT, PCF, BDF, and outline fonts and can
produce monochrome glyph bitmaps. A smaller project-native FNT parser is also
reasonable for the narrow Win98 UI-font use case. Font-file parsing and glyph
rasterization must run in WASM or shared JavaScript code so Node and browsers
consume the same strikes.

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
- Retain DIB page dirtiness and presentation uploads.
- Make Canvas vector GDI fallbacks opt-in diagnostics, then remove them as
  coverage reaches the supported API set.

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
not screenshots after CSS scaling. Safari must be included before removing a
Canvas fallback because it is the engine that exposed the current presentation
and coordinate issues.

Reference fixtures should record their source and environment. Prefer captures
from an actual Win98 system or a documented compatible GDI implementation. Do
not encode Canvas output as the expected result for operations being migrated.

## Performance constraints

- Use typed-array loops over contiguous spans, not per-pixel object allocation.
- Specialize solid fills and common ROPs; bulk operations should dominate Paint
  workloads.
- Coalesce dirty rectangles and cap their count before falling back to a full
  surface upload.
- Keep the current direct guest-memory translation fast path. DIB store
  instrumentation remains one range check plus page-state writes.
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
- Removing dirty tracking. The redesign removes competing pixel owners, not
  the need to know what changed.
