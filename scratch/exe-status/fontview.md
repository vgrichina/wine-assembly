# Font Viewer (fontview.exe) — Win98

**Status:** WORKING (native `.FON` bitmap preview and Done lifecycle verified)

## Behavior
Loads its MFC 3.0 dialog, reads an NE-format `.FON` resource through LZ32,
registers its FNT bitmap strike, lays out the preview child, and rasterizes all
sample rows from the font's one-bit glyph data. The web launcher opens the
local `vgasys.fon` fixture by default. A real click on **Done** runs the MFC
cleanup handler, unregisters the font, posts `WM_QUIT`, and exits.

## DLL Dependencies
- **MFC30.DLL** — MFC 3.0 (older version, NOT the same as mfc42.dll)
- **MSVCRT20.dll** — older MSVC runtime (NOT msvcrt.dll)
- **LZ32.dll** — Lempel-Ziv compression
- **VERSION.dll** — version info queries

`MFC30.DLL` and `MSVCRT20.dll` are available as documented, gitignored local
fixtures. LZ32's ordinary-file calls and the required VERSION APIs are handled
by the WAT runtime.

## Fixture provenance

See `test/binaries/SOURCES.md` for the executable and
`test/binaries/dlls/SOURCES.md` for the two runtime DLLs and `vgasys.fon`.
The stock Windows supporting files are local-only and are deliberately absent
from public deployment manifests.

## Regression coverage

`test/test-fontview.js` verifies that the 224-glyph, 16-pixel System FNT strike
is parsed (rather than replaced with a CSS face), captures the populated
preview, then clicks Done and checks `RemoveFontResourceA` plus
`PostQuitMessage` before clean exit.

## Remaining limitations

- This executable validates Windows NE `.FON` modules; passing an arbitrary
  TrueType `.TTF` directly produces its normal “not a valid font file” error.
- The bitmap rasterizer supports FNT 2.x/3.x strikes. Other legacy font
  container formats still fall back to the configured CSS font map.
- Print UI exists, but printer fidelity is outside this startup/preview check.
