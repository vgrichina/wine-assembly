# Scalable font design

## Status

Design started 2026-08-14. Assets obtained; no runtime code written yet.

The deterministic Win9x **stock** font path is complete and pixel-exact: WAT
parses `.FON`/`.FNT` resources and blits one-bit glyph pixels directly onto the
canonical GDI surface for `System`, `MS Sans Serif`, `Fixedsys`, `Courier`, and
`Terminal` (see [`bitmap-font-review.md`](bitmap-font-review.md) and
[`../fonts/README.md`](../fonts/README.md)).

This document covers the faces that path does **not** cover: the scalable
TrueType faces a Win98 application names explicitly through
`CreateFontIndirectA`/`W`, `EnumFontFamiliesEx`, or a resource-script dialog
font. Today those fall through to `_buildCssFont` in `lib/host-imports.js`,
which emits a CSS family list naming the *host's* fonts:

```js
'arial': 'Arial, sans-serif', 'times new roman': '"Times New Roman", serif',
'verdana': 'Verdana, sans-serif'
```

That is non-deterministic by construction. On a machine with Microsoft's fonts
installed the metrics are right by accident; on a bare Linux CI box or a
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
| Tahoma Bold | `tahomabd.ttf` | 979 | outline only |
| Small Fonts | `small_fonts.ttf` | 516 | 11 ppem |
| Marlett | `marlett.ttf` | 39 | outline only |
| Symbol | `symbol.ttf` | 193 | outline only |
| Wingdings | `wingding.ttf` | 53 | outline only |
| Webdings | `webdings.ttf` | 10 | outline only |

Two findings matter here.

**Tahoma ships eight monochrome `EBDT` strikes covering 8–16 ppem** — exactly
the range Win98 dialogs and tooltips use. Those strikes can go through the
*existing* pixel-exact pipeline: `tools/gen-bitmap-fon.c` already extracts
embedded monochrome strikes with FreeType at `--bitmap-only --raster=exact`,
which is how `MSSansSerif.fon` is built. Tahoma at UI sizes is therefore a
bitmap-path face, not a Canvas face, and needs no new rasterizer.

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

## Rendering architecture

Three paths, in decreasing fidelity. The first two already exist; only the
third needs new substitution logic.

```
CreateFontIndirectA(face, height)
        │
        ├─ face has an .FON strike at this size?
        │     → WAT FNT blit onto canonical GDI surface        [PIXEL-EXACT]
        │       System, MS Sans Serif, Fixedsys, Courier, Terminal
        │
        ├─ face has an embedded EBDT strike at this ppem?
        │     → generate .FON at build time, same WAT blit      [PIXEL-EXACT]
        │       NEW: Tahoma 8-16, Small Fonts 11
        │
        └─ otherwise: scalable outline
              → gdi_text_mask() rasterizes into a one-bit mask  [APPROXIMATE]
                WAT converts mask bytes to retained path geometry
                and composites exact GDI text-color pixels
```

The third path's seam is already built: `gdi_text_mask` in
`lib/host-imports.js` renders into an offscreen alpha mask, thresholds coverage
to one bit, and hands bytes back to WAT. Canvas never touches the destination
surface and never creates a path. WAT owns layout, alignment, `charExtra`,
justification, and clipping. **Canvas is a glyph provider, not a text
renderer** — that boundary is already correct and this work does not move it.

What changes is only *which font file Canvas rasterizes from*.

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

### Rejected: a TrueType rasterizer in WAT

Parsing `glyf` outlines and scan-converting them in WAT is a large amount of
work and still would not be pixel-exact against Win98, because Win98 rendered
TrueType at UI sizes with **no antialiasing** and with Microsoft's hinting
applied — matching it means implementing the TrueType bytecode interpreter
(delta instructions, drop-out control, and the specific hinting programs in
fonts we cannot ship). The result would be an enormous effort that lands in the
same "approximate" bucket as the Canvas mask.

The pixel-exactness goal stays scoped to faces with real bitmap strikes, where
it is achievable and already achieved. For outline faces the goal is **metric
fidelity**, not pixel fidelity.

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

- **Browser** — `@font-face` blocks in `index.html` alongside the existing W95FA
  and Fixedsys Excelsior entries; `document.fonts.load()` must complete before
  the first guest paint, or early `measureText` calls silently use a fallback.
  This is a real ordering hazard and needs an explicit await in startup.
- **Node CLI** — `lib/canvas-compat.js` already exposes `registerFont` over
  `skia-canvas`'s `FontLibrary.use`, so the same files register by private
  family name.

Browser and Node still use different rasterizers, so Tier 3 *pixels* will
differ between them. Tier 1 and 2 *metrics* come from the font file and will
not. Tests that compare pixels must therefore continue to target the bitmap
paths; tests that compare layout can target all tiers.

## Web payload

The vendored TTFs are 4.2 MB (Liberation) + 2.3 MB (Wine). Shipping those raw
to the browser is unacceptable for a page that currently loads a ~200 KB
`w95fa.woff2`. The build must emit WOFF2 subsets — Win98 apps in the corpus are
Latin-1/CP1252, so subsetting to the Windows-1252 repertoire plus the box and
symbol ranges each face actually needs cuts this by roughly an order of
magnitude. The full TTFs stay in the repo as the pinned, reproducible source;
only subsets are deployed, generated by a build step next to
`tools/gen-wine-fonts.sh` and hash-pinned the same way.

Do not subset by hand or check in a subset without its generator — an
unreproducible font binary in `fonts/` is exactly the provenance problem the
rest of this directory is set up to avoid.

## Milestones

1. **Assets and manifest** — fonts vendored with pinned hashes and licenses
   (done for Tier 1 and 2); `fonts/substitutions.json` written; `fonts/README.md`
   and `fonts/wine/UPSTREAM.md` updated.
2. **Deterministic substitution** — `_buildCssFont` reads the manifest, private
   family names registered in both hosts, no host font ever named. Removes the
   `'arial': 'Arial, sans-serif'` class of fallback entirely.
3. **Tahoma bitmap strikes** — extend `tools/gen-wine-fonts.sh` to emit
   `Tahoma.fon` (8–16 ppem) and `SmallFonts.fon` (11 ppem); wire into the
   existing WAT strike table and `gdi_bitmap_font_best`. Pure win: moves the
   Win98 shell font onto the pixel-exact path.
4. **Metric reference** — v86 probe, pinned capture, comparison test.
5. **Enumeration** — `EnumFontFamiliesEx` reports substituted faces under their
   *Win98* names with correct `TEXTMETRIC` and charset, so apps that enumerate
   and pick by name find what they expect.
6. **Tier 3 on demand** — add faces only when a corpus binary requests one.

Milestones 2 and 3 are independent and can land in either order. Milestone 4
gates any claim of metric correctness.

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
