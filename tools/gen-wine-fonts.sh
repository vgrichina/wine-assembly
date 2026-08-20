#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${1:-$repo_root/fonts}"

if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists freetype2; then
  echo "gen-wine-fonts: FreeType development files are required (pkg-config freetype2)" >&2
  exit 1
fi

mkdir -p "$output_dir"
fontgen_dir="$(mktemp -d "${TMPDIR:-/tmp}/wine-assembly-fontgen.XXXXXX")"
trap 'rm -rf "$fontgen_dir"' EXIT

cc -std=c11 -O2 -Wall -Wextra -Werror \
  $(pkg-config --cflags freetype2) \
  "$repo_root/tools/gen-bitmap-fon.c" \
  $(pkg-config --libs freetype2) \
  -o "$fontgen_dir/gen-bitmap-fon"

generate() {
  local input="$1"
  local output="$2"
  local face="$3"
  shift 3
  "$fontgen_dir/gen-bitmap-fon" \
    "$repo_root/fonts/wine/$input.ttf" "$output_dir/$output.fon" "$face" \
    "--copyright=Wine $face; LGPL-2.1-or-later" \
    --bitmap-only --hinting=native --raster=exact "$@"
}

# These sizes are embedded monochrome strikes in Wine's generated TTFs.
# FreeType returns those pixels verbatim; it does not rasterize outlines here.
generate fixedsys Fixedsys Fixedsys --fixed 15
generate system System System 16 18
# Microsoft's 96-DPI SSERIFE.FON shipped six cells: 13, 16, 20, 24, 29,
# and 37 pixels, with character heights encoded through internal leading.
# Wine's redistributable bitmap source supplies exact 13/16/20px strikes.
# Fill its missing rungs once at build time by nearest-neighbor scaling those
# open pixels; the runtime still consumes a normal bitmap-only FON and never
# needs Microsoft bytes or a font engine.
generate ms_sans_serif MSSansSerif "MS Sans Serif" \
  --scale-bitmaps --internal-leading=2,3,4,6,5,5 \
  13 16 20 24 29 37
generate courier Courier Courier --fixed 13

# Tahoma is the Win98 shell and tooltip face. Wine's TTFs carry monochrome
# strikes across exactly the ppem range dialogs use, so these are extracted
# pixels rather than a rasterized outline, and Tahoma at UI sizes joins the
# pixel-exact FNT path instead of any scalable fallback. Bold declares
# dfWeight 700; a bold strike reporting 400 would be indistinguishable from
# its regular sibling to face selection.
generate tahoma Tahoma Tahoma 8 9 10 11 12 13 15 16
generate tahomabd TahomaBold "Tahoma Bold" --weight=700 9 10 11 12 13 15 16
generate small_fonts SmallFonts "Small Fonts" 11

# ANAKRON v0.3.3 is a native 8x12 Unicode bitmap.  Repackage its exact pixels
# as the Win9x Terminal face, mapping every FNT byte through IBM code page 437.
"$fontgen_dir/gen-bitmap-fon" \
  "$repo_root/fonts/anakron/ANAKRON-v0.3.3.bdf" "$output_dir/Terminal.fon" Terminal \
  "--copyright=ANAKRON v0.3.3; OFL-1.1" \
  --bitmap-only --hinting=native --raster=exact --charset=oem --fixed 12
