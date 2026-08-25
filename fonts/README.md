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
| `MSSansSerif.fon` | MS Sans Serif native 13, 16, 20 only | dialog/UI stocks and aliases | `e038cf667907c0a75a59e172191c718e1d30e7e006915b55afd3411b72335cc4` |
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

## Faces with no vendored look-alike

Win98 shipped five scalable faces we have no open look-alike for: Verdana,
Impact, Lucida Console, Lucida Sans Unicode and Microsoft Sans Serif. Each
still has an entry in `substitutions.json` mapping it to the
filename a real `C:\WINDOWS\FONTS` held, mounted from the closest family we
already vendor — Liberation Sans for the proportional ones, Liberation Mono
for Lucida Console. They are Tier 3: the metrics are not Win98's and, for
Impact, neither are the shapes.

They are not enumerated. `EnumFontFamilies` lists what is installed, and a
Win98 machine without these fonts did not list them; claiming them would also
change which face an application picks from a font list. Substituting when a
guest asks for one by name is honest, advertising them is not — and it is not
academic either: TetriNET's Delphi runtime enumerates fonts at startup and
crashed mid-paint when this list grew by a single entry.

They exist as entries rather than as cases of the catch-all so each one names
a file of its own. A user who owns the Microsoft font can put `VERDANA.TTF`
into the guest's `C:\WINDOWS\FONTS` and it will answer instead — a real font
installed at the path GDI would have opened, which is exactly how Windows
worked. The note on each entry records which open font would be the closer
substitute to vendor if it ever matters, currently Anton for Impact.

A face name that appears in no table at all resolves to the default face
rather than to nothing, so a guest can never name a font that draws no text.

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

Generate all eight resources reproducibly with:

```sh
bash tools/gen-wine-fonts.sh fonts
node test/test-generated-wine-fonts.js
```

The generator requires a C compiler and `pkg-config freetype2`. FreeType reads
the exact embedded monochrome strike at each native size from the Wine TTFs
and ANAKRON BDF; it does not hint or rasterize an outline. Wine MS Sans Serif
contains native 13/16/20px cells only. We preserve those cells rather than
inventing Win98's missing 24/29/37px rungs: fractional nearest-neighbor
expansion made their strokes visibly thin, while WAT can enlarge the authentic
pixels by integer factors. FreeType is a build-time tool and is not linked into
the emulator.
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
| Comic Sans MS | `comic-relief/ComicRelief-*.ttf` | SIL OFL 1.1 |

All four styles (Regular, Bold, Italic, BoldItalic) are present for each
Liberation family, so no synthetic emboldening or obliquing is needed. Source release tarball
`liberation-fonts-ttf-2.1.5.tar.gz`, SHA-256
`7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`, downloaded
2026-08-14; per-file hashes are reproducible from that archive. The license text
is `liberation/LICENSE`.

Comic Relief v1.210 is upstream's metric-compatible replacement for Comic
Sans MS. The official release archive was downloaded 2026-08-22 with SHA-256
`0df0b733ec0f37d96a841b2757a1a5756492d9b80adfa86d11300f4150bf4862`.
The complete SIL OFL 1.1 text is in `comic-relief/OFL.txt`.

Wine's own Win9x substitutes for Tahoma, Tahoma Bold, Small Fonts, Marlett,
Symbol, Wingdings, and Webdings are pinned in `wine/` alongside the bitmap
sources; see `wine/UPSTREAM.md` for hashes and caveats.

Metric compatibility is also checked against native Win98 application output;
Klotski's FF_SCRIPT fallback is the first measured Comic Sans comparison.

## Deployed subsets

The vendored TTFs above are 4,803,932 bytes, all of which the browser would fetch before
a guest could draw its first character. `tools/gen-font-subsets.sh` cuts each
ANSI face to the Windows-1252 repertoire — the only codepoints
`$tt_cp1252_to_unicode` can ask for — and retains TrueType hinting so deployed
glyphs take the same WAT hinting path as the full source fonts.
That is 617,924 bytes deployed instead of 4,803,932 bytes.

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
| `ComicRelief-Bold.ttf` | 27,616 | `418315433348d4c22069e8183164b03a2d242bd70a4f991a17afb15ac55528f7` |
| `ComicRelief-Regular.ttf` | 22,776 | `03895913b5f3aa6ed3887b65a460d79d032f929408aa54b18b7272fe31983e00` |
| `LiberationMono-Bold.ttf` | 34,148 | `b1342eb3319519ed3a9c8e5fd2f434572905773ef2df41f1274b737d385b7110` |
| `LiberationMono-BoldItalic.ttf` | 30,408 | `a375703d0e2e24e92a21ccf6a94ba86d09ec64813b7a6d605849ac22009f6264` |
| `LiberationMono-Italic.ttf` | 30,056 | `7fb459c1a1005354e5224cad4a82bc99ad17c19d58f7a8a16d371e7ea8b0d705` |
| `LiberationMono-Regular.ttf` | 34,044 | `d7343a4c29424b95a3b0c2eeb8f0c93f2f8e8f53c343770f27c30d4fd372e9c7` |
| `LiberationSans-Bold.ttf` | 40,984 | `73c84e92eb8e62a655704e32b674411ea691636cb64122d42d39f8a52823f253` |
| `LiberationSans-BoldItalic.ttf` | 41,104 | `4e40b378a7f0ae604d03a04e5ba82cf06af9e9be9c7076cb3311eb0127f2fcd7` |
| `LiberationSans-Italic.ttf` | 40,848 | `d6c28903b87bd89bfde52531e6e115ffa1927ae1fad8eb9fb4c29e787c1161e8` |
| `LiberationSans-Regular.ttf` | 42,460 | `88285b035e7c0424d0dff4d5861d67013866fdd73c41a89e92eada8d72a20042` |
| `LiberationSerif-Bold.ttf` | 45,140 | `cb268f2aba012bcf8eaebce71cf494ea0c70377d5f647f1843b6d7b8c972f85a` |
| `LiberationSerif-BoldItalic.ttf` | 45,144 | `581b1e896db076dfe82377a28c71d59d18426f5070a966805370b08e43753893` |
| `LiberationSerif-Italic.ttf` | 46,840 | `7ff206ea16b4b670e994ff4f2cec5117af9c7a463021203dacc9f3382ee63451` |
| `LiberationSerif-Regular.ttf` | 52,440 | `eab2ab50aede4b588231fb88325f6213cc3de9732f5ea1cdf5cf1320187905a9` |
| `marlett.ttf` | 6,136 | `1a9b951ca1815344050ae6158263991e2145918bc74ad65d82bc6ec4056a57d1` |
| `symbol.ttf` | 26,028 | `d79da0fbd9a9f3cf806059bb1f2c9d7ce43dd9e3e4c7d4dcc5d9f2759b81196f` |
| `tahoma.ttf` | 18,712 | `b9a2f7d46e1e117106d36d2d8d12a0919a8e302d51b9e29c10a3c3010a8ec459` |
| `tahomabd.ttf` | 19,216 | `6179a426c8f0b5c9c500abed8503e79004f759ac29eec4d28442c2f7d12182ab` |
| `webdings.ttf` | 4,300 | `bbaf4df7911928cbb196fc48f1c7237f68aba2aec3e53c01761b89fdd038ac7a` |
| `wingding.ttf` | 9,524 | `cf5784b53e365ecfad1661b8b23d133effa1d3b54fb7a51137c8a9548f0db08e` |

## Legacy web/CSS substitutes

`W95FA.otf`, `w95fa.woff2`, and `FSEX302.ttf` predate the WAT bitmap path.
They remain for emulator-shell CSS — the page around the emulator, not
anything a guest draws. No guest text reaches Canvas any more: every face a
guest can name resolves to a font mounted in the VFS, so stock GDI rendering
consumes neither these nor their generated FONs.

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
