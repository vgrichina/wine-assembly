#!/usr/bin/env bash
# One settled-screen PNG per registry app id, for the per-app site pages.
#
# tools/screenshot-all.sh shoots by exe path from tools/corpus-apps.sh; this
# one shoots by lib/apps.js id, so each picture gets exactly the DLLs, data
# files and command line the desktop icon and `run.js --app=` give it, and is
# named after the id the page generator (tools/gen-site-pages.js) looks up.
#
# Usage: bash tools/screenshot-registry.sh [out_dir] [id ...]
#   With no ids, every id in lib/apps.js is shot.
#   SHOT_SECONDS=N   wall-clock budget per app (default 20). A time budget, not
#                    a batch count: a batch is a budget of blocks and 2,500 of
#                    them is a blank frame on a DirectX game that is still
#                    loading (see the false-BLANK note in CLAUDE.md).
#   SHOT_JOBS=N      parallel apps (default 3)
#   SHOT_RESUME=1    skip ids that already have a non-empty PNG in out_dir
#   SHOT_SCREEN=WxH  guest screen (default 640x480, the CLI default)
#
# tools/site-app-shots.json may give an id extra run.js flags (a dlg-cmd that
# dismisses its About box, a slower tick for a level timer, a longer budget
# for a demo that is still loading at 20s). They go before this script's own
# flags, so a --max-seconds there wins.
set -u

cd "$(dirname "$0")/.." || exit 1
OUT="${1:-screenshots/apps}"
shift || true
mkdir -p "$OUT"

SECONDS_PER="${SHOT_SECONDS:-20}"
JOBS="${SHOT_JOBS:-3}"
RESUME="${SHOT_RESUME:-0}"
SCREEN="${SHOT_SCREEN:-640x480}"

list=$(mktemp)
if [ $# -gt 0 ]; then
  printf '%s\n' "$@" > "$list.all"
else
  node -p 'Object.keys(require("./lib/apps.js").APPS).join("\n")' > "$list.all"
fi
while read -r id; do
  [ -n "$id" ] || continue
  [ "$RESUME" = "1" ] && [ -s "$OUT/$id.png" ] && continue
  echo "$id" >> "$list"
done < "$list.all"
rm -f "$list.all"
[ -s "$list" ] || { echo "nothing to shoot"; rm -f "$list"; exit 0; }
echo "shooting $(wc -l < "$list" | tr -d ' ') app(s) into $OUT (seconds=$SECONDS_PER, jobs=$JOBS, screen=$SCREEN)"

SHOTS_JSON="tools/site-app-shots.json"
export OUT SECONDS_PER SCREEN SHOTS_JSON
shoot_one() {
  id="$1"
  png="$OUT/$id.png"
  log="$OUT/$id.log"
  extra=""
  [ -f "$SHOTS_JSON" ] && extra=$(jq -r --arg id "$id" '.[$id] // ""' "$SHOTS_JSON" 2>/dev/null)
  # $extra is deliberately unquoted: it is a list of flags.
  node test/run.js --app="$id" $extra --no-close --screen="$SCREEN" \
    --max-seconds="$SECONDS_PER" --max-batches=100000000 \
    --png="$png" --quiet-api --quiet-blocks > "$log" 2>&1
  st=$?
  if [ -s "$png" ]; then
    echo "  ok    $id  (run status=$st)"
  else
    echo "  NOPNG $id  (run status=$st): $(grep -m1 -i 'error\|not found\|crash\|unimplemented' "$log" | cut -c1-120)"
  fi
}
export -f shoot_one 2>/dev/null || true

xargs -P "$JOBS" -I{} bash -c 'shoot_one "$@"' _ {} < "$list"
rm -f "$list"

echo
echo "screenshots: $(ls -1 "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ') PNGs in $OUT"
