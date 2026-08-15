# Scalable font design

## Status

Design started 2026-08-14. Assets are committed, `fonts/substitutions.json` is
written, and `src/10c-truetype.wat` parses font tables and derives metrics:
table directory, `head`/`hhea`/`maxp`/`OS/2`/`post`, `hmtx` advances and
bearings, `cmap` formats 0/4/6 with the symbol-face `0xF000` bias, CP1252, the
full pixel `TEXTMETRIC` derivation, `loca`/`glyf` record bounds in both loca
formats, ABC widths, `kern` format 0, simple-glyph outline points, and
composite recursion with an explicit depth limit, 26.6 flattening, and nonzero
scan conversion into the FNT column-major bitmap layout.

A face registry and glyph cache sit on top: `$tt_face_open` loads a font from
the same virtual filesystem the `.FON` strikes come from, keyed by path hash
so a file opens once, and `$tt_face_glyph` returns a cached bitmap for a guest
ANSI byte. Storage is `$heap_alloc`, not a fixed region — font files run from
60 KB to 400 KB and the cache grows with what the guest draws, so a fixed
reservation would either waste a megabyte on a guest that never names a
scalable face or run out on one that does.

The GDI seam is now closed, and it turned out not to need a second renderer.
The bitmap-font path already owns everything a text call needs — layout,
alignment, clipping, colours, background modes, paths, `TA_UPDATECP`,
justification, `GetGlyphOutline` — and reaches all of it through one parsed
FNT image. So a scalable face is rasterized at one ppem into an FNT 3.00 image
and installed as an ordinary strike, and nothing downstream cares that the
glyphs came from an outline. That the glyph cache already stored bitmaps in
the FNT column-major bit layout is what made this a copy rather than a
conversion.

`$gdi_bitmap_font_selected` resolves a substituted face to that strike;
Canvas remains the fallback only for faces with no substitute. Strike records
carry a third state: 1 is an installed bitmap font, 2 is a rasterized
substitute, and face-and-nearest-height matching and font enumeration skip
state 2 so a substitute is reachable only through its exact
`(face, size, weight, italic)` key.

Face names resolve to the filenames a real `C:\WINDOWS\FONTS` held —
`ARIAL.TTF`, `TAHOMABD.TTF` — from a table in `src/10c-truetype.wat`. Which
vendored open font is mounted at each of those VFS paths is the host's
decision, recorded in `fonts/substitutions.json` under `win98Files` and applied
by `lib/font-substitutions.js` in both `test/run.js` and `host.js`. WAT
therefore carries no licensing knowledge and resolves faces exactly the way
the bundled `.FON` strikes already do.

A guest can also install a scalable font of its own. `AddFontResourceA` tries
the bitmap-strike loader first and, when the file carries no strikes, registers
it in a small mutable table beside the substitution one — keyed by the family
name read out of the file's `name` table, because the guest installs
`ARIALBD.TTF` by path and then asks for that family in bold, and only the name
table connects the two. Registered entries are consulted *before* the
substitution table: a guest that ships its own copy of a face means that copy.
Style is scored rather than indexed, since registered files arrive one at a
time in any order — weight is worth more than slant, the way the Windows font
mapper scored it (a weight mismatch cost `|requested - actual| / 5`, so 60
points from bold to regular, against a flat 4 for the wrong slant).

This is what `fontview.exe` needs. It tests the `AddFontResourceA` return
value and destroys its own window without painting when it is zero, so while a
`.TTF` was rejected by the bitmap loader and the call returned "no fonts
added", the file it was launched on never appeared.

Two limits worth stating rather than discovering later. An FNT cell width is
the advance, so ink that overhangs the advance is clipped, the same way a
bitmap font clips it. And a face with no italic file falls back to its upright
file rather than being synthetically sheared.

The entry points a caller needs, all in `src/10c-truetype.wat`:

```
$tt_face_open(path_guest)              -> face index, or -1
$tt_face_ppem(face, lfHeight)          -> ppem, both lfHeight conventions
$tt_face_metric(face, ppem, field)     -> TEXTMETRIC field 0..11
$tt_face_text_width(face, text, n, ppem)
$tt_face_char_width(face, byte, ppem)
$tt_face_glyph(face, byte, ppem)       -> cache entry, or 0
$tt_entry_width/height/left/top/pixel(entry, ...)

$tt_family_name(data, size, out, max)  -> family name length, or 0
$tt_reg_add(path_guest)                -> 1 when installed, else 0
$tt_reg_remove(path_guest)
$tt_reg_path(name, weight, italic)     -> registered font path, or 0

$tt_subst_path(name, weight, italic)   -> registered or Win98 font path, or 0
$tt_face_for_logfont(name, weight, italic)
$tt_strike_ensure(name, lfHeight, weight, italic)
                                       -> installed strike record, or 0
```

`$tt_strike_ensure` is the one the GDI layer actually calls; everything above
it is reachable for tests and for callers that want metrics without a strike.

The end state is **no Canvas text at all**: WAT parses TrueType
files, owns metrics, and rasterizes glyphs onto the canonical GDI surface, the
same way it already does for `.FON` strikes. JavaScript keeps only the
canonical-surface-to-screen blit, which is presentation, not logic.

The deterministic Win9x **stock** font path is complete and pixel-exact: WAT
parses `.FON`/`.FNT` resources and blits one-bit glyph pixels directly onto the
canonical GDI surface for `System`, `MS Sans Serif`, `Fixedsys`, `Courier`, and
`Terminal` (see [`bitmap-font-review.md`](bitmap-font-review.md) and
[`../fonts/README.md`](../fonts/README.md)).

This document covers the faces that path does **not** cover: the scalable
TrueType faces a Win98 application names explicitly through
`CreateFontIndirectA`/`W`, `EnumFontFamiliesEx`, or a resource-script dialog
font. Those with a vendored substitute are now rasterized in WAT; those without
one still fall through to `_buildCssFont` in `lib/host-imports.js`, which emits
a CSS family list naming the *host's* fonts:

```js
'arial': 'Arial, sans-serif', 'times new roman': '"Times New Roman", serif',
'verdana': 'Verdana, sans-serif'
```

That is non-deterministic by construction, and it is why the substituted faces
were moved off it first. On a machine with Microsoft's fonts installed the
metrics are right by accident; on a bare Linux CI box or a
locked-down browser the fallback is whatever the platform picks, and
`GetTextExtentPoint32A` returns widths the guest never saw on Win98. Dialog
layout, `DrawText` wrapping, caret placement, and RichEdit line breaking all
consume those widths, so the failure surfaces as mis-laid-out UI long before
anyone notices the glyph shapes differ.

## Native Windows 98 inventory

Retail Win98/98SE `\WINDOWS\FONTS`, TrueType only. Raster (`.FON`) and vector
(`MODERN`/`ROMAN`/`SCRIPT`) faces are out of scope here; see
"Vector fonts" below.

| Face | Files | Notes |
|---|---|---|
| Arial | `arial`, `arialbd`, `ariali`, `arialbi` | |
| Times New Roman | `times`, `timesbd`, `timesi`, `timesbi` | |
| Courier New | `cour`, `courbd`, `couri`, `courbi` | |
| Tahoma | `tahoma`, `tahomabd` | Win98 shell/tooltip font |
| Verdana | 4 styles | bundled IE4 |
| Comic Sans MS | `comic`, `comicbd` | |
| Impact | `impact` | |
| Lucida Console | `lucon` | |
| Lucida Sans Unicode | `l_10646` | |
| Microsoft Sans Serif | `micross` | outline form of MS Sans Serif |
| Symbol | `symbol` | |
| Wingdings | `wingding` | |
| Webdings | `webdings` | bundled IE4 |
| Marlett | `marlett` | hidden; title-bar and checkbox glyphs |

Georgia, Trebuchet MS, Arial Black, and Andale Mono were **not** Win98
defaults. They arrived with Plus!, the Core Fonts for the Web pack, or IE font
downloads. Presence of the IE4-bundled rows (Verdana, Webdings, Comic Sans)
varies slightly by edition and OSR.

The exact per-edition inventory must be confirmed against a real image before
any of this is asserted in a test; the v86 harness in `tools/v86-reference/`
already has a `font-inventory` probe
(`tools/v86-reference/font-apps.json`) that enumerates installed faces from
inside Win98, and that is the authority.

## Substitution policy

Original Microsoft font binaries are not redistributable and are never
committed. Every face is served by an open substitute, chosen in this order of
preference:

1. **Metric-compatible substitute** — identical advance widths and identical
   `TEXTMETRIC` derivation, different outlines. Layout is exactly right;
   glyph shapes differ. This is the only tier that makes guest layout math
   correct, and it is what matters.
2. **Wine's own Win9x substitute** — already a project dependency, designed
   for precisely this role, LGPL-2.1-or-later.
3. **Visual approximation** — documented as an approximation, not silently
   passed off as the real face.

No tier claims to reproduce Microsoft glyph artwork.

### Tier 1 — metric-compatible

| Win98 face | Substitute | License | Where |
|---|---|---|---|
| Arial | Liberation Sans | OFL 1.1 | `fonts/liberation/` |
| Times New Roman | Liberation Serif | OFL 1.1 | `fonts/liberation/` |
| Courier New | Liberation Mono | OFL 1.1 | `fonts/liberation/` |

Liberation 2.1.5 is the Croscore-rebased generation, so Arimo/Tinos/Cousine
are the same designs under Apache-2.0 if a license change is ever wanted. All
four styles (regular, bold, italic, bold-italic) are present for each family,
so synthetic obliquing and emboldening are never needed for these faces.

### Tier 2 — Wine substitutes

Fetched from the same pinned Wine commit already used for the bitmap stock
fonts (`ab0b3e2526827110319ea8d0b8a738e629e9472b`).

| Win98 face | Wine file | Glyphs | Embedded strikes |
|---|---|---:|---|
| Tahoma | `tahoma.ttf` | 988 | **8, 9, 10, 11, 12, 13, 15, 16 ppem** |
| Tahoma Bold | `tahomabd.ttf` | 979 | **9, 10, 11, 12, 13, 15, 16 ppem** |
| Small Fonts | `small_fonts.ttf` | 516 | 11 ppem |
| Marlett | `marlett.ttf` | 39 | outline only |
| Symbol | `symbol.ttf` | 193 | outline only |
| Wingdings | `wingding.ttf` | 53 | outline only |
| Webdings | `webdings.ttf` | 10 | outline only |

Two findings matter here.

**Tahoma ships eight monochrome `EBDT` strikes covering 8–16 ppem, and Tahoma
Bold ships seven covering 9–16** — exactly the range Win98 dialogs and
tooltips use. (An earlier revision of this table said Tahoma Bold was outline
only; that was wrong, and `fonts/Tahoma*.fon` are built from its strikes.)
Those strikes go through the *existing* pixel-exact pipeline:
`tools/gen-bitmap-fon.c` extracts embedded monochrome strikes with FreeType at
`--bitmap-only --raster=exact`, which is how `MSSansSerif.fon` is built.
Tahoma at UI sizes is therefore a bitmap-path face, not a Canvas face, and
needs no new rasterizer.

**Wingdings (53 glyphs) and Webdings (10) are heavily partial.** Wine only drew
what Wine needed. Treat them as Tier 3 approximations with known holes; a guest
asking for a codepoint Wine never drew gets `.notdef`. Symbol at 193 glyphs is
effectively complete for the Win98 Symbol repertoire, and Marlett at 39 covers
its full ~30-glyph set.

### Tier 3 — approximation, no metric-compatible clone exists

| Win98 face | Closest open option | Caveat |
|---|---|---|
| Verdana | DejaVu Sans | related lineage, different metrics |
| Lucida Console | DejaVu Sans Mono | different metrics |
| Lucida Sans Unicode | DejaVu Sans | different metrics |
| Comic Sans MS | Comic Relief | metric-compatible but GPL+FE — license review needed before vendoring |
| Impact | Anton | visual only |
| Wingdings / Webdings | Wine partials above | incomplete repertoire |

None of these are vendored yet. Each should be added only when a corpus
application actually names the face — the license and size cost is real, and an
unused font in `fonts/` is a liability, not a feature.

## Font format scope

**TrueType `glyf` outlines only.** CFF/Type2 (`.otf`) is explicitly out of
scope, and this is a faithfulness decision rather than a shortcut: Windows 98
GDI rasterized TrueType natively and had no CFF rasterizer. Type 1 worked only
when Adobe Type Manager was installed; native Type 1 and OpenType/CFF support
arrived in Windows 2000. Supporting exactly `glyf` *is* the Win98 behavior.

Every font vendored for this effort is `glyf`-based. `W95FA.otf` is CFF, but it
exists only for the emulator shell's own CSS and never enters the GDI path, so
nothing needs converting.

The TrueType bytecode interpreter is a separate question from the format and is
addressed under "Hinting" below.

## Rendering architecture

Everything converges on one contract that already exists in
`src/10b-gdi-font.wat`:

```
$gdi_bitmap_font_glyph_pixel(strike, glyph_offset,
                             native_w, native_h, x, y) -> 0 | 1
```

Every consumer above it — layout, measurement, tab stops, ellipsification, path
recording, ROP composite, `GetGlyphOutline` — reads only that. **Any producer of
a one-bit glyph bitmap plus bearings plugs into the entire existing text stack
unchanged.** That is what makes removing Canvas tractable: the work is a new
glyph *producer*, not a new text pipeline.

```
CreateFontIndirectA(face, height)
        │
        ├─ .FON strike installed at this size?
        │     → WAT FNT blit onto canonical GDI surface
        │       System, MS Sans Serif, Fixedsys, Courier, Terminal
        │
        ├─ embedded EBDT strike at this ppem?
        │     → build-time .FON, same WAT blit
        │       Tahoma 8-16, Small Fonts 11
        │
        ├─ outline face at a hinted ladder size (8-20 ppem)?
        │     → build-time FreeType-hinted .FON, same WAT blit
        │       Liberation Sans / Serif / Mono
        │
        └─ otherwise: outline, large / rotated / sheared / arbitrary
              → WAT TrueType scan converter -> cached one-bit glyph
                -> same WAT blit
```

Advance widths come from `hmtx` on **every** path, never from a strike's own
metrics. If the two disagree, text visibly re-flows as it crosses the ladder
boundary; a single metric source is what prevents that.

Canvas appears nowhere in this diagram. `gdi_text_mask` in
`lib/host-imports.js` is deleted at the end of the sequence below.

### Font substitution must be data, not a hardcoded CSS string

`_buildCssFont`'s `faceMap` is replaced by a substitution table driven from a
manifest so that the browser `@font-face` block, the Node
`FontLibrary.use` registration, and the WAT-side `EnumFontFamiliesEx` inventory
cannot drift apart. A single `fonts/substitutions.json` naming, per Win98 face:
the substitute family, its files by style, its tier, and whether a bitmap
strike path applies.

The registered CSS family names must be **private** (e.g.
`"WA Arial"`), never `"Arial"`. Naming the family `Arial` invites the host's
real Arial to win the cascade on some machines and lose on others — which is
the exact non-determinism being removed. An explicit private name means the
bundled file is the only thing that can ever match.

### The WAT TrueType rasterizer

An earlier revision of this document rejected a WAT rasterizer on the grounds
that it would still not be pixel-exact against Win98. That criterion does not
discriminate: the Canvas mask is not pixel-exact either, so it cannot decide
between them. The criteria that do discriminate are determinism and WAT
ownership, and the rasterizer wins both. Pixel-exactness against Win98 is
unavailable for outline faces regardless of who rasterizes, because Win98
applied Microsoft's own hinting programs from fonts that cannot be shipped.

Structure:

**Table parse.** SFNT is big-endian, so byte-swapping loads are the base layer;
the rest is offset arithmetic.

```
head  unitsPerEm, indexToLocFormat, bounding box
hhea  ascender, descender, lineGap, numberOfHMetrics
hmtx  advanceWidth[gid], lsb[gid]            <- the metric authority
maxp  numGlyphs
loca  glyph offsets, short or long per head
glyf  outlines
cmap  format 4 (BMP), format 0/6, (3,0) symbol with the 0xF000 bias
OS/2  sTypoAscender, usWinAscent, sxHeight, sCapHeight, panose, codepage ranges
kern  format 0, for GetKerningPairs
```

**Character mapping** is the fiddly part, not the table walk. Guest text arrives
as CP1252, OEM, or Symbol bytes and must reach a glyph index through
codepage to Unicode to `cmap`. CP437 already exists for Terminal; CP1252 adds 27
mappings in `0x80-0x9F`. Symbol faces bypass Unicode through the `(3,0)` cmap.

**Outline extraction.** Simple glyphs are `endPtsOfContours`, an instruction
block that is skipped, run-length-encoded flags, and delta-8 / same-as-previous
/ delta-16 coordinates. Composite glyphs recurse over components with
`ARGS_ARE_XY_VALUES` offsets or point-matching plus an optional 2x2 transform;
the recursion needs an explicit depth limit.

**Transform** in 26.6 fixed point, with `scale = (ppem << 6) / unitsPerEm`
folded together with `lfEscapement` rotation and any synthetic italic shear
into a single 2x2 matrix. Rotated text becomes *easier* here than under Canvas,
which has no equivalent of GDI's escapement semantics.

**Flattening.** TrueType quadratics store on- and off-curve points with implied
on-curve midpoints between consecutive off-curve points; those must be
reconstructed before subdivision. Fixed subdivision is adequate at UI sizes;
adaptive subdivision by control-polygon deviation is only needed for large text.

**Scan conversion**, nonzero winding. Two candidate rules:

- pixel-center sampling with drop-out control, which is what GDI's
  non-antialiased scan converter does and what the TrueType specification
  describes; it emits one bit directly but the drop-out rules are intricate;
- signed-area cell accumulation, producing 8-bit coverage that is thresholded at
  50 percent, which sidesteps most drop-out handling and leaves real
  antialiasing available if the Win98 "smooth edges of screen fonts" option is
  ever emulated.

Prefer the cell accumulator for that second reason.

**Cache.** Required, not an optimization. Key on face, glyph index, ppem,
matrix, and synthesis flags; store the bitmap in the *same column-major layout*
`$gdi_bitmap_font_glyph_pixel` already reads. A cached glyph is then
indistinguishable from an FNT glyph to every caller, and rasterization happens
once per glyph and size rather than per `TextOut`.

### Hinting, without a bytecode interpreter

Unhinted outlines at 8 to 12 ppem look poor in one bit, which is exactly where
TrueType hinting earns its keep. Implementing the bytecode interpreter in WAT
is still rejected: it is a large virtual machine whose whole purpose is running
hinting programs from fonts this project cannot ship.

It is also unnecessary, because `tools/gen-bitmap-fon.c` already links FreeType
at build time. Extend it to *rasterize outlines* across a fixed ppem ladder with
FreeType's hinter and emit `.FON` strikes, exactly as it already emits strikes
extracted from Wine's bitmaps. Small text then gets real hinting through the
existing exact blit, the WAT scan converter only handles sizes where hinting
stops mattering, and FreeType remains a build-time tool that is never linked
into the emulator.

The ladder must be bounded — faces times sizes times styles multiplies quickly.
Start at 8-20 ppem for the Tier 1 faces only, driven by what the corpus
actually requests.

### Vector fonts

`MODERN.FON`, `ROMAN.FON`, `SCRIPT.FON` are stroke fonts — polylines drawn with
the current pen, not filled outlines, sharing the `.FON` container with the
bitmap faces (`dfType` bit 0 distinguishes them). They are Windows 1.x-era
holdovers used by plotter and CAD-style code. No corpus application is known to
request one. **Out of scope**; revisit only if a real binary asks. If one does,
the implementation is a stroke-path walker in WAT feeding the existing path
geometry — closer to the line-drawing code than to the font code.

## Metric fidelity and how it gets verified

Metric compatibility is the whole point of Tier 1, so it must be *measured*,
not assumed. The project already has the instrument: `tools/v86-reference/`
runs real Windows 98 under v86 and captures probe output, and
`probes/font-inventory.c` already reports native font data.

Plan:

1. Extend the probe (or add a sibling) to emit, for each Tier 1 and Tier 2
   face, at each of a fixed size ladder: the full `TEXTMETRIC`, per-character
   `GetCharWidth32` for `0x20..0x7E`, and `GetTextExtentPoint32` for a fixed
   set of strings including the ones real dialogs use.
2. Check the capture in as a pinned reference JSON, as the Paint pixel
   comparison already does.
3. Add a test asserting the emulator's own `GetTextExtentPoint32A` /
   `GetTextMetricsA` match that reference within a stated tolerance — exact for
   advance widths, and an explicit documented tolerance for anything derived
   from rasterization.

An assertion that "Liberation is metric-compatible with Arial" is a claim about
Red Hat's design intent until this test exists. Until then the doc says only
that it is *designed* to be, and the test is a required deliverable, not a
nice-to-have.

Known risk: metric compatibility is defined at the *font design* level (advance
widths in font units). Win98 GDI's integer rounding of those widths at a given
ppem, with its own hinting, may still differ by a pixel at some sizes. The
reference capture is what tells us where, and whether it matters.

## Determinism across hosts

Once text leaves Canvas, host determinism stops being a property that has to be
arranged and becomes structural: the same font bytes go through the same WAT
code and produce the same pixels in the browser, in the Node CLI, and in CI.
Browser and Node use different Canvas rasterizers, so any text that still goes
through `gdi_text_mask` can differ between them — which is a correctness reason
to finish the removal, not merely a philosophical one.

Until milestone 4 lands, the interim substitution path must still avoid naming
host fonts:

- **Browser** — `@font-face` blocks in `index.html` alongside the existing W95FA
  and Fixedsys Excelsior entries; `document.fonts.load()` must complete before
  the first guest paint, or early `measureText` calls silently use a fallback.
  This is a real ordering hazard and needs an explicit await in startup.
- **Node CLI** — `lib/canvas-compat.js` already exposes `registerFont` over
  `skia-canvas`'s `FontLibrary.use`, so the same files register by private
  family name.

Both hosts' font registration is deleted along with `gdi_text_mask`.

## Web payload

The vendored TTFs are 4.2 MB (Liberation) + 2.3 MB (Wine). Shipping those raw
to the browser is unacceptable for a page that currently loads a ~200 KB
`w95fa.woff2`. The build must emit **subset TTFs** — Win98 apps in the corpus
are CP1252/OEM, so subsetting to the Windows-1252 repertoire plus the box and
symbol ranges each face actually needs cuts this by roughly an order of
magnitude, and the same subsets shrink the resident WASM memory arena.

Deliberately **not** WOFF2: the emulator loads font bytes into linear memory and
parses them in WAT, so a Brotli-compressed container would require a decoder
inside the emulator to buy something HTTP transport compression already
provides for free. Subset TTF is both the wire format and the in-memory format.

The same reasoning retires the `@font-face` and `FontLibrary.use` registrations
entirely once milestone 4 lands — the browser never needs to know these fonts
exist. Only the emulator does.

The full TTFs stay in the repo as the pinned, reproducible source; only subsets
are deployed, generated by a build step next to `tools/gen-wine-fonts.sh` and
hash-pinned the same way. Do not subset by hand or check in a subset without its
generator — an unreproducible font binary in `fonts/` is exactly the provenance
problem the rest of this directory is set up to avoid.

## Milestones

Ordered so that each one is independently useful and the Canvas dependency
shrinks monotonically.

0. **Assets and manifest** — fonts vendored with pinned hashes and licenses
   (done, commit `3ebdf08`); `fonts/substitutions.json` written and checked by
   `test/test-font-substitutions.js` (done); `fonts/README.md` and
   `fonts/wine/UPSTREAM.md` updated (done).

1. **Metrics in WAT — no rasterizer.** Parse `head`/`hhea`/`hmtx`/`maxp`/`cmap`/
   `OS/2`, add the codepage tables, and serve `GetTextExtentPoint32`,
   `GetCharWidth32`, `GetTextMetrics`, and `GetTextFace` from the font file.
   Parsing, CP1252, `TEXTMETRIC` derivation, face selection, and the strike
   the public handlers measure from are done in `src/10c-truetype.wat` and
   `src/10b-gdi-font.wat`. The handlers reach the font through the installed
   strike rather than calling `$tt_face_*` directly, which is why they needed
   no change. CP437 is deliberately left out — the faces that need it are bitmap
   strikes on the `.FON` path, and no scalable face is requested with
   `OEM_CHARSET` yet.
   **Start here regardless of whether the rasterizer is ever built.** It is
   independent of rendering, it is exact rather than approximate, it makes
   Liberation's metric compatibility real instead of aspirational, and it fixes
   the layout, wrapping, and caret bugs that actually bite. Canvas keeps
   producing glyph pixels in the meantime. Roughly 800-1200 lines of WAT.

2. **Bitmap strikes** — `Tahoma.fon` (8-16 ppem), `TahomaBold.fon` (9-16, with
   `dfWeight` 700), and `SmallFonts.fon` (11 ppem) are generated from the
   embedded EBDT strikes and checked by `test/test-generated-wine-fonts.js`
   (done). Still to do: extend `tools/gen-bitmap-fon.c` to rasterize the Tier 1
   outlines across the hinted ladder, and install these three files at startup
   the way the other five are — nothing selects them at runtime yet. Less
   urgent than it was: a face with no installed strike is now rasterized on
   demand rather than falling to Canvas, so the ladder buys pixel-exactness at
   UI sizes rather than buying determinism, which is already won.

3. **Interim deterministic substitution** — `_buildCssFont` reads the manifest
   and uses private family names, so whatever text still reaches Canvas stops
   depending on host fonts. **Dropped**, which is what it was always for: it
   was insurance against milestone 4 taking a long time, and milestone 4 has
   landed. The text still reaching Canvas is exactly the set of faces with no
   substitute, and giving those private family names would not make them
   deterministic — nothing is mounted to be private about.

4. **WAT rasterizer** — `glyf` parse, transform, flatten, scan-convert, cache
   (done). A substituted face is rasterized into an FNT 3.00 image and
   installed as an ordinary strike, so it renders through the existing bitmap
   text path; `test/test-wat-gdi-scalable-text.js` gates that `gdi_text_mask`
   is not called for a face WAT can rasterize. Still to do: delete
   `gdi_text_mask` and both hosts' font registration once the corpus renders
   without it — the fallback is still load-bearing for unsubstituted faces
   such as Verdana, so deleting it now would lose text rather than lose
   Canvas.

5. **Metric reference** — v86 probe, pinned capture, comparison test. Gates any
   claim of metric correctness; can run against milestone 1 immediately.

6. **API completion** — `GetGlyphOutline` `GGO_NATIVE`/`GGO_BEZIER` (nearly free
   once `glyf` is parsed, and currently a documented gap in
   `software-gdi-design.md`), `GetCharABCWidths` from `hmtx` lsb plus glyph
   `xMax`, `GetKerningPairs` from `kern`, synthetic bold by outline embolden,
   synthetic italic by shear. The ABC and `kern` computations exist in
   `src/10c-truetype.wat`; the handlers that would expose them do not, and
   both wait on the same arena milestone 1 waits on. `kern` is read rather
   than GPOS on purpose: Win98 GDI had no OpenType layout engine, so a face
   that kerns only through GPOS must kern nothing here too.

7. **Enumeration** — `EnumFontFamiliesEx` reports substituted faces under their
   *Win98* names with correct `TEXTMETRIC` and charset, so apps that enumerate
   and pick by name find what they expect.

8. **Tier 3 on demand** — add faces only when a corpus binary requests one.

## Definition of done

The milestones describe the work; these are the conditions that decide whether
it is finished.

1. `gdi_text_mask` in `lib/host-imports.js` is deleted.
2. The `@font-face` blocks in `index.html` and the `registerFont` calls in
   `lib/canvas-compat.js` are deleted for every GDI face. The host never learns
   these fonts exist.
3. `_buildCssFont` and its `faceMap` are gone. No code path names a host font.
4. Every text-drawing binary in `test/binaries/` still renders, verified by a
   CLI run and a PNG, with no new `crash_unimplemented`.
5. The v86 metric comparison described above exists and passes.

Milestone 1 is deliberately useful on its own. If the effort stops after
metrics land in the public API, the layout, wrapping, and caret bugs are fixed
and the remaining gap is appearance rather than correctness.

## Verification

Each slice adds its own test and re-runs these:

```sh
bash tools/build.sh
node test/test-wat-truetype-metrics.js
node test/test-font-substitutions.js
node test/test-generated-wine-fonts.js
node test/test-wat-gdi-bitmap-text-compat.js
node test/run.js --exe=test/binaries/notepad.exe --max-batches=40
```

## Cost and risk

Milestones 1 and 4 together are roughly 4000 lines of WAT, comparable to the
existing `src/10b-gdi-font.wat`.

- **Memory** — Liberation Sans alone is 410 KB and several faces may be resident
  alongside a glyph cache. This needs a dedicated arena and a
  [`memory-map.md`](memory-map.md) entry. Build-time subsetting to the CP1252
  repertoire cuts the resident cost substantially and is shared with the WOFF2
  subsetting described above.
- **Performance** — bounded by the glyph cache; rasterization is once per glyph
  and size, not once per `TextOut`. Without the cache this path would be far
  slower than Canvas.
- **Unhinted appearance** — mitigated by the build-time hinted ladder, not by
  the rasterizer. If the ladder is ever bypassed, small text quality regresses
  visibly and that will read as a rasterizer bug when it is not.
- **Character mapping breadth** — codepages and `cmap` subtable formats are
  where unbounded scope hides. Implement CP1252, CP437, and Symbol; add others
  only when a corpus binary needs them.

## Coordination

`messageboard.txt` shows an active `GDI-SCALABLE-LAYOUT` effort routing scalable
`DrawText` through WAT layout with `TextOut` glyph-provider calls, and removing
the semantic `gdi_draw_text` JS bridge. That work owns the *layout* half of the
same seam this document's milestone 2 touches on the *font selection* half.
Sequence them: substitution can land under whatever provider interface that
effort settles on, and should not fork it.

## Licensing

| Asset | License | Text |
|---|---|---|
| Liberation 2.1.5 | SIL OFL 1.1 | `fonts/liberation/LICENSE` |
| Wine fonts | LGPL-2.1-or-later | `fonts/Wine-LGPL-2.1.txt` |
| ANAKRON v0.3.3 | SIL OFL 1.1 | `fonts/ANAKRON-OFL.txt` |
| W95FA | SIL OFL 1.1 | `fonts/W95FA-OFL.txt` |
| Fixedsys Excelsior 3.02 | public domain | — |

Microsoft `.FON`/`.FNT`/`.TTF` binaries must not be committed. Users may supply
their own Win98 font files locally for exact comparison.
