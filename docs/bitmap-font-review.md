# Win9x bitmap font review

Status: decision implemented for the deterministic GDI stock-font path on
2026-08-14.

## Decision

Use the native 8x12 bitmap from
[ANAKRON v0.3.3](https://github.com/molarmanful/ANAKRON/releases/tag/v0.3.3)
as the open substitute for the Win98 `Terminal` face and `OEM_FIXED_FONT`.
Generate a resource named `Terminal.fon`, map its byte slots through IBM code
page 437, and render it entirely on the WAT-owned GDI pixel surface.

Do not synthesize bold or italic bitmap strikes. ANAKRON has one deliberately
heavy regular design and no separate bold or italic source. The stock
`OEM_FIXED_FONT` object requests weight 400 with italic disabled, so additional
styles are not required for that compatibility role.

This is a compatible open substitute, not a claim that ANAKRON reproduces the
Microsoft Terminal glyph artwork exactly.

## Requirements

The target was narrower than finding a generally good programming font:

- match the native Win98 `OEM_FIXED_FONT` cell of 8x12;
- preserve integer, one-bit pixels without antialiasing;
- cover DOS/OEM byte values and connected box drawing;
- have a clear redistribution and modification license;
- work in Node and browsers without platform font installation;
- render through WAT into the canonical GDI surface, without Canvas text;
- remain reproducible from a pinned source file;
- avoid poor synthetic bold and italic transforms.

The native reference inventory is recorded in
[`tools/v86-reference/SOURCES.md`](../tools/v86-reference/SOURCES.md):

| Stock object | Native Win98 face | Cell |
|---|---|---:|
| `ANSI_FIXED_FONT` | Courier | 8x13 |
| `OEM_FIXED_FONT` | Terminal | 8x12 |
| `SYSTEM_FIXED_FONT` | Fixedsys | 8x15 |
| `SYSTEM_FONT` | System | 7x16 |

The comparison used native Win98 captures for metrics and appearance, direct
inspection of source font tables, 4x nearest-neighbor sample sheets, and exact
FNT/BDF byte and glyph checks. The upscaling was presentation-only; candidate
pixels were never filtered.

### Native reference provenance

The font-reference executable was not downloaded from an unknown binary
collection. The harness builds `FONTREF.EXE` locally from the tracked
[`font-inventory.c`](../tools/v86-reference/probes/font-inventory.c) source
with Zig's Windows headers, places it on the generated `D:` ISO, and runs it in
the pinned v86 Windows 98 profile described by
[`tools/v86-reference/SOURCES.md`](../tools/v86-reference/SOURCES.md). The
tracked [`font-apps.json`](../tools/v86-reference/font-apps.json) manifest
records the build source, guest filename, launch command, waits, and page-input
sequence.

Neither `FONTREF.EXE` nor the proprietary Windows disk/state is committed. The
probe merely calls native GDI (`GetStockObject`, `GetTextFaceA`,
`GetTextMetricsA`, `EnumFontFamiliesA`, and `CreateFontA`) and paints the
results for capture. Thus the native metrics are measurements of the documented
VM profile, while every probe instruction remains reviewable in this repo.

## Results at a glance

| Candidate | Native bitmap sizes relevant here | Styles | License finding | Result |
|---|---|---|---|---|
| Microsoft Win98 Terminal | 8x12 stock reference | native system resource | proprietary Windows asset | reference only |
| Wine bitmap fonts | System, MS Sans Serif, Fixedsys, Courier strikes | face-dependent | LGPL-2.1-or-later | retained for their matching stock roles; no Terminal strike |
| ReactOS `vgaoem.fon` | Terminal 8x12 | regular | derived from XFree `vga.bdf`; provenance is less self-contained than ANAKRON's OFL release | technically exact role/format, not selected |
| unix4lyfe CP437 | 6x8, 8x8, 8x12 | regular | copyright notice but no explicit redistribution license found | rejected for bundling |
| ANAKRON v0.3.3 | 8x12 | one regular, intentionally heavy design | OFL-1.1 | selected |
| KakwaFont | 6x12 | real regular and bold | OFL-1.1 | good style design, wrong width |
| Terminus 4.49.1 | 6x12, then 8x14 and larger | bold begins at 8x14; no designed italic | OFL-1.1 for the font | good terminal family, no 8x12 strike |
| W95FA | scalable outline | regular | OFL-1.1 | useful CSS/UI fallback, poor small OEM raster target |
| Fixedsys Excelsior | scalable outline | regular | upstream reports public domain | wrong face and outline behavior for Terminal |
| ReactOS scalable substitutes | mainly TTF outlines, including UniVGA16 and FSEX301 | varies | per-font/open-project lineage | useful references, not the chosen 8x12 bitmap |

## Candidate notes

### Native Microsoft fonts

The Windows 98 VM remains the authority for stock selection, cell metrics, and
appearance. It reports Terminal 8x12 for `OEM_FIXED_FONT`. Original Windows
`.FON` files and extracted glyph atlases are not redistributable merely because
they have been converted to BDF, PNG, or another container. They remain local
reference material unless a separate license grants redistribution.

### Wine

Wine supplies open System, MS Sans Serif, Fixedsys, and Courier sources with
embedded monochrome bitmap strikes. Those pixels are a strong fit for their
corresponding Win9x stock roles and are already used by this repository. Wine
does not currently supply a distinct Terminal 8x12 strike, which was the one
remaining western stock-font gap.

The pinned sources, checksums, and Wine commit are documented in
[`fonts/wine/UPSTREAM.md`](../fonts/wine/UPSTREAM.md). The font resources are
distributed under LGPL-2.1-or-later, with the local license copy at
[`fonts/Wine-LGPL-2.1.txt`](../fonts/Wine-LGPL-2.1.txt).

### ReactOS

ReactOS carries many scalable substitutes as well as
[`media/fonts/vgaoem.fon`](https://github.com/reactos/reactos/blob/master/media/fonts/vgaoem.fon).
Direct inspection of the latter found a single face named `Terminal`, an 8x12
fixed cell, `OEM_CHARSET`, and byte range 0 through 254. Its SHA-256 at review
time was `af453f9c06bd451596091a1100cf45ca9ba41029feb8bcdca0ac03f44ef7f7e7`.

The ReactOS history says the file was converted from XFree `vga.bdf`, then
edited and renamed Terminal. Its embedded notice names AJCD, grischka, and
khmz. It is technically the most direct ready-made drop-in reviewed, but the
individual binary does not carry a complete license text and its multi-author
lineage needs more auditing before extraction into a differently licensed
project. ANAKRON has cleaner standalone OFL provenance and was preferred
visually.

ReactOS's outline substitutes such as UniVGA16, Fixedsys Excelsior, Courier,
Microsoft Sans Serif, and Tahoma were also useful comparisons. They target a
broader modern Windows-compatible system and do not improve on the selected
native 8x12 source for this role.

### unix4lyfe CP437

[The unix4lyfe CP437 page](https://unix4lyfe.org/cp437/) distributes 6x8, 8x8,
and 8x12 PCF/BDF fonts and says they can be used in X Windows and edited. The
page has a 2003/2006 Emil Mikulic copyright notice, but neither the page nor the
downloaded archive contains an explicit license granting redistribution or
derivative distribution.

The reviewed `cp437-8x12.bdf` has SHA-256
`2bafe6ca8d39be4affbbb6127688c666d1afa71218755fab63ec9526fbc18467`.
Adafruit's later `cp437-8x12.bdf` is byte-for-byte identical. Adafruit's guide
also warns that the collected fonts have varying licenses which must be checked
individually. Inclusion in another MIT repository does not establish that the
original font author granted relicensing. The conservative result is therefore
"license not established": do not vendor it without permission from the
copyright holder.

This is a licensing finding about that particular font file. CP437 itself is a
character encoding and does not assign a license to every font implementing
it.

### ANAKRON

[ANAKRON](https://github.com/molarmanful/ANAKRON) is an 8x12 fixed-width Unicode
bitmap designed for crisp modern terminal use. Release v0.3.3 supplies BDF,
PCF, OTB, PSF, TTF, WOFF2, and other packages. The project describes the design
as bold, while the actual BDF family metadata identifies its sole strike as
`Regular` with roman slant. There is no separate bold or italic source.

The repository is licensed under SIL Open Font License 1.1. The reviewed
license declares no Reserved Font Name after its copyright statement. This
repository nevertheless renames the generated modified FNT to `Terminal`,
keeps it under OFL-1.1, and includes the complete copyright/license text.

Pinned input:

| Property | Value |
|---|---|
| Upstream release | v0.3.3 |
| Release commit | `6308ba734086d8e50780ce114cf17a718df0a2a7` |
| Local source | `fonts/anakron/ANAKRON-v0.3.3.bdf` |
| Source SHA-256 | `d792885acf2043beb7e16bd0a85fce498e3e072e2ce828c750d14b074474f119` |
| Source geometry | 8x12 cell, ascent 10, descent 2 |
| Generated face | Terminal |
| Generated charset | `OEM_CHARSET` (255) |
| Generated byte range | 0x00-0xff |
| Generated SHA-256 | `dccca736742e4c1bf0b6a98393417c07f6e46ef0ecb2030cec0ebddb2369d4e1` |
| License | OFL-1.1 |

Visually, ANAKRON was the strongest clearly licensed 8x12 candidate. It remains
legible, has deliberate diagonals rather than accidental outline dropouts, and
contains the Unicode box-drawing and DOS-symbol repertoire needed to construct
the OEM byte strike.

### KakwaFont

[KakwaFont](https://github.com/kakwa/kakwafont) is a 6x12 bitmap family based on
Terminus and licensed under OFL-1.1. Unlike the other tiny candidates, its
normal and bold BDFs contain genuinely different letter designs. Its bold is a
useful reference for how a designed bitmap weight differs from horizontally
dilating pixels.

It was not selected because the six-pixel advance changes the native Terminal
geometry and padding it into an eight-pixel cell leaves a visibly narrower
text texture. There is no designed italic strike.

### Terminus

[Terminus Font 4.49.1](https://terminus-font.sourceforge.net/) is a mature
fixed-width bitmap family. It offers 6x12, 8x14, 8x16, and progressively larger
cells. The font is OFL-1.1; its build programs have a separate GPL license.

The official documentation explicitly excludes 6x12 from the bold set. A copy
of the normal 6x12 font may be installed under a bold name to prevent poor
synthetic shifting, but it is not a designed bold. Real bold begins at 8x14,
and special CRT VGA-bold variants exist at 8x14 and 8x16. Terminus has no
designed italic; its documentation points to mechanical slanting utilities.

Terminus is a sound alternative if 8x14 or 8x16 is acceptable. It cannot fill
an exact 8x12 stock cell without resampling or changing metrics.

### W95FA and Fixedsys Excelsior

W95FA and Fixedsys Excelsior are outline fonts which imitate older Windows
designs for contemporary font systems. They are useful for CSS or unsupported
scalable Canvas faces, but they are not collections of authoritative bitmap
strikes for every requested pixel size.

At small monochrome sizes the outline rasterizer must choose which ideal curves
and diagonals survive on the grid. Changing FreeType hinting modes did not fix
the poor 21px and 24px results observed in the benchmark because the underlying
problem was not antialiasing: these sizes did not contain separately designed
pixel strikes. Fixedsys Excelsior is also a Fixedsys recreation, not a Terminal
face.

## Why hinting is irrelevant for the selected source

Hinting controls how scalable outlines are adjusted to a pixel grid. ANAKRON's
BDF is already a set of monochrome pixels at one exact size. FreeType loads the
existing bitmap and returns it verbatim; there is no outline to hint and no
coverage to threshold.

The meaningful build choices are therefore:

- which source strike to use;
- cell geometry and baseline placement;
- byte-to-Unicode mapping;
- destination FNT bit layout and charset metadata;
- integer scaling policy at runtime.

For this resource, switching between native, automatic, light, or disabled
hinting should not alter a glyph. A changed result would indicate that an
outline or resampling path was accidentally selected.

## CP437 conversion

ANAKRON stores glyphs by Unicode code point. A Windows OEM FNT is indexed by
bytes. The generator therefore performs this explicit conversion:

```text
OEM byte 0x00..0xff
        |
        v
CP437 byte-to-Unicode table
        |
        v
ANAKRON BDF Unicode glyph (native 1 bpp, 8x12 cell)
        |
        v
Windows FNT 3.0 byte-column bitmap
        |
        v
RT_FONT inside Terminal.fon (NE resource container)
```

This includes the DOS graphic controls at 0x01-0x1f, the house at 0x7f,
accented letters, Greek and mathematical characters, shading, box drawing, and
block elements. Important invariants are tested explicitly:

- 0x00 remains a blank NUL cell;
- 0x01 is the smiling-face glyph;
- 0xb3 is an uninterrupted vertical line for all 12 rows;
- 0xc4 is an edge-to-edge horizontal line;
- 0xdb is a completely filled 8x12 cell;
- the FNT advertises `OEM_CHARSET`, first byte 0, and last byte 255.

Mapping through CP1252 or treating each OEM byte as the same-numbered Unicode
code point would produce incorrect glyphs above ASCII even if ordinary Latin
text looked correct.

## Runtime rendering path

No JavaScript font rasterizer is involved:

```text
tracked Terminal.fon
        |
        v
browser/CLI virtual C:\WINDOWS\FONTS\TERMINAL.FON
        |
        v
WAT validates NE + RT_FONT + FNT tables
        |
        v
WAT selects Terminal 8x12 for OEM_FIXED_FONT or explicit Terminal
        |
        v
WAT measures glyph advances and writes monochrome pixels
        |
        v
canonical GDI DIB surface
        |
        v
host presentation only
```

FreeType is used only by `tools/gen-wine-fonts.sh` at build time to read the
BDF and serialize the generated FNT. The shipped emulator has no FreeType
dependency. Canvas remains available for unsupported scalable/document fonts,
but it is not used for ANAKRON Terminal or the covered Wine stock bitmap faces.

## Bold and italic policy

Pixel dilation (`row | row shifted right`) made ANAKRON and the other tiny
faces excessively heavy, closed counters, and damaged box drawing. Stair-step
row shifting produced an uneven synthetic italic and changed effective cell
edges. Combining the two amplified both defects.

For `OEM_FIXED_FONT`, styles are unnecessary: the stock LOGFONT is regular
weight and non-italic. For terminal protocols, a DOS-like bold attribute is
often more faithfully represented by the bright color palette than by a
second heavier glyph.

Policy:

1. Use ANAKRON's single source strike for regular Terminal.
2. Do not synthesize stock bold or italic variants.
3. Until an application demonstrates a compatibility need, resolve explicit
   styled Terminal requests to the regular bitmap rather than damage it.
4. If designed styles become necessary, add a coherent family with actual
   source strikes; do not mix Kakwa bold glyphs into ANAKRON regular text.

## Reproduction and verification

```sh
bash tools/gen-wine-fonts.sh fonts
node test/test-generated-wine-fonts.js
node test/test-wat-gdi-fixed-stock-font.js
node test/test-wat-gdi-default-bitmap-font.js
```

The generation test checks the pinned ANAKRON BDF hash, regenerates all tracked
Wine/ANAKRON FONs byte-for-byte, validates Terminal metrics and charset, and
checks representative CP437 bitmap rows. The WAT test selects all three fixed
stock objects plus an explicit Terminal LOGFONT, verifies face and cell
metrics, renders through WAT, and asserts that no Canvas text import was called.

## Follow-up scope

The selected stock role is complete without styles. Future font work should be
driven by concrete application failures:

- Unicode-to-OEM conversion for wide-character APIs beyond the current
  byte-oriented bitmap path;
- additional OEM code pages selected by `lfCharSet` and locale;
- user-supplied original FON loading for local pixel-perfect comparison;
- true designed bold/italic families only where an application requires them;
- broader shaping/scalable document faces, which are separate from Terminal.

## Primary sources

- [ANAKRON repository and OFL declaration](https://github.com/molarmanful/ANAKRON)
- [ANAKRON v0.3.3 release](https://github.com/molarmanful/ANAKRON/releases/tag/v0.3.3)
- [KakwaFont repository](https://github.com/kakwa/kakwafont)
- [Terminus Font project](https://terminus-font.sourceforge.net/)
- [unix4lyfe CP437 distribution page](https://unix4lyfe.org/cp437/)
- [Adafruit CP437 usage and license warning](https://learn.adafruit.com/using-dvi-video-in-circuitpython/fonts)
- [ReactOS font directory](https://github.com/reactos/reactos/tree/master/media/fonts)
- [ReactOS vgaoem conversion history](https://github.com/reactos/reactos/commit/383ea7d92bf1e38a042f7b130f9f4ee00c1a827e)
- [Wine source repository](https://gitlab.winehq.org/wine/wine)
