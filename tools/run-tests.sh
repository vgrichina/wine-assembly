#!/usr/bin/env bash
# Run an explicit list of test files, one log each, and print exit codes.
#
#   tools/run-tests.sh LISTFILE [-jN] [--timeout=SEC] [--out=DIR]
#
# LISTFILE holds one repo-relative test path per line. run-all.sh can only run
# its three hardcoded arrays, so this is what you use to sweep a set that is not
# (yet) registered there -- triaging unregistered tests, re-verifying a batch
# before adding it, bisecting a cluster.
#
# Output: DIR/<name>.log per test plus DIR/results.tsv of "<exit> <path>".
# A test killed by the timeout reports exit 124 so a slow box is never confused
# with a real failure -- on this machine that distinction is the whole game.

set -u
cd "$(dirname "$0")/.."

LIST=""
JOBS="${JOBS:-4}"
TIMEOUT="${TEST_TIMEOUT:-180}"
OUT="test/output/run-tests"

for a in "$@"; do
  case "$a" in
    -j*)         JOBS="${a#-j}" ;;
    --jobs=*)    JOBS="${a#--jobs=}" ;;
    --timeout=*) TIMEOUT="${a#--timeout=}" ;;
    --out=*)     OUT="${a#--out=}" ;;
    -h|--help)
      echo "usage: tools/run-tests.sh LISTFILE [-jN] [--timeout=SEC] [--out=DIR]"
      exit 0 ;;
    -*)          echo "unknown option: $a" >&2; exit 2 ;;
    *)           LIST="$a" ;;
  esac
done

if [ -z "$LIST" ] || [ ! -f "$LIST" ]; then
  echo "usage: tools/run-tests.sh LISTFILE [-jN] [--timeout=SEC] [--out=DIR]" >&2
  exit 2
fi

mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"

# macOS ships bash 3.2, so there is no `wait -n`; poll the slot pids instead.
pids=()
run_one() {
  local f="$1" name
  name="$(basename "$f" .js)"
  (
    # /usr/bin/time gives user+sys CPU, which is the only way to tell "this app
    # really is slow" from "this box is loaded and the child got starved".
    NODE_OPTIONS="--max-old-space-size=${TEST_HEAP_MB:-2048}" \
      /usr/bin/time -p timeout "$TIMEOUT" node "$f" > "$OUT/$name.log" 2>"$OUT/$name.time"
    rc=$?
    cpu=$(awk '/^user|^sys/ { t += $2 } END { printf "%.1f", t }' "$OUT/$name.time" 2>/dev/null)
    real=$(awk '/^real/ { printf "%.1f", $2 }' "$OUT/$name.time" 2>/dev/null)
    cat "$OUT/$name.time" >> "$OUT/$name.log"
    rm -f "$OUT/$name.time"
    printf '%s\t%s\t%s\t%s\n' "$rc" "$f" "${cpu:-?}" "${real:-?}" >> "$RESULTS"
  ) &
  pids+=($!)
}

wait_for_slot() {
  while [ "${#pids[@]}" -ge "$JOBS" ]; do
    local alive=()
    for p in "${pids[@]}"; do
      kill -0 "$p" 2>/dev/null && alive+=("$p")
    done
    pids=("${alive[@]:-}")
    [ -z "${pids[0]:-}" ] && pids=()
    [ "${#pids[@]}" -ge "$JOBS" ] && sleep 0.5
  done
}

total=0
while read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || { printf '%s\t%s\n' "127" "$f" >> "$RESULTS"; continue; }
  wait_for_slot
  run_one "$f"
  total=$((total + 1))
done < "$LIST"
wait

sort -k2 "$RESULTS" -o "$RESULTS"
pass=$(awk -F'\t' '$1 == 0' "$RESULTS" | wc -l | tr -d ' ')
tmo=$(awk -F'\t' '$1 == 124' "$RESULTS" | wc -l | tr -d ' ')
fail=$(awk -F'\t' '$1 != 0 && $1 != 124' "$RESULTS" | wc -l | tr -d ' ')
echo
echo "ran $total: $pass pass, $fail fail, $tmo timeout (${TIMEOUT}s)  ->  $OUT"
awk -F'\t' '$1 != 0 { printf "  exit %-4s %-52s cpu %ss  wall %ss\n", $1, $2, $3, $4 }' "$RESULTS"
[ "$fail" -eq 0 ] && [ "$tmo" -eq 0 ]
