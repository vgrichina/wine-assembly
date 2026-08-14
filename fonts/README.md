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
