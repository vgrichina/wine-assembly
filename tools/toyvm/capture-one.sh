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
# nine sequential child runs (the run, the auto-key retry, the re-take, the
# named-switch pair, the no-sound-card pair and the GUS-environment pair).
#
# The child cap is DERIVED from SECS rather than set beside it. A program can
# cost nine sequential child runs, so two independent numbers have to multiply
# out to less than the wall cap or the outer kill lands in the middle of the
# last child and the row is never written -- which is not a slow program, it is
# a program with no result at all. At the old pair of defaults (900 outer, 180
# per child) they multiplied out to exactly 900, and TRIPLEX!.COM, DENTROCF.EXE
# and READTHIS.COM photographed as nothing for that reason and no other.
# Tenths, so the nine runs fit with one in hand for startup and PNG writes.
# The count moves with the retry chain: it went to nine when the GUS rung was
# added, and leaving the divisor behind is not a slow sweep, it is a sweep whose
# last retry is killed mid-run and whose row is never written.
#
# SIGKILL, not the default SIGTERM: a guest inside one long wasm slice does not
# give the node event loop a turn, so a TERM is queued and never delivered.
set -u
# 1500, and the number that is actually being held constant is CHILD=150s. The
# child cap is a FRACTION of this, so every time the retry chain grows a pair
# the divisor grows and this has to grow with it. It has now cost the same
# program twice: at 900/eighths the budget silently fell to 112s, and at
# 1200/tenths to 120s, and both times CONDENZ.EXE -- still filling its screen at
# 277M dispatches -- photographed as 0 pixels where 150s gets it 57965. The
# programs that notice a shorter child are the ones with the most to draw. A
# retry that costs the run its slowest programs is not a better sweep.
: "${SECS:=1500}"
# 300M, not 30M. A dispatch budget is a budget of GUEST WORK, and at 30M five
# programs in this corpus had simply not got to their first frame yet -- they
# were reported blank while working perfectly. BRIAN.EXE draws its picture at
# 140M dispatches, DEFECT!.COM and CEN!FB.EXE fill the screen, DIZZY_FI.EXE
# reaches a third of one. Nothing is spent on a program that finishes early;
# the wall bound below is what actually caps the sweep.
: "${DISPATCHES:=300m}"
: "${EXTRA:=--auto-key}"
CHILD=$((SECS / 10))
exec timeout -s KILL "$SECS" node "$(dirname "$0")/shot-sweep.js" \
  --capture="$1" --png="$2" --row="$3" --dispatches="$DISPATCHES" \
  --timeout="$CHILD" $EXTRA
