#!/usr/bin/env bash
# Emit the deployed font subsets from the vendored full TTFs.
#
# The full fonts are 4.2 MB of Liberation plus ~0.4 MB of Wine faces, fetched
# by the browser before a guest can draw its first character. Win98 apps in the
# corpus are CP1252 (or symbol-encoded), so the emulator can only ever ask for
# ~220 codepoints per face - everything else is payload nobody reads.
#
# Hinting goes too. docs/scalable-font-design.md deliberately has no TrueType
# bytecode interpreter, so `fpgm`/`prep`/`cvt ` and per-glyph instructions are
# bytes the rasterizer will never execute.
#
# The full TTFs stay in the repo as the pinned, reproducible source; only the
# subsets are deployed. Do not hand-edit anything in fonts/subset/ - regenerate
# it. An unreproducible font binary in fonts/ is exactly the provenance problem
# the rest of that directory is set up to avoid.
#
#   bash tools/gen-font-subsets.sh          # regenerate
#   bash tools/gen-font-subsets.sh --check  # verify the committed files match
#
# Needs fontTools (pip install fonttools).

set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

OUT=fonts/subset
mkdir -p "$OUT"

if ! python3 -c 'import fontTools' 2>/dev/null; then
  echo "fontTools not installed: pip install fonttools" >&2
  exit 1
fi

# The Windows-1252 repertoire, which is exactly what $tt_cp1252_to_unicode can
# ask for. Bytes 0x80-0x9F carry typographic punctuation rather than C1
# controls, so the range is not contiguous and is derived rather than typed.
ANSI_UNICODES=$(python3 - <<'PY'
codes = []
for b in range(0x20, 0x100):
    try:
        codes.append('U+%04X' % ord(bytes([b]).decode('cp1252')))
    except Exception:
        pass
print(','.join(codes))
PY
)

subset() {
  local src="$1" charset="$2"
  local name unicodes
  name=$(basename "$src")

  local dest="$OUT/$name"
  local tmp="$dest.tmp"

  # Symbol faces are copied whole. They are addressed through the Microsoft
  # (3,0) cmap with the 0xF000 private-use bias, and subsetting them by
  # codepoint produced an empty cmap - every glyph unreachable - because a
  # (3,0) table is not indexed by Unicode in the first place. All four
  # together are 46 KB against 4.2 MB of Liberation, so the whole saving here
  # is a rounding error and the risk is a face that silently stops resolving.
  if [ "$charset" = "symbol" ]; then
    if [ "$CHECK" = "1" ]; then
      if ! cmp -s "$src" "$dest"; then
        echo "MISMATCH $dest is not a verbatim copy of $src" >&2
        exit 1
      fi
      printf '  ok   %-34s %8s bytes (verbatim)\n' "$name" \
        "$(wc -c <"$dest" | tr -d ' ')"
    else
      cp "$src" "$dest"
      printf '  %-34s %8s bytes (verbatim, symbol cmap)\n' "$name" \
        "$(wc -c <"$dest" | tr -d ' ')"
    fi
    return
  fi
  unicodes="$ANSI_UNICODES"

  python3 -m fontTools.subset "$src" \
    --unicodes="$unicodes" \
    --no-hinting \
    --notdef-outline \
    --layout-features='' \
    --drop-tables+=EBDT,EBLC,BDF,VDMX,FFTM,GDEF,GPOS,GSUB \
    --name-IDs='*' \
    --recalc-bounds \
    --output-file="$tmp"

  # Subsetting recomputes the font-wide metric summaries over the glyphs that
  # survived, so dropping the widest glyph in the font moves advanceWidthMax
  # and with it tmMaxCharWidth. Windows reported the full font's value, and an
  # app that sizes a column from tmMaxCharWidth would lay out differently
  # against the deployed build than against the vendored one. So hhea and OS/2
  # are restored from the source - every field except numberOfHMetrics, which
  # has to keep describing the subset's own hmtx.
  python3 tools/restore-font-metrics.py "$src" "$tmp"

  if [ "$CHECK" = "1" ]; then
    if ! cmp -s "$tmp" "$dest"; then
      echo "MISMATCH $dest is not what the generator produces" >&2
      rm -f "$tmp"
      exit 1
    fi
    rm -f "$tmp"
    printf '  ok   %-34s %8s bytes\n' "$name" "$(wc -c <"$dest" | tr -d ' ')"
  else
    mv "$tmp" "$dest"
    printf '  %-34s %8s bytes (from %s)\n' "$name" \
      "$(wc -c <"$dest" | tr -d ' ')" "$(wc -c <"$src" | tr -d ' ')"
  fi
}

# Kept in step with fonts/substitutions.json; test/test-font-subsets.js fails
# if the manifest names a file with no subset here. Small Fonts is absent on
# purpose: it has no win98Files entry because Win98 shipped it as SMALLE.FON,
# so nothing can ever open a scalable copy of it.
for f in fonts/liberation/Liberation*.ttf; do subset "$f" ansi; done
subset fonts/wine/tahoma.ttf       ansi
subset fonts/wine/tahomabd.ttf     ansi
subset fonts/wine/marlett.ttf      symbol
subset fonts/wine/symbol.ttf       symbol
subset fonts/wine/wingding.ttf     symbol
subset fonts/wine/webdings.ttf     symbol

full=$(cat fonts/liberation/Liberation*.ttf fonts/wine/tahoma.ttf \
  fonts/wine/tahomabd.ttf fonts/wine/marlett.ttf \
  fonts/wine/symbol.ttf fonts/wine/wingding.ttf fonts/wine/webdings.ttf \
  | wc -c | tr -d ' ')
sub=$(cat "$OUT"/*.ttf | wc -c | tr -d ' ')
echo "total: $sub bytes deployed, from $full bytes vendored"
