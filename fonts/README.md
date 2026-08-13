# Fonts

Open substitutes for the Win98 system fonts, bundled so rendering does not
depend on fonts installed on the host. These files are not Microsoft fonts and
do not contain the original Win98 bitmap strikes.

| File | Font | Substitutes for | Reported license | Source | SHA-256 |
|---|---|---|---|---|---|
| `W95FA.otf` | W95FA | MS Sans Serif, Tahoma, System | SIL OFL 1.1 | https://github.com/verkcuos/w95fa | `9e1ad53708307b2b68e06d43799b2267f6aec620dda972bc62753ad16ba50f2b` |
| `w95fa.woff2` | W95FA web build | same | SIL OFL 1.1 | same upstream | `d81cbd6c15b9695e614fe1674bc1f43fa79c820afd0cd4acf49955d065e71644` |
| `FSEX302.ttf` | Fixedsys Excelsior 3.02 | Fixedsys, Terminal, OEM/SYSTEM_FIXED_FONT | Public domain | https://github.com/kika/fixedsys/releases | `842f8fbf80f57d867aeb1d2988140d3ea8b4718e5f687035b0a3b66756df3899` |

Before replacing any artifact, record the exact upstream release/tag and add
its license text beside the font. The labels above describe upstream's stated
terms; the repository should retain local license copies rather than relying
indefinitely on external pages.

Loaded two ways:
- **Browser:** `@font-face` declared in `index.html`, served from `/fonts/`.
- **Node CLI (`test/run.js`):** `canvas.registerFont()` is called at startup for both files; renders fall back silently if the package or files are missing.

Sizes: W95FA looks crispest at 11–12px; Fixedsys Excelsior at 16px.

The future deterministic text path is specified in
`docs/software-gdi-design.md`. It may generate fixed monochrome strikes from
these open fonts at build time. Original Microsoft `.FON`/`.FNT` resources must
not be committed without a verified redistribution license; users may provide
their own installed Win98 font files for exact local rendering.
