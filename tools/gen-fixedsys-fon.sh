#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$repo_root/scratch/fixedsys.fon}"
shift "$(( $# > 0 ? 1 : 0 ))"

if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists freetype2; then
  echo "gen-fixedsys-fon: FreeType development files are required (pkg-config freetype2)" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
fontgen_dir="$(mktemp -d "${TMPDIR:-/tmp}/wine-assembly-fontgen.XXXXXX")"
trap 'rm -rf "$fontgen_dir"' EXIT

cc -std=c11 -O2 -Wall -Wextra -Werror \
  $(pkg-config --cflags freetype2) \
  "$repo_root/tools/gen-bitmap-fon.c" \
  $(pkg-config --libs freetype2) \
  -o "$fontgen_dir/gen-bitmap-fon"

if (( $# )); then
  echo "gen-fixedsys-fon: Wine Fixedsys contains one native 15px strike" >&2
  exit 2
fi

"$fontgen_dir/gen-bitmap-fon" "$repo_root/fonts/wine/fixedsys.ttf" "$output" \
  Fixedsys --fixed --copyright="Wine Fixedsys; LGPL-2.1-or-later" \
  --bitmap-only --hinting=native --raster=exact 15
