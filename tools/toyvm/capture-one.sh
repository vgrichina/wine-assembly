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
# seven sequential child runs (the run, the auto-key retry, the re-take, the
# named-switch pair, and the no-sound-card pair).
#
# The child cap is DERIVED from SECS rather than set beside it. A program can
# cost seven sequential child runs, so two independent numbers have to multiply
# out to less than the wall cap or the outer kill lands in the middle of the
# last child and the row is never written -- which is not a slow program, it is
# a program with no result at all. At the old pair of defaults (900 outer, 180
# per child) they multiplied out to exactly 900, and TRIPLEX!.COM, DENTROCF.EXE
# and READTHIS.COM photographed as nothing for that reason and no other.
# Eighths, so the seven runs fit with one in hand for startup and PNG writes.
#
# SIGKILL, not the default SIGTERM: a guest inside one long wasm slice does not
# give the node event loop a turn, so a TERM is queued and never delivered.
set -u
# 1200, not 900, because the retry chain grew a pair and the child cap is a
# FRACTION of this. Leaving it at 900 while the divisor went from sixths to
# eighths quietly cut every child's wall budget from 150s to 112s, and the
# programs that notice are the ones with the most to draw: CONDENZ.EXE is still
# filling its screen at 277M dispatches and photographed as 0 pixels, having
# managed 57965 with the longer bound. A retry that costs the run its slowest
# programs is not a better sweep.
: "${SECS:=1200}"
# 300M, not 30M. A dispatch budget is a budget of GUEST WORK, and at 30M five
# programs in this corpus had simply not got to their first frame yet -- they
# were reported blank while working perfectly. BRIAN.EXE draws its picture at
# 140M dispatches, DEFECT!.COM and CEN!FB.EXE fill the screen, DIZZY_FI.EXE
# reaches a third of one. Nothing is spent on a program that finishes early;
# the wall bound below is what actually caps the sweep.
: "${DISPATCHES:=300m}"
: "${EXTRA:=--auto-key}"
CHILD=$((SECS / 8))
exec timeout -s KILL "$SECS" node "$(dirname "$0")/shot-sweep.js" \
  --capture="$1" --png="$2" --row="$3" --dispatches="$DISPATCHES" \
  --timeout="$CHILD" $EXTRA
