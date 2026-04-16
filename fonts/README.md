# Fonts

Free metric-reasonable substitutes for the Win98 system bitmap fonts.
Bundled so the emulator looks right even when the host OS lacks MS Sans Serif / Fixedsys.

| File | Font | Substitutes for | License | Source |
|---|---|---|---|---|
| `W95FA.otf` | W95FA | MS Sans Serif, Tahoma, System (UI chrome) | Free / public (see upstream) | https://github.com/verkcuos/w95fa |
| `w95fa.woff2` | W95FA (web-optimized) | same, browser use | same | same repo |
| `FSEX302.ttf` | Fixedsys Excelsior 3.02 | Fixedsys, Terminal, OEM_FIXED_FONT, SYSTEM_FIXED_FONT | Free | https://github.com/kika/fixedsys/releases |

Loaded two ways:
- **Browser:** `@font-face` declared in `index.html`, served from `/fonts/`.
- **Node CLI (`test/run.js`):** `canvas.registerFont()` is called at startup for both files; renders fall back silently if the package or files are missing.

Sizes: W95FA looks crispest at 11–12px; Fixedsys Excelsior at 16px.
