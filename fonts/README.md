# Fonts

Open substitutes for the Win98 system fonts, bundled so rendering does not
depend on fonts installed on the host. These files are not Microsoft fonts and
do not contain the original Win98 bitmap strikes.

| File | Font | Substitutes for | Reported license | Source | SHA-256 |
|---|---|---|---|---|---|
| `W95FA.otf` | W95FA | MS Sans Serif, Tahoma, System | SIL OFL 1.1 | [FontsArena original release](https://fontsarena.com/w95fa-by-alina-sava/) | `9e1ad53708307b2b68e06d43799b2267f6aec620dda972bc62753ad16ba50f2b` |
| `w95fa.woff2` | W95FA web build | same | SIL OFL 1.1 | same upstream | `d81cbd6c15b9695e614fe1674bc1f43fa79c820afd0cd4acf49955d065e71644` |
| `W95FA.fon` | W95FA bitmap build | same | SIL OFL 1.1 | generated from `W95FA.otf` as described below | `080b1b49cba19b355cf9800419c15f652016309d2edffe6ba2dd54f342e945bb` |
| `FSEX302.ttf` | Fixedsys Excelsior 3.02 | Fixedsys, Terminal, OEM/SYSTEM_FIXED_FONT | Public domain | https://github.com/kika/fixedsys/releases | `842f8fbf80f57d867aeb1d2988140d3ea8b4718e5f687035b0a3b66756df3899` |
| `Fixedsys.fon` | Fixedsys bitmap build | ANSI/OEM/SYSTEM fixed stock fonts | Public domain | generated from `FSEX302.ttf` as described below | `3dc3b77f2811815c360c57e9d88902253a8eeaaa46ac84bf9a4edb1f3b3a26df` |

Before replacing any artifact, record the exact upstream release/tag and add
its license text beside the font. The labels above describe upstream's stated
terms; the repository should retain local license copies rather than relying
indefinitely on external pages.

### W95FA license provenance

`W95FA-OFL.txt` is an LF-normalized copy of `W95FA/OFL.txt` from the
[publisher's original ZIP](https://fontsarena.com/wp-content/uploads/2020/01/W95FA.zip),
downloaded and verified on 2026-08-13. The ZIP SHA-256 is
`a78972d3d46cc506f9aef423100b027696fad437b16b078e3bdf396c0bf6d3eb`.
Its OTF and WOFF2 files are byte-for-byte identical to the repository files
listed above.

The publisher identifies [Alina Sava](https://fontsarena.com/created-by/alina-sava/)
as the original author and says W95FA is licensed under SIL OFL 1.1. The
original ZIP shipped the standard OFL header with its `<dates>`,
`<Copyright Holder>`, and `<Reserved Font Name>` placeholders unfilled. This
repository preserves the publisher's template statement as supplied; it does
not declare an actual Reserved Font Name, so the generated bitmap build retains
the W95FA name.

Loaded two ways:
- **Browser:** `@font-face` declared in `index.html`, served from `/fonts/`.
- **Node CLI (`test/run.js`):** `canvas.registerFont()` is called at startup for both files; renders fall back silently if the package or files are missing.

Sizes: W95FA looks crispest at 11–12px; Fixedsys Excelsior at 16px.

The deterministic text path is specified in `docs/software-gdi-design.md` and
uses generated monochrome strikes from these open fonts at runtime. Original
Microsoft `.FON`/`.FNT` resources must not be committed without a verified
redistribution license; users may provide their own installed Win98 font files
for exact local rendering.

## Generated bitmap FONs

`tools/gen-w95fa-fon.sh` uses FreeType at build time to auto-hint W95FA into
one-bit FNT 3.0 strikes and packages them in a resource-only Windows 3.x NE
`.FON`. FreeType is not linked into the emulator. The tracked `W95FA.fon` was
produced by this command and contains 11, 12, 16, 24, 32, 48, and 64-pixel
strikes:

```sh
bash tools/gen-w95fa-fon.sh fonts/W95FA.fon
```

Pass explicit pixel heights after the output path to override that list:

```sh
bash tools/gen-w95fa-fon.sh scratch/w95fa.fon 11 12 16
```

For a local Font Viewer CLI experiment, place the generated file beside the
ignored Win98 fixture so `test/run.js` imports it into the virtual C drive:

```sh
bash tools/gen-w95fa-fon.sh test/binaries/win98-apps/w95fa.fon
node test/run.js \
  --exe=test/binaries/win98-apps/fontview.exe \
  --args=w95fa.fon \
  --input=12:png:scratch/fontview-w95fa.png,20:click:45:43 \
  --max-batches=30 --batch-size=5000 --no-close
```

The generator requires a C compiler plus FreeType development metadata exposed
as `pkg-config freetype2`. Generated strikes are derived from W95FA and remain
subject to its SIL Open Font License 1.1 terms.

`tools/gen-fixedsys-fon.sh` uses the same generator's fixed-cell mode to create
the tracked 8x16 `Fixedsys.fon` from public-domain Fixedsys Excelsior 3.02:

```sh
bash tools/gen-fixedsys-fon.sh fonts/Fixedsys.fon
```

At runtime, both the browser host and CLI preload the tracked FONs as
`C:\\WINDOWS\\FONTS\\W95FA.FON` and `FIXEDSYS.FON`. WAT installs them lazily,
so normal UI text and all three fixed stock fonts use the deterministic one-bit
rasterizer rather than Canvas font measurement or glyph rendering. Explicit
scalable document faces retain the Canvas fallback.
