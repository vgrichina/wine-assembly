#!/bin/bash
# Build and run notepad.exe with debug output
# Usage: ./tools/run.sh [options]
#   -b         skip build
#   -n NUM     max batches (default: 200)
#   -s NUM     instructions per batch (default: 1000)
#   -v         verbose: print regs every batch
#   -o FILE    save output to file (also prints to stdout)
set -e
cd "$(dirname "$0")/.."

SKIP_BUILD=0
MAX_BATCHES=200
BATCH_SIZE=1000
VERBOSE=0
OUTFILE=""

while getopts "bn:s:vo:" opt; do
  case $opt in
    b) SKIP_BUILD=1 ;;
    n) MAX_BATCHES=$OPTARG ;;
    s) BATCH_SIZE=$OPTARG ;;
    v) VERBOSE=1 ;;
    o) OUTFILE=$OPTARG ;;
    *) echo "Unknown option: -$opt" >&2; exit 1 ;;
  esac
done

if [ "$SKIP_BUILD" -eq 0 ]; then
  ./tools/build.sh 2>&1
  echo "---"
fi

CMD="node test/run-notepad.js --max-batches=$MAX_BATCHES --batch-size=$BATCH_SIZE"
[ "$VERBOSE" -eq 1 ] && CMD="$CMD --verbose"

if [ -n "$OUTFILE" ]; then
  $CMD 2>&1 | tee "$OUTFILE"
else
  $CMD 2>&1
fi
