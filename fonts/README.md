# Fonts

The deterministic Win9x stock-font path uses Wine's open-source bitmap-only
fonts plus ANAKRON for the OEM Terminal role. WAT parses the generated `.FON`
resources and writes their one-bit glyph pixels directly to the canonical GDI
surface; JavaScript does not rasterize these fonts and Canvas text is not used
for the covered stock faces.

## WAT stock bitmap fonts

| Runtime file | Source face and native cell strikes | Used for | SHA-256 |
|---|---|---|---|
| `System.fon` | System 16, 18 | `SYSTEM_FONT`, explicit System | `2f41afc0ea1d2ac4361fea4bfe4cd4eac5cb99627f1e7ee185ec9f5d1980f94b` |
| `MSSansSerif.fon` | MS Sans Serif 13, 16, 20 | dialog/UI stocks and aliases | `71e0bb6cd752d858f8712ab6b0c9ec50065c5fa76dc70b68da9eb85438dcf2d8` |
| `Fixedsys.fon` | Fixedsys 8x15 | `SYSTEM_FIXED_FONT`, Fixedsys | `2b5cf71bfbadbc460f79fb5b2d8bf1650a7e148359fcb6064392b4a28fadd3c4` |
| `Courier.fon` | Courier 8x13 | `ANSI_FIXED_FONT`, Courier | `51dd54b23b9857032faac1ab672d7c788b657752ea0b2d0cc39a9f727a607457` |
| `Terminal.fon` | ANAKRON-derived Terminal 8x12 | `OEM_FIXED_FONT`, Terminal | `dccca736742e4c1bf0b6a98393417c07f6e46ef0ecb2030cec0ebddb2369d4e1` |
| `Tahoma.fon` | Tahoma 8, 9, 10, 11, 12, 13, 15, 16 | Win98 shell/tooltip face | `6ffb14378b094f763b2a86eeb9973596765c024707ae42a64ce4cd8f41dc35f4` |
| `TahomaBold.fon` | Tahoma Bold 9, 10, 11, 12, 13, 15, 16 | bold shell face, `dfWeight` 700 | `549e1990dd2286456e1f79dbf5b7d5dd59bfca45bd8b3de3025df30e8f52bf7b` |
| `SmallFonts.fon` | Small Fonts 11 | Win98 Small Fonts | `4732123f27559b62a8047efea41ab920c9df57367be8dd6fd12a9a63bf37c705` |

Tahoma, Tahoma Bold, and Small Fonts are generated but **not yet wired into
the strike table**; nothing selects them at runtime. Their sizes are the
embedded monochrome strikes Wine's TTFs already carry, which is what lets the
Win98 shell face use the pixel-exact path instead of a scalable fallback.

Wine's Tahoma strikes carry no bitmap for space at 11ppem and above — it has
an advance and no ink — and drop `.notdef` above 10ppem. Both come out as
blank cells. `--bitmap-only` still refuses anything else that lacks a strike
bitmap, because silently rasterizing one outline into a strike is the failure
this whole path exists to avoid.

The editable `.sfd` sources and Wine-generated TTFs are pinned in `wine/`.
See `wine/UPSTREAM.md` for their exact Wine commit and checksums. Wine licenses
these fonts under LGPL-2.1-or-later; the complete text is in
`Wine-LGPL-2.1.txt`.

ANAKRON v0.3.3's release BDF is pinned as
`anakron/ANAKRON-v0.3.3.bdf` with SHA-256
`d792885acf2043beb7e16bd0a85fce498e3e072e2ce828c750d14b074474f119`.
The generated FNT is renamed Terminal and remains under SIL OFL 1.1; the
complete license is in `ANAKRON-OFL.txt`. The generator preserves the native
8x12 pixels, maps bytes 0x00-0xff to ANAKRON Unicode glyphs using CP437, and
marks the strike `OEM_CHARSET`.

Generate all five runtime resources reproducibly with:

```sh
bash tools/gen-wine-fonts.sh fonts
node test/test-generated-wine-fonts.js
```

The generator requires a C compiler and `pkg-config freetype2`. FreeType reads
the exact embedded monochrome strike at each requested size from the Wine TTFs
and ANAKRON BDF; it does not hint or rasterize an outline. FreeType is a
build-time tool and is not linked into the emulator.
`tools/gen-fixedsys-fon.sh` remains as a convenient wrapper for generating only
the native Wine 8x15 Fixedsys resource.

Fixedsys's larger Win98 sizes are integer nearest-neighbor expansions of the
8x15 source bitmap in WAT. The common native cells measured by the v86 Win98
probe are 8x15, 16x30, 32x60, 40x75, and 40x90. The last cell scales 5x in X
and 6x in Y.

### Stock mapping

```text
SYSTEM_FONT       -> Wine System 7x16
DEFAULT_GUI_FONT  -> Wine MS Sans Serif 13px
ANSI_VAR_FONT     -> Wine MS Sans Serif 13px
DEVICE_DEFAULT    -> Wine MS Sans Serif 13px
SYSTEM_FIXED_FONT -> Wine Fixedsys 8x15
ANSI_FIXED_FONT   -> Wine Courier 8x13
OEM_FIXED_FONT    -> ANAKRON-derived Terminal 8x12, CP437/OEM_CHARSET
```

Wine does not currently provide a distinct bitmap-only Terminal/OEM 8x12 face.
The ANAKRON-derived strike fills that role with the native Win98 stock metrics,
complete CP437 byte coverage, and an open redistribution license. It is an open
visual substitute, not a copy of Microsoft's Terminal artwork. Additional OEM
codepages and document fonts remain outside the stock-font milestone.

The candidate comparisons, licensing audit, style findings, CP437 conversion,
and runtime design are recorded in
[`docs/bitmap-font-review.md`](../docs/bitmap-font-review.md).

## Scalable substitutes

Vendored for the work described in
[`../docs/scalable-font-design.md`](../docs/scalable-font-design.md). These are
the *sources*: what ships is the subset built from them, see "Deployed subsets"
below. WAT rasterizes them into FNT strikes and renders them through the same
bitmap text path as the stock faces above.

`substitutions.json` records which open face stands in for each Win98 face,
with its tier, license, per-style files, and the **private** family name it
registers under. That name is never the Win98 name: a family registered as
`Arial` lets the host's own Arial win the cascade on machines that have it, and
lose on machines that do not, which is the non-determinism the substitution
exists to remove. `test/test-font-substitutions.js` checks every listed file is
present and is a `glyf` TrueType rather than CFF.

Liberation 2.1.5 is metric-compatible with the Win98 core scalable faces — same
advance widths, different outlines — so guest layout math stays correct:

| Win98 face | File prefix | License |
|---|---|---|
| Arial | `liberation/LiberationSans-*.ttf` | SIL OFL 1.1 |
| Times New Roman | `liberation/LiberationSerif-*.ttf` | SIL OFL 1.1 |
| Courier New | `liberation/LiberationMono-*.ttf` | SIL OFL 1.1 |

All four styles (Regular, Bold, Italic, BoldItalic) are present for each family,
so no synthetic emboldening or obliquing is needed. Source release tarball
`liberation-fonts-ttf-2.1.5.tar.gz`, SHA-256
`7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`, downloaded
2026-08-14; per-file hashes are reproducible from that archive. The license text
is `liberation/LICENSE`.

Wine's own Win9x substitutes for Tahoma, Tahoma Bold, Small Fonts, Marlett,
Symbol, Wingdings, and Webdings are pinned in `wine/` alongside the bitmap
sources; see `wine/UPSTREAM.md` for hashes and caveats.

Metric compatibility is a statement of upstream design intent until the v86
Win98 reference comparison described in the design doc exists. It has not been
measured in this repository yet.

## Deployed subsets

The vendored TTFs above are 4.7 MB, all of which the browser would fetch before
a guest could draw its first character. `tools/gen-font-subsets.sh` cuts each
ANSI face to the Windows-1252 repertoire — the only codepoints
`$tt_cp1252_to_unicode` can ask for — and drops hinting, since
`docs/scalable-font-design.md` deliberately has no TrueType bytecode
interpreter. That is 302 KB deployed instead of 4,577 KB.

The four symbol faces are copied **verbatim**. They are addressed through the
Microsoft `(3,0)` cmap with the `0xF000` bias, and subsetting them by codepoint
produced an empty cmap — every glyph unreachable — because a `(3,0)` table is
not indexed by Unicode. Together they are 46 KB, so the saving would have been
a rounding error against the risk of a face that silently stops resolving.

Subsetting recomputes `hhea` and `OS/2` over the surviving glyphs, which moves
`advanceWidthMax` and with it `tmMaxCharWidth`. Windows reported the full
font's value, so `tools/restore-font-metrics.py` copies both tables back from
the source — every field except `numberOfHMetrics`, which has to keep
describing the subset's own `hmtx`.

`test/test-font-subsets.js` reads both the full font and its subset through the
emulator's own TrueType parser and requires identical advance widths, left
bearings and `TEXTMETRIC` fields. It never asks fontTools anything, so it
cannot pass by sharing an assumption with the subsetter.

Regenerate with `bash tools/gen-font-subsets.sh`; verify the committed files
match with `--check`. The full TTFs stay in the repo as the pinned,
reproducible source, and are not deployed.

| Runtime file | Bytes | SHA-256 |
|---|---|---|
| `LiberationMono-Bold.ttf` | 17,776 | `9412f3acea216a3899fd5cecb6733bb7674ca2f5cb728b667e1edf90bf5f713d` |
| `LiberationMono-BoldItalic.ttf` | 18,796 | `3b0f02b007e241feec75128575f81ada171029cbe23a67f40659975007d32366` |
| `LiberationMono-Italic.ttf` | 18,796 | `3a3c724c5d7747befe26cbe01e56d907ae2c95e9b9a68f1f607d7f0c81c32338` |
| `LiberationMono-Regular.ttf` | 17,636 | `656b5ff9fe4dc8e1e738573ab62a0bdfb79693a49d13a26820c14da2726950a0` |
| `LiberationSans-Bold.ttf` | 18,344 | `8faceadd14e4aedc30b50f01deefe4f514faefa2697888b0c6f974d740ffad91` |
| `LiberationSans-BoldItalic.ttf` | 19,088 | `b5a6dd30998f2706ba31b71ec25d2a7ed69e9d4d26194d915db5d48c30035139` |
| `LiberationSans-Italic.ttf` | 18,988 | `e42a058e3af5110c5c16a7b45746923ff999c014eaf92c8154ff94a2827ea1dc` |
| `LiberationSans-Regular.ttf` | 18,228 | `c6ec3a6ecba473216118ec094aba94b9e79d2f1fd0a8d3c167b5e77a50de10aa` |
| `LiberationSerif-Bold.ttf` | 19,388 | `b4b4c5877b64959130847c9f78c27444e0697645bdfed97f4011a69efd6f2473` |
| `LiberationSerif-BoldItalic.ttf` | 20,004 | `050e371b1c01b92adce36c029c4a68451070709de72bfccba9d4107cf783823c` |
| `LiberationSerif-Italic.ttf` | 20,016 | `c097d63930b70a21c755bcd19d77311695693da304619a85dcda93830e508b3d` |
| `LiberationSerif-Regular.ttf` | 19,256 | `0509a0fcc1e9fd0d25f11e277f68fd240a20e50385e7dbce4ae65339a05a16a6` |
| `marlett.ttf` | 6,136 | `1a9b951ca1815344050ae6158263991e2145918bc74ad65d82bc6ec4056a57d1` |
| `symbol.ttf` | 26,028 | `d79da0fbd9a9f3cf806059bb1f2c9d7ce43dd9e3e4c7d4dcc5d9f2759b81196f` |
| `tahoma.ttf` | 18,692 | `badded24db63cbbc65af1b98b31ed2cf66328e1fd4e346b3ad3d0de9b67c7b2d` |
| `tahomabd.ttf` | 19,196 | `afbee425b5ac39c199432849690e32d42c65f628096c598f5c92e9a4ad60d6e9` |
| `webdings.ttf` | 4,300 | `bbaf4df7911928cbb196fc48f1c7237f68aba2aec3e53c01761b89fdd038ac7a` |
| `wingding.ttf` | 9,524 | `cf5784b53e365ecfad1661b8b23d133effa1d3b54fb7a51137c8a9548f0db08e` |

## Legacy web/CSS substitutes

`W95FA.otf`, `w95fa.woff2`, and `FSEX302.ttf` predate the WAT bitmap path. They
remain for emulator-shell CSS and the explicit Canvas fallback used by
unsupported scalable document faces; stock GDI rendering no longer consumes
their generated FONs.

| File | Font | License | Source | SHA-256 |
|---|---|---|---|---|
| `W95FA.otf` | W95FA | SIL OFL 1.1 | [FontsArena original release](https://fontsarena.com/w95fa-by-alina-sava/) | `9e1ad53708307b2b68e06d43799b2267f6aec620dda972bc62753ad16ba50f2b` |
| `w95fa.woff2` | W95FA web build | SIL OFL 1.1 | same upstream | `d81cbd6c15b9695e614fe1674bc1f43fa79c820afd0cd4acf49955d065e71644` |
| `FSEX302.ttf` | Fixedsys Excelsior 3.02 | public domain | [Fixedsys Excelsior releases](https://github.com/kika/fixedsys/releases) | `842f8fbf80f57d867aeb1d2988140d3ea8b4718e5f687035b0a3b66756df3899` |

`W95FA-OFL.txt` is an LF-normalized copy of `W95FA/OFL.txt` from the
publisher's original ZIP, downloaded and verified on 2026-08-13. The ZIP
SHA-256 is
`a78972d3d46cc506f9aef423100b027696fad437b16b078e3bdf396c0bf6d3eb`.
The publisher identifies Alina Sava as the author and distributes W95FA under
SIL OFL 1.1. The supplied template leaves its copyright-holder and reserved
font-name placeholders unfilled; this repository preserves it unchanged.

Original Microsoft `.FON`/`.FNT` resources must not be committed without a
verified redistribution license. Users may provide their own Win98 font files
for exact local comparisons.
