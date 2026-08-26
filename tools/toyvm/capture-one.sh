#!/bin/sh
# One program of a shot sweep, bounded, for xargs.
#
#   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --list > /tmp/list
#   xargs -P 6 -L 1 tools/toyvm/capture-one.sh < /tmp/list
#   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots \
#     --merge=/tmp/shots/rows --json=/tmp/shots.json
#
# The three arguments are the three fields --list prints: the program, the tile
# it owns, and the row file it writes. A program whose row file already exists
# is skipped, so re-running the same xargs line captures exactly the programs
# that are missing -- delete a row file to force that one to be re-taken.
#
# The timeout is per PROGRAM and lives here rather than in the sweep, which is
# the point of driving it this way: one wedged program costs one row instead of
# the tail of a 199-program run. 900 seconds because a program can cost up to
# five sequential child runs (the run, the auto-key retry, the re-take, and the
# named-switch pair) and each child is capped at 180.
#
# SIGKILL, not the default SIGTERM: a guest inside one long wasm slice does not
# give the node event loop a turn, so a TERM is queued and never delivered.
set -u
: "${SECS:=900}"
: "${DISPATCHES:=30m}"
: "${EXTRA:=--auto-key}"
exec timeout -s KILL "$SECS" node "$(dirname "$0")/shot-sweep.js" \
  --capture="$1" --png="$2" --row="$3" --dispatches="$DISPATCHES" $EXTRA
