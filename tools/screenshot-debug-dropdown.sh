#!/usr/bin/env bash
# Render every app listed in index.html's ?debug dropdown through the CLI.
# Unlike the older corpus sweep, this uses --app=<id>, so each run mounts the
# exact files, DLLs, command line, registry, and INI state used by the launcher.
#
# Usage: bash tools/screenshot-debug-dropdown.sh [out_dir] [app_id ...]
#   SHOT_BATCHES=N     batches per app (default 500)
#   SHOT_BATCH_SIZE=N  x86 steps per batch (default 20000)
#   SHOT_REPAINT=N     composite every N batches (default 100; PNG always repaints)
#   SHOT_JOBS=N        parallel processes (default 3)
#   SHOT_TIMEOUT=N     wall-clock seconds allowed per app (default 120)
#   SHOT_RESUME=1      skip IDs that already have a non-empty PNG
#   SHOT_NO_BUILD=1    use the current build/wine-assembly.wasm

set -u

cd "$(dirname "$0")/.." || exit 1

OUT="${1:-test/output/debug-dropdown-cli}"
if [ "$#" -gt 0 ]; then shift; fi
BATCHES="${SHOT_BATCHES:-500}"
BATCH_SIZE="${SHOT_BATCH_SIZE:-20000}"
REPAINT_EVERY="${SHOT_REPAINT:-100}"
JOBS="${SHOT_JOBS:-3}"
TIMEOUT_SECS="${SHOT_TIMEOUT:-120}"
RESUME="${SHOT_RESUME:-0}"
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"

mkdir -p "$OUT"

if [ "${SHOT_NO_BUILD:-0}" != "1" ]; then
  bash tools/build.sh || exit 1
fi

list=$(mktemp)
if [ "$#" -gt 0 ]; then
  for id in "$@"; do echo "$id" >> "$list"; done
else
  node - <<'NODE' > "$list"
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const select = html.match(/<select id="app-select">([\s\S]*?)<\/select>/);
if (!select) throw new Error('index.html has no #app-select');
for (const match of select[1].matchAll(/<option value="([^"]+)"/g)) {
  console.log(match[1]);
}
NODE
fi

if [ "$RESUME" = "1" ]; then
  pending=$(mktemp)
  while IFS= read -r id; do
    [ -s "$OUT/$id.png" ] || echo "$id" >> "$pending"
  done < "$list"
  mv "$pending" "$list"
fi

count=$(wc -l < "$list" | tr -d ' ')
echo "shooting $count app(s) into $OUT (batches=$BATCHES, batch-size=$BATCH_SIZE, repaint=$REPAINT_EVERY, jobs=$JOBS, timeout=${TIMEOUT_SECS}s)"

export OUT BATCHES BATCH_SIZE REPAINT_EVERY TIMEOUT_SECS TIMEOUT_BIN
shoot_one() {
  id="$1"
  png="$OUT/$id.png"
  log="$OUT/$id.log"
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$TIMEOUT_SECS" node test/run.js --app="$id" --no-build --no-close \
      --batch-size="$BATCH_SIZE" --max-batches="$BATCHES" --repaint-every="$REPAINT_EVERY" --png="$png" \
      --quiet-api --quiet-blocks > "$log" 2>&1
  else
    node test/run.js --app="$id" --no-build --no-close \
      --batch-size="$BATCH_SIZE" --max-batches="$BATCHES" --repaint-every="$REPAINT_EVERY" --png="$png" \
      --quiet-api --quiet-blocks > "$log" 2>&1
  fi
  status=$?
  if [ -s "$png" ]; then
    size=$(node -e 'const p=require("pngjs").PNG.sync.read(require("fs").readFileSync(process.argv[1]));console.log(p.width+"x"+p.height)' "$png" 2>/dev/null)
    echo "  PNG   $id  ${size:-?}  status=$status"
  else
    echo "  FAIL  $id  no PNG  status=$status"
  fi
  return 0
}
export -f shoot_one 2>/dev/null || true

xargs -P "$JOBS" -I{} bash -c 'shoot_one "$@"' _ {} < "$list"
rm -f "$list"

pngs=$(find "$OUT" -maxdepth 1 -name '*.png' -type f | wc -l | tr -d ' ')
logs=$(find "$OUT" -maxdepth 1 -name '*.log' -type f | wc -l | tr -d ' ')
echo "screenshots: $pngs PNG(s), $logs log(s) in $OUT"
