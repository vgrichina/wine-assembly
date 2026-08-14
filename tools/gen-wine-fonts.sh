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
generate ms_sans_serif MSSansSerif "MS Sans Serif" 13 16 20
generate courier Courier Courier --fixed 13

# ANAKRON v0.3.3 is a native 8x12 Unicode bitmap.  Repackage its exact pixels
# as the Win9x Terminal face, mapping every FNT byte through IBM code page 437.
"$fontgen_dir/gen-bitmap-fon" \
  "$repo_root/fonts/anakron/ANAKRON-v0.3.3.bdf" "$output_dir/Terminal.fon" Terminal \
  "--copyright=ANAKRON v0.3.3; OFL-1.1" \
  --bitmap-only --hinting=native --raster=exact --charset=oem --fixed 12
