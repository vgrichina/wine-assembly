#!/usr/bin/env bash
# Launch every corpus app and save one PNG of its settled screen.
#
# The menu sweep answers "did each command do something"; it never looks at a
# pixel, so an app whose window comes up blank, half-drawn, or as an error box
# still reads as clean. This is the other half: one picture per app, all from
# one build, so a person (or a later run) can see what actually rendered.
#
# Usage: bash tools/screenshot-all.sh [out_dir]
#   SHOT_BATCHES=N   how long to let each app settle (default 2500)
#   SHOT_JOBS=N      parallel apps (default 3)
#   SHOT_RESUME=1    skip apps that already have a non-empty PNG in out_dir
set -u

cd "$(dirname "$0")/.." || exit 1
OUT="${1:-test/output/screenshots}"
mkdir -p "$OUT"

. tools/corpus-apps.sh

BATCHES="${SHOT_BATCHES:-2500}"
JOBS="${SHOT_JOBS:-3}"
RESUME="${SHOT_RESUME:-0}"

list=$(mktemp)
for exe in "${APPS[@]}"; do
  [ -f "$exe" ] || continue
  # Two apps can share a basename (mspaint ships in three places); keep the
  # parent directory in the name so neither picture overwrites the other.
  png="$OUT/$(basename "$(dirname "$exe")")-$(basename "$exe" .exe).png"
  [ "$RESUME" = "1" ] && [ -s "$png" ] && continue
  echo "$exe" >> "$list"
done
echo "shooting $(wc -l < "$list" | tr -d ' ') app(s) into $OUT (batches=$BATCHES, jobs=$JOBS)"

export OUT BATCHES
shoot_one() {
  exe="$1"
  base="$(basename "$(dirname "$exe")")-$(basename "$exe" .exe)"
  png="$OUT/$base.png"
  log="$OUT/$base.log"
  node test/run.js --exe="$exe" --no-close --batch-size=100 \
    --max-batches="$BATCHES" --png="$png" --quiet-api --quiet-blocks \
    > "$log" 2>&1
  st=$?
  if [ -s "$png" ]; then
    size=$(node -e 'const p=require("pngjs").PNG.sync.read(require("fs").readFileSync(process.argv[1]));console.log(p.width+"x"+p.height)' "$png" 2>/dev/null)
    echo "  ok    $base  ${size:-?}  (run status=$st)"
  else
    echo "  NOPNG $base  (run status=$st)"
  fi
}
export -f shoot_one 2>/dev/null || true

xargs -P "$JOBS" -I{} bash -c 'shoot_one "$@"' _ {} < "$list"
rm -f "$list"

echo
echo "screenshots: $(ls -1 "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ') PNGs in $OUT"
