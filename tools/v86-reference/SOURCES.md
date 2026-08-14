# v86 Reference Harness Sources

No VM runtime, firmware, operating-system image, saved state, generated ISO, or
probe executable is committed. `npm ci` installs the pinned runtime under
ignored `node_modules/`; locally supplied assets belong under ignored
`.cache/v86-reference/`.

The CLI browser driver is pinned separately as `puppeteer@25.7.0`.
It uses `--browser`, `CHROME_BIN`, a standard system Chrome installation, or
Puppeteer's downloaded browser in that order.

## v86 runtime

- Package: `v86@0.5.432`
- Embedded build version: `0.5.432+gf3d4472`
- npm integrity: `sha512-/aZwi0WWvbab5k7+bkjKMhSNoj+60eqRIZ9urNwKTI4i1JbyK1Ja2QSFEay/M9uE0qIte+SncncAHYqRsLJNiw==`
- Upstream commit: `f3d4472a9c934b9ad78a311f5849ba711a296d23`
- Source: <https://github.com/copy/v86/tree/f3d4472a9c934b9ad78a311f5849ba711a296d23>
- License: BSD-2-Clause; see `LICENSE.v86`.

`iso9660.js` is adapted from v86's `src/iso9660.js` at that commit.

## Firmware

Firmware is not distributed by this repository. The harness accepts `--bios`
and `--vgabios`, or reads these local paths:

| Local path | Upstream source | Size | SHA-256 |
| --- | --- | ---: | --- |
| `.cache/v86-reference/seabios.bin` | [v86 SeaBIOS build](https://raw.githubusercontent.com/copy/v86/f3d4472a9c934b9ad78a311f5849ba711a296d23/bios/seabios.bin) | 131072 | `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98` |
| `.cache/v86-reference/vgabios.bin` | [v86 VGA BIOS build](https://raw.githubusercontent.com/copy/v86/f3d4472a9c934b9ad78a311f5849ba711a296d23/bios/vgabios.bin) | 36352 | `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880` |

The firmware build scripts and LGPL notice are in the pinned upstream
[`bios/` directory](https://github.com/copy/v86/tree/f3d4472a9c934b9ad78a311f5849ba711a296d23/bios).

## Windows 98 reference image

The default online profile duplicates the official v86 Windows 98 profile:

- Profile definition: [`src/browser/main.js`](https://github.com/copy/v86/blob/f3d4472a9c934b9ad78a311f5849ba711a296d23/src/browser/main.js#L955-L966)
- Disk source prefix: `https://i.copy.sh/windows98/`
- Disk layout: 300 MiB split into 256 KiB parts named
  `<start>-<end>.img`, for example `0-262144.img`
- Saved state: `https://i.copy.sh/windows98_state-v2.bin.zst`
- Saved-state size observed 2026-08-13: 13434587 bytes
- Saved-state ETag observed 2026-08-13: `684a87d5-ccfedb`

The image is proprietary and is not licensed by v86. The upstream image-source
notes point to [WinWorld](https://winworldpc.com/) for MS-DOS and historic
Windows media. Users are responsible for obtaining and using operating-system
media legally. Do not add a disk image or saved state to this repository.

For a local capture, provide a full 300 MiB image and state explicitly:

```sh
npm run reference:v86 -- \
  --disk /path/to/windows98.img \
  --state /path/to/windows98_state-v2.bin.zst \
  --bios /path/to/seabios.bin \
  --vgabios /path/to/vgabios.bin \
  --app geometry-probe
```

For an online smoke run using the documented sources:

```sh
npm run reference:v86 -- --online --app geometry-probe
```

Each capture writes a 640x480 PNG plus JSON metadata containing the runtime
revision, asset locations, payload hashes, display dimensions, and screenshot
hash. Generated captures go under `screenshots/v86-reference/generated/` and
remain ignored until intentionally promoted as reviewed reference material.
Reviewed captures live under `screenshots/v86-reference/reviewed/`. Their JSON
sidecars retain the complete provenance and are checked against the PNG digest
by `test/test-v86-reference-harness.js`.

The first geometry probe on the pinned profile reported a `154x235` outer
Minesweeper window, `148x191` client area, and client origin `(3,41)` relative
to the outer window. Keep the generated PNG and JSON together when using that
measurement to change emulator metrics.

## Bitmap-font reference probes

`font-apps.json` keeps the font probes separate from the accessory profiles in
`apps.json`. The probes enumerate installed `.FON` files and raster faces,
measure GDI stock-font objects, render printable ASCII, and request several
Fixedsys heights through `CreateFontA`. Run any profile with the same documented
online image used above, for example:

```sh
node tools/v86-reference/capture.js --online \
  --manifest tools/v86-reference/font-apps.json \
  --app stock-font-ascii
```

The pinned Windows 98 state reports these distinct stock objects at its default
640x480 display configuration:

| GDI stock object | Raster face | First metric |
| --- | --- | ---: |
| `ANSI_FIXED_FONT` | Courier | 8x13 |
| `OEM_FIXED_FONT` | Terminal | 8x12 |
| `SYSTEM_FIXED_FONT` | Fixedsys | 8x15 |
| `SYSTEM_FONT` | System | 7x16 |

Negative Fixedsys height requests select discrete bitmap results rather than a
new outline rasterization at every height: requests 16 and 18 produce `8x15`,
21 through 32 produce `16x30`, 48 produces `32x60`, 64 produces `40x75`, and
80 produces `40x90`. The probe also records `tmInternalLeading`, so requested
character height can be distinguished from total cell height.

## Profile exclusions

`apps.json` marks profile-specific exclusions with `skip`. The official Win98
state uses the basic 640x480x4 VGA driver. Marbles needs a 256-color display
with working DirectDraw, so it is not a valid reference target on this state.
The app itself is compatible with Windows 98; the exclusion is about this VM
profile. The XP-targeted `mplay32.exe` is also not used: the Media Player entry
uses the OS 4.0 `mplayer.exe` binary instead.
