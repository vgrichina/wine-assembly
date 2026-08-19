#!/bin/bash
# Build and run a Win32 PE executable
# Usage: ./tools/run.sh [options] [exe-path]
#   -b         skip build
#   -n NUM     max batches (default: 200)
#   -s NUM     instructions per batch (default: 1000)
#   -v         verbose: print regs every batch
#   -t         trace: log every block's EIP
#   -a         trace-api: log API calls with args + return values
#   -e         trace-seh: log SEH chain operations
#   -d         dump-seh: detailed SEH dump at end
#   -B ADDR    breakpoint at address (hex, comma-separated for multiple)
#   -A NAME    break on API call (comma-separated for multiple)
#   -W ADDR:LEN  watchpoint: break when memory changes
#   -D ADDR:LEN  hexdump memory region at end
#   -o FILE    save output to file (also prints to stdout)
#   -p FILE    render to PNG
set -e
cd "$(dirname "$0")/.."

SKIP_BUILD=0
MAX_BATCHES=200
BATCH_SIZE=1000
VERBOSE=0
TRACE=0
TRACE_API=0
TRACE_SEH=0
DUMP_SEH=0
BREAK=""
BREAK_API=""
WATCH=""
DUMP=""
OUTFILE=""
PNG=""

while getopts "bn:s:vtaedB:A:W:D:o:p:" opt; do
  case $opt in
    b) SKIP_BUILD=1 ;;
    n) MAX_BATCHES=$OPTARG ;;
    s) BATCH_SIZE=$OPTARG ;;
    v) VERBOSE=1 ;;
    t) TRACE=1 ;;
    a) TRACE_API=1 ;;
    e) TRACE_SEH=1 ;;
    d) DUMP_SEH=1 ;;
    B) BREAK=$OPTARG ;;
    A) BREAK_API=$OPTARG ;;
    W) WATCH=$OPTARG ;;
    D) DUMP=$OPTARG ;;
    o) OUTFILE=$OPTARG ;;
    p) PNG=$OPTARG ;;
    *) echo "Unknown option: -$opt" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

EXE="${1:-test/binaries/notepad.exe}"

if [ "$SKIP_BUILD" -eq 0 ]; then
  ./tools/build.sh 2>&1
  echo "---"
fi

CMD="node test/run.js --exe=$EXE --max-batches=$MAX_BATCHES --batch-size=$BATCH_SIZE"
[ "$VERBOSE" -eq 1 ] && CMD="$CMD --verbose"
[ "$TRACE" -eq 1 ] && CMD="$CMD --trace"
[ "$TRACE_API" -eq 1 ] && CMD="$CMD --trace-api"
[ "$TRACE_SEH" -eq 1 ] && CMD="$CMD --trace-seh"
[ "$DUMP_SEH" -eq 1 ] && CMD="$CMD --dump-seh"
[ -n "$BREAK" ] && CMD="$CMD --break=$BREAK"
[ -n "$BREAK_API" ] && CMD="$CMD --break-api=$BREAK_API"
[ -n "$WATCH" ] && CMD="$CMD --watch=$WATCH"
[ -n "$DUMP" ] && CMD="$CMD --dump=$DUMP"
[ -n "$PNG" ] && CMD="$CMD --png=$PNG"

if [ -n "$OUTFILE" ]; then
  $CMD 2>&1 | tee "$OUTFILE"
else
  $CMD 2>&1
fi
